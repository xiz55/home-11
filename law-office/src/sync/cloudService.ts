// خدمة الحساب السحابي والمزامنة — مشتركة بين سطح المكتب (Electron) والآيفون (Capacitor).
// تعتمد على محولات النظام: مخزن أسرار (Keychain/DPAPI)، إعدادات الجهاز، مخزن الملفات، ومعلومات الجهاز.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Db } from '../main/db/db';
import { SyncEngine, SyncRevokedError, type SyncReport } from './engine';
import { RpcTransport, OfflineError } from './transport';
import { BlobSync, type BlobStore } from './blobs';
import { createCloudOffice, joinCloudOffice, localCounts } from './setup';
import { getState, setState } from './local';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}
export interface DeviceInfo {
  name: string;
  platform: 'windows' | 'mac' | 'ios' | 'linux';
  appVersion: string;
}
export interface CloudDeps {
  db: () => Db;
  secrets: SecretStore;
  blobStore: BlobStore;
  device: DeviceInfo;
  /** على سطح المكتب: تنزيل كل المرفقات تلقائيًا (إعداد الجهاز). الآيفون: الملفات المختارة فقط. */
  autoDownload: () => boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  onStatus?: (s: CloudStatus) => void;
  /** فترة المزامنة الدورية بالمللي ثانية (0 = بلا مزامنة دورية، للاختبارات). */
  loopMs?: number;
}

export interface CloudConfig {
  url: string;
  anonKey: string;
}

export type CloudPhase = 'not_configured' | 'signed_out' | 'idle' | 'syncing' | 'uploading' | 'downloading' | 'offline' | 'error' | 'revoked' | 'mfa_required';

export interface CloudStatus {
  phase: CloudPhase;
  email: string | null;
  officeId: string | null;
  officeName: string | null;
  pending: number;
  conflicts: number;
  rejected: number;
  blobs: Record<string, number>;
  localBytes: number;
  lastSyncAt: string | null;
  lastError: string | null;
  online: boolean;
}

const isNetworkError = (e: unknown) => e instanceof OfflineError || /fetch failed|network|Failed to fetch|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(String((e as Error)?.message ?? e));

class SupabaseTransport extends RpcTransport {
  constructor(private sb: SupabaseClient) {
    super();
  }
  async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await this.sb.rpc(name, args);
    } catch (e) {
      throw isNetworkError(e) ? new OfflineError(String((e as Error).message)) : e;
    }
    if (res.error) {
      if (isNetworkError(res.error.message) || res.status === 0) throw new OfflineError(res.error.message);
      throw Object.assign(new Error(res.error.message), { code: res.error.code });
    }
    return res.data as T;
  }
}

