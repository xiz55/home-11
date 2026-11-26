// اختبار التكامل الكامل لخدمة الحساب السحابي عبر مكدس Supabase حقيقي محلي:
// GoTrue (الدخول والتحقق بخطوتين) + PostgREST (الواجهة) + PostgreSQL بترحيلات المشروع نفسها — بيانات خيالية فقط.
// يُشغَّل حين تتوفر الخدمات محليًا (انظر docs/CLOUD_TESTING.md)، ويُتخطى خلاف ذلك ويُذكر ذلك صراحة.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { CloudService, type SecretStore } from '../../src/sync/cloudService';
import { localCounts } from '../../src/sync/setup';
import { buildOfficeReport } from '../../src/main/services/officeReport';
import { call, makeCore, seedCompany, setupOwner, tmpDir, Clock, OWNER } from '../unit/helpers';

const AUTH = process.env.SB_AUTH_URL ?? 'http://127.0.0.1:9999';
const REST = process.env.SB_REST_URL ?? 'http://127.0.0.1:54401';
const JWT_SECRET = process.env.SB_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

async function up(u: string) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}
const available = (await up(`${AUTH}/health`)) && (await up(`${REST}/`));
if (!available && process.env.LAWSYNC_REQUIRE_PG) throw new Error('local Supabase auth/rest stack unavailable');
const d = available ? describe : describe.skip;

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function jwt(payload: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'supabase-test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  return `${h}.${p}.${b64u(createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest())}`;
}
const ANON = jwt({ role: 'anon' });
const SERVICE = jwt({ role: 'service_role' }); // يبقى داخل الاختبار فقط — لا يدخل التطبيق

function totp(secretB32: string, t = Date.now()) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((x) => parseInt(x, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** بوابة محلية تحاكي عنوان مشروع Supabase الواحد: ‎/auth/v1 و‎/rest/v1. */
function gateway(): Promise<{ url: string; close: () => void; offline: (v: boolean) => void }> {
  let off = false;
  const srv = http.createServer((req, res) => {
    if (off) return req.socket.destroy();
    const m = req.url!.match(/^\/(auth|rest)\/v1(\/.*)?$/);
    if (!m) {
      res.writeHead(404).end('{}');
      return;
    }
    const target = new URL((m[2] ?? '/') || '/', m[1] === 'auth' ? AUTH : REST);
    const p = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    });
    p.on('error', () => res.writeHead(502).end());
    req.pipe(p);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close(), offline: (v) => (off = v) })));
}

function memSecrets(): SecretStore & { dump(): string } {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void (v === null ? m.delete(k) : m.set(k, v)),
    dump: () => JSON.stringify([...m]),
  };
}

