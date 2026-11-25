// ربط جهاز صاحب المكتب (الماك أو ويندوز آخر) بـ«خادم المكتب» المحلي، والمزامنة معه بمحرك المزامنة نفسه.
// المفتاح الذي يُصدره جهاز المكتب يُحفظ في مخزن أسرار النظام (Keychain على الماك)، لا في ملف نصي.
import type { Db } from '../main/db/db';
import { SyncEngine, SyncRevokedError, type MemberStatus, type PulledRecord, type PushChange, type PushResult, type SyncReport, type SyncTransport } from './engine';
import { OfflineError } from './transport';
import { BlobSync, type BlobStore } from './blobs';
import { applyRecord, applying, getState, installSyncTriggers, setState } from './local';
import { LOCAL_SETTING_KEYS, setCredentialSync } from './tables';
import { clearLocalOfficeData } from './setup';
import type { CloudStatus, DeviceInfo, SecretStore } from './cloudService';

export interface HubClientDeps {
  db: () => Db;
  secrets: SecretStore;
  blobStore: BlobStore;
  device: DeviceInfo;
  autoDownload: () => boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  onStatus?: (s: CloudStatus) => void;
  loopMs?: number;
}

const isNet = (e: unknown) => e instanceof OfflineError || /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|timeout|socket/i.test(String((e as Error)?.message ?? e));

export function normalizeHubUrl(u: string): string {
  const s = u.trim().replace(/\/+$/, '');
  // HTTPS إلزامي خارج الجهاز نفسه (رابط Tailscale يأتي بشهادة صالحة)
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s)) throw new Error('عنوان جهاز المكتب غير صالح. مثال: https://office-pc.tail1234.ts.net');
  return s;
}

class HubTransport implements SyncTransport {
  constructor(
    private base: () => string,
    private token: () => string | null,
    private f: typeof fetch,
  ) {}
  async call<T>(p: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token() ?? ''}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new OfflineError(String((e as Error).message));
    }
    if (res.status === 401) throw new SyncRevokedError();
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error((j as { error?: string }).error ?? `خطأ ${res.status}`);
    return j;
  }
  push(_o: string, changes: PushChange[]) {
    return this.call<PushResult[]>('/api/sync/push', { changes });
  }
  pull(_o: string, since: number, limit: number) {
    return this.call<PulledRecord[]>('/api/sync/pull', { since, limit });
  }
  async status(_o: string): Promise<MemberStatus | null> {
    try {
      return await this.call<MemberStatus>('/api/sync/status', {});
    } catch (e) {
      if (e instanceof SyncRevokedError) return null;
      throw e;
    }
  }
  reserveNumbers(_o: string, name: string, count: number) {
    return this.call<{ from: number; to: number }>('/api/sync/reserve', { name, count });
  }
}