export class CloudService {
  private sb: SupabaseClient | null = null;
  private cfg: CloudConfig | null = null;
  engine: SyncEngine | null = null;
  blobs: BlobSync | null = null;
  private status: CloudStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private d: CloudDeps) {
    this.status = { phase: 'not_configured', email: null, officeId: null, officeName: null, pending: 0, conflicts: 0, rejected: 0, blobs: {}, localBytes: 0, lastSyncAt: null, lastError: null, online: true };
  }

  private now = () => (this.d.now ?? (() => new Date()))();

  // ———— الإعداد ————
  async init() {
    const raw = await this.d.secrets.get('cloud.config');
    if (raw) await this.configure(JSON.parse(raw), false);
    else this.emit({ phase: 'not_configured' });
  }

  async configure(cfg: CloudConfig, persist = true) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(cfg.url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(cfg.url)) throw new Error('رابط مشروع Supabase غير صالح (مثال: https://abcd.supabase.co)');
    if (!/^[A-Za-z0-9._-]{20,}$/.test(cfg.anonKey)) throw new Error('المفتاح العام (anon/publishable) غير صالح');
    this.cfg = { url: cfg.url.replace(/\/$/, ''), anonKey: cfg.anonKey };
    if (persist) await this.d.secrets.set('cloud.config', JSON.stringify(this.cfg));
    const secrets = this.d.secrets;
    this.sb = createClient(this.cfg.url, this.cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // جلسة الدخول تُحفظ في مخزن أسرار النظام (Keychain / DPAPI) لا في ملف نصي
        storage: { getItem: (k) => secrets.get(`sb.${k}`), setItem: (k, v) => secrets.set(`sb.${k}`, v), removeItem: (k) => secrets.set(`sb.${k}`, null) },
      },
      global: { fetch: this.d.fetch },
    });
    const transport = new SupabaseTransport(this.sb);
    this.engine = new SyncEngine(this.d.db, transport, this.now);
    this.blobs = new BlobSync(this.d.db, { call: (req) => this.callFunction('attachments', req) }, this.d.blobStore, this.d.fetch ?? fetch, this.now);
    const { data } = await this.sb.auth.getSession();
    this.emit({ phase: data.session ? 'idle' : 'signed_out', email: data.session?.user.email ?? null, officeId: getState(this.d.db(), 'office_id'), officeName: getState(this.d.db(), 'office_name') });
  }

  config() {
    return this.cfg ? { url: this.cfg.url, configured: true } : { url: null, configured: false };
  }

  private requireSb(): SupabaseClient {
    if (!this.sb) throw new Error('لم تُضبط بيانات المشروع السحابي بعد');
    return this.sb;
  }

  private async callFunction(name: string, body: Record<string, unknown>) {
    const sb = this.requireSb();
    const { data: s } = await sb.auth.getSession();
    if (!s.session) throw new Error('signed out');
    let res: Response;
    try {
      res = await (this.d.fetch ?? fetch)(`${this.cfg!.url}/functions/v1/${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.session.access_token}`, apikey: this.cfg!.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new OfflineError(String((e as Error).message));
    }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  // ———— الدخول والتحقق بخطوتين ————
  async signIn(email: string, password: string): Promise<{ mfaRequired: boolean; localUserId: string | null; offline: boolean }> {
    const sb = this.requireSb();
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message.includes('Invalid login') ? 'البريد أو كلمة المرور غير صحيحة' : error.message);
      await this.rememberOfflineCredential(email, password, data.user.id);
      const aal = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal.data && aal.data.nextLevel === 'aal2' && aal.data.currentLevel !== 'aal2') {
        this.emit({ phase: 'mfa_required', email });
        return { mfaRequired: true, localUserId: null, offline: false };
      }
      this.emit({ email });
      return { mfaRequired: false, localUserId: await this.afterSignIn(), offline: false };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // دون اتصال: يُسمح بالدخول على هذا الجهاز فقط إن سبق الدخول عليه، بكلمة المرور نفسها، مع جلسة محفوظة
      const local = await this.offlineSignIn(email, password);
      return { mfaRequired: false, localUserId: local, offline: true };
    }
  }

  async mfaVerify(code: string): Promise<{ localUserId: string | null }> {
    const sb = this.requireSb();
    const f = await sb.auth.mfa.listFactors();
    const totp = f.data?.totp?.find((x) => x.status === 'verified');
    if (!totp) throw new Error('لا يوجد تحقق بخطوتين مفعّل لهذا الحساب');
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: code.trim() });
    if (error) throw new Error('رمز التحقق غير صحيح أو منتهي');
    return { localUserId: await this.afterSignIn() };
  }

  async mfaEnroll(): Promise<{ factorId: string; qr: string; secret: string; uri: string }> {
    const sb = this.requireSb();
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `law-office-${Date.now()}` });
    if (error) throw new Error(error.message);
    return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  }

  async mfaEnrollVerify(factorId: string, code: string) {
    const sb = this.requireSb();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (error) throw new Error('رمز التحقق غير صحيح');
    return { ok: true };
  }

  async mfaFactors() {
    const sb = this.requireSb();
    const f = await sb.auth.mfa.listFactors();
    return (f.data?.totp ?? []).map((x) => ({ id: x.id, status: x.status, createdAt: x.created_at }));
  }

  /** بعد الدخول: تحديد المكتب والمستخدم المحلي، وتسجيل الجهاز، ومزامنة أولى إن كان الجهاز منضمًا. */
  private async afterSignIn(): Promise<string | null> {
    const sb = this.requireSb();
    const offices = await this.myOffices();
    const db = this.d.db();
    const officeId = getState(db, 'office_id');
    // جهاز لم ينضم لمكتب بعد: لا جلسة محلية؛ يختار المستخدم المكتب (انضمام) أو ينشئه صاحب المكتب من الإعدادات
    if (!officeId) return null;
    const mine = offices.find((o) => o.office_id === officeId);
    if (!mine) throw new Error('هذا الحساب ليس عضوًا في مكتب هذا الجهاز');
    setState(db, 'office_name', mine.name);
    setState(db, 'local_user_id', mine.local_user_id);
    const { data: u } = await sb.auth.getUser();
    if (u.user?.email) await this.d.secrets.set(`offline.local.${u.user.email.toLowerCase()}`, mine.local_user_id);
    if (officeId) {
      await this.touchDevice();
      await this.syncNow().catch(() => undefined);
    }
    this.emit({ officeId: getState(db, 'office_id'), officeName: mine.name });
    return mine.local_user_id;
  }

  async myOffices(): Promise<{ office_id: string; name: string; role: string; local_user_id: string; require_mfa: boolean }[]> {
    const { data, error } = await this.requireSb().rpc('app_my_offices');
    if (error) throw new Error(error.message);
    return (data ?? []) as never;
  }

  async signOut() {
    await this.sb?.auth.signOut().catch(() => undefined);
    this.stopLoop();
    this.emit({ phase: 'signed_out', email: null });
  }

  private async rememberOfflineCredential(email: string, password: string, authUserId: string) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    await this.d.secrets.set(`offline.cred.${email.toLowerCase()}`, JSON.stringify({ salt: salt.toString('base64'), hash: hash.toString('base64'), uid: authUserId }));
  }

  private async offlineSignIn(email: string, password: string): Promise<string> {
    const raw = await this.d.secrets.get(`offline.cred.${email.toLowerCase()}`);
    const local = await this.d.secrets.get(`offline.local.${email.toLowerCase()}`);
    if (!raw || !local) throw new Error('لا يوجد اتصال بالإنترنت، ولم يسبق الدخول بهذا الحساب على هذا الجهاز.');
    const c = JSON.parse(raw) as { salt: string; hash: string };
    const h = scryptSync(password, Buffer.from(c.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    if (!timingSafeEqual(h, Buffer.from(c.hash, 'base64'))) throw new Error('البريد أو كلمة المرور غير صحيحة');
    this.emit({ phase: 'offline', email, online: false });
    return local;
  }

  // ———— المكتب ————
  async createOffice(input: { officeName: string; localOwnerId: string; displayName: string }) {
    const sb = this.requireSb();
    const t = new SupabaseTransport(sb);
    const db = this.d.db();
    const counts = localCounts(db);
    const officeId = await createCloudOffice(db, t, input);
    setState(db, 'office_name', input.officeName);
    setState(db, 'local_user_id', input.localOwnerId);
    setState(db, 'migration_counts', JSON.stringify(counts));
    const { data: u } = await sb.auth.getUser();
    if (u.user?.email) await this.d.secrets.set(`offline.local.${u.user.email.toLowerCase()}`, input.localOwnerId);
    await this.touchDevice();
    this.emit({ officeId, officeName: input.officeName });
    return { officeId, counts };
  }

  async joinOffice(officeId: string) {
    const db = this.d.db();
    const mine = (await this.myOffices()).find((o) => o.office_id === officeId);
    if (!mine) throw new Error('هذا الحساب ليس عضوًا في هذا المكتب');
    joinCloudOffice(db, officeId);
    setState(db, 'office_name', mine.name);
    setState(db, 'local_user_id', mine.local_user_id);
    const { data: u } = await this.requireSb().auth.getUser();
    if (u.user?.email) await this.d.secrets.set(`offline.local.${u.user.email.toLowerCase()}`, mine.local_user_id);
    this.emit({ officeId, officeName: mine.name });
    await this.touchDevice();
    return this.syncNow();
  }

  // ———— المزامنة ————
  async syncNow(): Promise<SyncReport | null> {
    if (!this.engine || !this.sb) return null;
    const db = this.d.db();
    if (!getState(db, 'office_id')) return null;
    try {
      this.emit({ phase: 'syncing', online: true, lastError: null });
      const r = await this.engine.sync();
      this.emit({ phase: 'uploading' });
      await this.blobs!.uploadPending();
      if (this.d.autoDownload()) {
        this.emit({ phase: 'downloading' });
        await this.blobs!.downloadAll(false);
      } else await this.blobs!.downloadAll(true);
      await this.touchDevice().catch(() => undefined);
      this.emit({ phase: 'idle', lastSyncAt: this.now().toISOString() });
      // بعد أول مزامنة ناجحة (دخول/انضمام/إنشاء المكتب) تبدأ المزامنة الدورية دون انتظار إعادة التشغيل
      const ms = this.d.loopMs ?? 60_000;
      if (!this.timer && ms > 0) this.timer = setInterval(() => void this.syncNow().catch(() => undefined), ms);
      return r;
    } catch (e) {
      if (e instanceof SyncRevokedError) {
        this.emit({ phase: 'revoked', lastError: 'أُلغي وصول هذا الجهاز أو الحساب، أو يلزم التحقق بخطوتين.' });
        this.stopLoop();
      } else if (isNetworkError(e)) this.emit({ phase: 'offline', online: false });
      else this.emit({ phase: 'error', lastError: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }

  /** بعد كل تعديل محلي: مزامنة مؤجلة قليلًا (تُجمع التعديلات المتتالية). */
  localChanged() {
    if (!getState(this.d.db(), 'office_id')) return;
    this.refresh();
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => void this.syncNow().catch(() => undefined), 4000);
  }

  startLoop(intervalMs = this.d.loopMs ?? 60_000) {
    this.stopLoop();
    if (intervalMs > 0) this.timer = setInterval(() => void this.syncNow().catch(() => undefined), intervalMs);
    void this.syncNow().catch(() => undefined);
  }
  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ———— الأجهزة ————
  async deviceId(): Promise<string> {
    let id = await this.d.secrets.get('device.id');
    if (!id) {
      id = randomUUID();
      await this.d.secrets.set('device.id', id);
    }
    return id;
  }

  async touchDevice() {
    const db = this.d.db();
    const officeId = getState(db, 'office_id');
    if (!officeId || !this.sb) return;
    const { data, error } = await this.sb.rpc('app_touch_device', { p_office: officeId, p_device: await this.deviceId(), p_name: this.d.device.name, p_platform: this.d.device.platform, p_version: this.d.device.appVersion });
    if (error) throw new Error(error.message);
    if (data && (data as { allowed: boolean }).allowed === false) throw new SyncRevokedError();
  }

  async devices() {
    const officeId = getState(this.d.db(), 'office_id');
    const { data, error } = await this.requireSb().from('devices').select('id, user_id, device_name, platform, app_version, last_seen, created_at, revoked_at').eq('office_id', officeId).order('last_seen', { ascending: false });
    if (error) throw new Error(error.message);
    const me = await this.deviceId();
    return (data ?? []).map((x) => ({ ...x, current: x.id === me }));
  }

  async revokeDevice(id: string) {
    const { error } = await this.requireSb().rpc('app_revoke_device', { p_device: id });
    if (error) throw new Error(error.message);
    return { ok: true };
  }

  async setRequireMfa(on: boolean) {
    const officeId = getState(this.d.db(), 'office_id');
    const { error } = await this.requireSb().rpc('app_set_require_mfa', { p_office: officeId, p_on: on });
    if (error) throw new Error(error.message.includes('two-step') ? 'فعّل التحقق بخطوتين لحسابك أولًا وسجّل الدخول به' : error.message);
    return { ok: true };
  }

  /** دعوة مستشار: ينشئ حسابه السحابي عبر دالة الخادم (بمفتاح الخدمة هناك) ويربطه بمستخدمه في المكتب. */
  async inviteMember(input: { email: string; localUserId: string; displayName: string; permissions: string[] }) {
    const officeId = getState(this.d.db(), 'office_id');
    const r = await this.callFunction('members', { action: 'invite', office_id: officeId, email: input.email, local_user_id: input.localUserId, display_name: input.displayName, permissions: input.permissions });
    if (r.status !== 200) throw new Error(String(r.body.error ?? 'تعذرت الدعوة'));
    return r.body as { temporaryPassword?: string; existing?: boolean };
  }

  // ———— التعارضات والحالة ————
  conflicts() {
    return this.d
      .db()
      .all<{ id: string; tbl: string; rid: string; fields: string; server_data: string; client_data: string; created_at: string; resolved_at: string | null }>('SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 200')
      .map((c) => ({ id: c.id, tbl: c.tbl, rid: c.rid, fields: JSON.parse(c.fields) as string[], server: JSON.parse(c.server_data), client: JSON.parse(c.client_data), createdAt: c.created_at, resolvedAt: c.resolved_at }));
  }

  /** حل التعارض: إبقاء نسخة الخادم، أو اعتماد نسخة هذا الجهاز (تُكتب كتعديل جديد يُزامن). */
  resolveConflict(id: string, keep: 'server' | 'device', applyLocal: (tbl: string, rid: string, fields: Record<string, unknown>) => void) {
    const db = this.d.db();
    const c = db.get<{ tbl: string; rid: string; fields: string; client_data: string }>('SELECT * FROM sync_conflicts WHERE id = ?', [id]);
    if (!c) throw new Error('not found');
    if (keep === 'device') {
      const client = JSON.parse(c.client_data) as Record<string, unknown>;
      const fields = Object.fromEntries((JSON.parse(c.fields) as string[]).map((f) => [f, client[f]]));
      applyLocal(c.tbl, c.rid, fields);
    }
    db.run('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?', [this.now().toISOString(), keep, id]);
    this.localChanged();
    return { ok: true };
  }

  refresh() {
    try {
      const db = this.d.db();
      const blobs = this.blobs?.summary() ?? { counts: {}, localBytes: 0 };
      this.emit({
        pending: this.engine?.pendingCount() ?? 0,
        conflicts: db.get<{ n: number }>('SELECT count(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL')!.n,
        rejected: db.get<{ n: number }>('SELECT count(*) AS n FROM sync_rejected')!.n,
        blobs: blobs.counts,
        localBytes: blobs.localBytes,
        lastSyncAt: getState(db, 'last_sync_at') ?? this.status.lastSyncAt,
        officeId: getState(db, 'office_id'),
        officeName: getState(db, 'office_name'),
      });
    } catch {
      /* قاعدة مغلقة مؤقتًا */
    }
  }

  getStatus(): CloudStatus {
    this.refresh();
    return { ...this.status };
  }

  private emit(p: Partial<CloudStatus>) {
    this.status = { ...this.status, ...p };
    this.d.onStatus?.(this.status);
  }
}