async function adminCreateUser(email: string, password: string) {
  const r = await fetch(`${AUTH}/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!r.ok) throw new Error(`admin create ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

const noBlobs = { has: () => false, read: () => new Uint8Array(), write: () => undefined };

d('الحساب السحابي عبر مكدس Supabase حقيقي (دخول، ترحيل، انضمام جهاز، تحقق بخطوتين، إلغاء جهاز)', () => {
  const clock = new Clock('2026-11-25T08:00:00.000Z');
  let gw: Awaited<ReturnType<typeof gateway>>;
  const email = `owner-${Date.now()}@example.test`;
  const password = 'Cloud#Owner-Pass-2026';
  const A = makeCore(tmpDir(), clock); // جهاز المكتب
  const B = makeCore(tmpDir(), clock); // جهاز جديد فارغ
  const secA = memSecrets();
  const secB = memSecrets();
  const mk = (env: typeof A, sec: SecretStore, name: string) =>
    new CloudService({ db: () => env.core.db, secrets: sec, blobStore: noBlobs, device: { name, platform: 'windows', appVersion: 'test' }, autoDownload: () => false, loopMs: 0 });
  let officeId = '';

  beforeAll(async () => {
    gw = await gateway();
    await adminCreateUser(email, password);
    await setupOwner(A.core, 'S-A');
    const ids = await seedCompany(A.core, 'S-A');
    await call(A.core, 'S-A', 'payments.create', { contractId: ids.contractId, amount: 4000000, paidOn: '2026-03-05', method: 'تحويل بنكي' });
    await call(A.core, 'S-A', 'consultations.create', { channel: 'phone', subject: 'استشارة عمالية تجريبية', scheduledAt: '2026-11-26T10:00', durationMinutes: 30, feeMode: 'paid', feeAmount: 50000, newPerson: { name: 'طالب استشارة خيالي', phone: '0500000099' } }).catch(() => undefined);
    A.core.cloud = mk(A, secA, 'جهاز المكتب');
    B.core.cloud = mk(B, secB, 'ماك تجريبي');
  });
  afterAll(() => gw?.close());

  it('1. المالك يضبط المشروع بالمفتاح العام فقط، ويرفض عنوانًا غير مشفر لخادم بعيد', async () => {
    const bad = await A.core.dispatch('S-A', 'cloud.configure', { url: 'http://evil.example', anonKey: ANON });
    expect(bad.ok).toBe(false);
    await call(A.core, 'S-A', 'cloud.configure', { url: gw.url, anonKey: ANON });
    expect(A.core.cloud!.getStatus().phase).toBe('signed_out');
  });

  it('2. كلمة مرور خاطئة تُرفض، والصحيحة تسجل الدخول دون مكتب بعد', async () => {
    const wrong = await A.core.dispatch('S-A', 'cloud.signIn', { email, password: 'wrong-pass-123' });
    expect(wrong.ok).toBe(false);
    const r = await call(A.core, 'S-A', 'cloud.signIn', { email, password });
    expect(r).toMatchObject({ mfaRequired: false, signedIn: false, needsOffice: true });
  });

  it('3. نقل بيانات الجهاز إلى المكتب السحابي: نسخة احتياطية أولًا، ثم أعداد مطابقة على الخادم', async () => {
    const before = localCounts(A.core.db);
    const r = await call(A.core, 'S-A', 'cloud.createOffice', {});
    officeId = r.officeId;
    expect(r.backupFile).toMatch(/قبل-النقل-السحابي-.*\.lobk$/);
    const s = await call(A.core, 'S-A', 'cloud.syncNow', {});
    expect(s.rejected).toBe(0);
    expect(A.core.cloud!.getStatus()).toMatchObject({ phase: 'idle', pending: 0 });
    expect(A.core.cloud!.getStatus().lastSyncAt).toBeTruthy();
    expect(localCounts(A.core.db)).toEqual(before); // لم يُحذف شيء من الجهاز الأصلي
  });

  it('3b. تقرير التحقق من النقل: الأعداد والمعرّفات ومجموع الدفعات متطابقة، ويكشف أي فرق قبل المزامنة', async () => {
    const r = await call(A.core, 'S-A', 'cloud.migrationReport', {});
    expect(r.ok).toBe(true);
    expect(r.rows.find((x: { table: string }) => x.table === 'clients')).toMatchObject({ local: 1, server: 1, idsMatch: true });
    expect(r.rows.length).toBeGreaterThan(5);
    expect(r.paymentsServer).toBe(4000000);
    expect(r.paymentsLocal).toBe(4000000);
    // تعديل لم يُرسل بعد ← التقرير يظهر الفرق ولا يدّعي التطابق
    await call(A.core, 'S-A', 'clients.create', { kind: 'individual', name: 'عميل لم يُزامن بعد', phone: '0500000044' });
    const diff = await call(A.core, 'S-A', 'cloud.migrationReport', {});
    expect(diff.ok).toBe(false);
    expect(diff.pending).toBeGreaterThan(0);
    expect(diff.rows.find((x: { table: string }) => x.table === 'clients')).toMatchObject({ local: 2, server: 1 });
    await call(A.core, 'S-A', 'cloud.syncNow', {});
    expect((await call(A.core, 'S-A', 'cloud.migrationReport', {})).ok).toBe(true);
  });

  it('4. جهاز جديد فارغ: الدخول ثم اختيار المكتب والانضمام، ويصل كل شيء بالأرقام نفسها', async () => {
    await call(B.core, 'S-B', 'cloud.configure', { url: gw.url, anonKey: ANON });
    const r = await call(B.core, 'S-B', 'cloud.signIn', { email, password });
    expect(r).toMatchObject({ signedIn: false, needsOffice: true });
    const offices = await call(B.core, 'S-B', 'cloud.offices', {});
    expect(offices.map((o: { office_id: string }) => o.office_id)).toContain(officeId);
    await call(B.core, 'S-B', 'cloud.joinOffice', { officeId });
    const me = await call(B.core, 'S-B', 'auth.me');
    expect(me.role).toBe('owner');
    expect(localCounts(B.core.db)).toEqual(localCounts(A.core.db));
    const input = { mode: 'asOf' as const, asOf: '2026-12-31', from: null, to: null, clientId: null, caseType: null, caseStatus: null, responsibleUserId: null, serviceType: null, payStatus: null, sections: [], columns: {}, includeSensitive: false, includeDetails: false, staleDays: 30, expiringDays: 30 };
    const ctx = (core: typeof A.core) => ({ db: core.db, paths: core.paths, user: { id: me.id, username: 'owner', displayName: 'x', role: 'owner' as const, permissions: new Set<never>() }, sessionKey: 'x', platform: core.platform, now: clock.now });
    const strip = (r: ReturnType<typeof buildOfficeReport>) => JSON.stringify({ summary: r.summary, fin: r.sections.find((x) => x.key === 'finance')?.rows });
    expect(strip(buildOfficeReport(ctx(B.core), input))).toBe(strip(buildOfficeReport(ctx(A.core), input)));
  });

  it('5. تعديل على الجهاز الجديد يصل للأول بعد المزامنة', async () => {
    const list = await call(B.core, 'S-B', 'clients.list', {});
    const id = (list.items ?? list)[0].id;
    const { client } = await call(B.core, 'S-B', 'clients.get', { id });
    await call(B.core, 'S-B', 'clients.update', { ...client, id, notes: 'ملاحظة من الماك — خيالية' });
    await call(B.core, 'S-B', 'cloud.syncNow', {});
    await call(A.core, 'S-A', 'cloud.syncNow', {});
    const got = await call(A.core, 'S-A', 'clients.get', { id });
    expect(JSON.stringify(got)).toContain('ملاحظة من الماك');
  });

  it('6. جلسة الدخول محفوظة في مخزن الأسرار، ولا تُحفظ كلمة المرور نصًا', async () => {
    const dump = secA.dump();
    expect(dump).toContain('access_token');
    expect(dump).not.toContain(password);
    expect(dump).not.toContain(SERVICE);
  });

  it('7. التحقق بخطوتين: تفعيل TOTP، ثم إلزامه للمكتب، فيُطلب الرمز عند الدخول ويُمنع التزامن قبله', async () => {
    const en = await call(A.core, 'S-A', 'cloud.mfaEnroll', {});
    expect(en.secret).toBeTruthy();
    await call(A.core, 'S-A', 'cloud.mfaEnrollVerify', { factorId: en.factorId, code: totp(en.secret) });
    await call(A.core, 'S-A', 'cloud.requireMfa', { on: true });
    await call(B.core, 'S-B', 'cloud.signOut', {});
    const r = await call(B.core, 'S-B', 'cloud.signIn', { email, password });
    expect(r.mfaRequired).toBe(true);
    const blocked = await B.core.dispatch('S-B', 'clients.list', {});
    expect(blocked.ok).toBe(false); // لا جلسة محلية قبل الرمز
    const bad = await B.core.dispatch('S-B', 'cloud.mfaVerify', { code: '000000' });
    expect(bad.ok).toBe(false);
    // نافذة TOTP التالية لتجنب إعادة استعمال الرمز نفسه
    const v = await call(B.core, 'S-B', 'cloud.mfaVerify', { code: totp(en.secret, Date.now() + 30000) }).catch(() => call(B.core, 'S-B', 'cloud.mfaVerify', { code: totp(en.secret) }));
    expect(v.signedIn).toBe(true);
    const s = await call(B.core, 'S-B', 'cloud.syncNow', {});
    expect(s.rejected).toBe(0);
  });

  it('8. صفحة الأجهزة: يظهر الجهازان، وإلغاء الجهاز الجديد يوقف مزامنته فورًا', async () => {
    const devs = await call(A.core, 'S-A', 'cloud.devices', {});
    const names = devs.map((x: { device_name: string }) => x.device_name);
    expect(names).toEqual(expect.arrayContaining(['جهاز المكتب', 'ماك تجريبي']));
    const target = devs.find((x: { device_name: string }) => x.device_name === 'ماك تجريبي');
    await call(A.core, 'S-A', 'cloud.revokeDevice', { id: target.id });
    const r = await B.core.dispatch('S-B', 'cloud.syncNow', {});
    expect(r.ok).toBe(false);
    expect(B.core.cloud!.getStatus().phase).toBe('revoked');
    // الجهاز الملغى لا يستطيع الكتابة للخادم حتى بإعادة المحاولة
    expect((await B.core.dispatch('S-B', 'cloud.syncNow', {})).ok).toBe(false);
  });

  it('9. دون اتصال: الجهاز الذي سبق الدخول عليه يدخل بكلمة المرور نفسها ويعمل محليًا، وكلمة خاطئة تُرفض', async () => {
    gw.offline(true);
    try {
      await call(A.core, 'S-A', 'cloud.signOut', {});
      const wrong = await A.core.dispatch('S-A2', 'cloud.signIn', { email, password: 'nope-nope-123' });
      expect(wrong.ok).toBe(false);
      const r = await call(A.core, 'S-A2', 'cloud.signIn', { email, password });
      expect(r).toMatchObject({ offline: true, signedIn: true });
      expect((await call(A.core, 'S-A2', 'auth.me')).username).toBe(OWNER.username);
    } finally {
      gw.offline(false);
    }
  });
});