export class HubClient {
  private url: string | null = null;
  private token: string | null = null;
  readonly transport: HubTransport;
  readonly engine: SyncEngine;
  readonly blobs: BlobSync;
  private status: CloudStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private d: HubClientDeps) {
    const f = d.fetch ?? fetch;
    this.transport = new HubTransport(() => this.url ?? '', () => this.token, f);
    this.engine = new SyncEngine(d.db, this.transport, this.now);
    this.blobs = new BlobSync(
      d.db,
      {
        call: async (req) => {
          let res: Response;
          try {
            res = await f(`${this.url}/api/blobs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify(req) });
          } catch (e) {
            throw new OfflineError(String((e as Error).message));
          }
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (typeof body.url === 'string' && body.url.startsWith('/')) body.url = `${this.url}${body.url}`;
          return { status: res.status, body };
        },
      },
      d.blobStore,
      f,
      this.now,
    );
    this.status = { phase: 'not_configured', email: null, officeId: null, officeName: null, pending: 0, conflicts: 0, rejected: 0, blobs: {}, localBytes: 0, lastSyncAt: null, lastError: null, online: true };
  }

  private now = () => (this.d.now ?? (() => new Date()))();

  async init() {
    this.url = await this.d.secrets.get('hub.url');
    this.token = await this.d.secrets.get('hub.token');
    if (this.linked()) {
      setCredentialSync(true);
      this.emit({ phase: 'idle', officeId: getState(this.d.db(), 'office_id'), officeName: getState(this.d.db(), 'office_name') });
    }
  }

  linked(): boolean {
    return !!this.token && !!this.url && getState(this.d.db(), 'mode') === 'hub';
  }

  hubUrl() {
    return this.url;
  }

  private async post<T>(base: string, p: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await (this.d.fetch ?? fetch)(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('تعذر الوصول إلى جهاز المكتب. تأكد أن جهاز المكتب يعمل وأن العنوان صحيح.');
    }
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error((j as { error?: string }).error ?? `خطأ ${res.status}`);
    return j;
  }

  /** الخطوة 1: اسم المستخدم وكلمة المرور على جهاز المكتب ← يُرسل رمز إلى بريد صاحب المكتب. */
  linkStart(url: string, username: string, password: string) {
    const base = normalizeHubUrl(url);
    return this.post<{ challengeId: string; sentTo: string }>(base, '/api/link/start', { username, password, deviceName: this.d.device.name, platform: this.d.device.platform }).then((r) => ({ ...r, url: base }));
  }

  /**
   * الخطوة 2: الرمز ← مفتاح الجهاز، ثم تنزيل نسخة المكتب كاملة واستبدال بيانات هذا الجهاز بها في معاملة واحدة.
   * إن انقطع الاتصال أثناء التنزيل تبقى بيانات هذا الجهاز كما هي.
   */
  async linkVerify(url: string, challengeId: string, code: string): Promise<{ localUserId: string; officeName: string }> {
    const base = normalizeHubUrl(url);
    const r = await this.post<{ token: string; officeId: string; officeName: string; localUserId: string }>(base, '/api/link/verify', { challengeId, code });
    const prevUrl = this.url;
    const prevToken = this.token;
    this.url = base;
    this.token = r.token;
    try {
      const all: PulledRecord[] = [];
      for (let since = 0; ; ) {
        const page = await this.transport.pull(r.officeId, since, 2000);
        all.push(...page);
        if (page.length < 2000) break;
        since = page[page.length - 1].seq;
      }
      const db = this.d.db();
      setCredentialSync(true);
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.tx(() => {
          clearLocalOfficeData(db);
          db.run('DELETE FROM lookups');
          db.run(`DELETE FROM settings WHERE key NOT IN (${[...LOCAL_SETTING_KEYS].map((k) => `'${k}'`).join(',')})`);
          db.run('DELETE FROM sync_meta');
          db.run('DELETE FROM number_blocks');
          db.run('DELETE FROM sync_inflight');
          applying(db, () => {
            for (const rec of all) {
              if (rec.deleted) continue;
              db.run('INSERT INTO sync_meta (tbl, rid, version, base) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, rid) DO UPDATE SET version = excluded.version, base = excluded.base', [rec.tbl, rec.rid, rec.version, JSON.stringify(rec.data)]);
              applyRecord(db, rec.tbl, rec.rid, rec.data, false);
            }
          });
          setState(db, 'office_id', r.officeId);
          setState(db, 'office_name', r.officeName);
          setState(db, 'local_user_id', r.localUserId);
          setState(db, 'mode', 'hub');
          setState(db, 'access_version', '1');
          setState(db, 'role', 'owner');
          setState(db, 'last_seq', String(all.reduce((m, x) => Math.max(m, x.seq), 0)));
          installSyncTriggers(db);
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    } catch (e) {
      this.url = prevUrl;
      this.token = prevToken;
      throw e;
    }
    await this.d.secrets.set('hub.url', base);
    await this.d.secrets.set('hub.token', r.token);
    this.emit({ phase: 'idle', officeId: r.officeId, officeName: r.officeName });
    await this.syncNow().catch(() => undefined);
    return { localUserId: r.localUserId, officeName: r.officeName };
  }

  async syncNow(): Promise<SyncReport | null> {
    if (!this.linked()) return null;
    try {
      this.emit({ phase: 'syncing', online: true, lastError: null });
      const r = await this.engine.sync();
      this.emit({ phase: 'uploading' });
      await this.blobs.uploadPending();
      this.emit({ phase: 'downloading' });
      await this.blobs.downloadAll(!this.d.autoDownload());
      this.emit({ phase: 'idle', lastSyncAt: this.now().toISOString() });
      const ms = this.d.loopMs ?? 60_000;
      if (!this.timer && ms > 0) this.timer = setInterval(() => void this.syncNow().catch(() => undefined), ms);
      return r;
    } catch (e) {
      if (e instanceof SyncRevokedError) {
        this.emit({ phase: 'revoked', lastError: 'أُلغي ربط هذا الجهاز من جهاز المكتب.' });
        this.stopLoop();
      } else if (isNet(e)) this.emit({ phase: 'offline', online: false });
      else this.emit({ phase: 'error', lastError: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }

  localChanged() {
    if (!this.linked()) return;
    this.refresh();
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => void this.syncNow().catch(() => undefined), 3000);
  }

  startLoop(ms = this.d.loopMs ?? 60_000) {
    this.stopLoop();
    if (ms > 0) this.timer = setInterval(() => void this.syncNow().catch(() => undefined), ms);
    void this.syncNow().catch(() => undefined);
  }
  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async devices() {
    return this.transport.call<{ id: string; kind: string; name: string; platform: string; created_at: string; last_seen: string | null; revoked_at: string | null }[]>('/api/sync/devices', {});
  }

  /** فك الربط على هذا الجهاز (تبقى بياناته المحلية). */
  async unlink() {
    this.stopLoop();
    this.token = null;
    await this.d.secrets.set('hub.token', null);
    setState(this.d.db(), 'mode', 'unlinked');
    this.emit({ phase: 'not_configured' });
  }

  refresh() {
    const db = this.d.db();
    this.emit({
      pending: this.engine.pendingCount(),
      conflicts: db.get<{ n: number }>('SELECT count(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL')?.n ?? 0,
      blobs: this.blobs.summary().counts,
      localBytes: this.blobs.summary().localBytes,
    });
  }

  getStatus(): CloudStatus {
    return this.status;
  }

  private emit(p: Partial<CloudStatus>) {
    this.status = { ...this.status, ...p };
    if (p.phase === undefined || p.phase === 'idle') {
      try {
        const db = this.d.db();
        this.status.pending = this.engine.pendingCount();
        this.status.conflicts = db.get<{ n: number }>('SELECT count(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL')?.n ?? 0;
      } catch {
        /* */
      }
    }
    this.d.onStatus?.(this.status);
  }
}
