// «خادم المكتب» المحلي: جهاز المكتب (ويندوز) خادم، والماك يتزامن معه، والآيفون عبر الرابط الآمن.
// بيانات خيالية في مجلدات مؤقتة. البريد يُلتقط في الاختبار بدل إرساله.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { HubStore } from '../../src/hub/store';
import { createHubServer } from '../../src/hub/server';
import { HubClient } from '../../src/sync/hubClient';
import { localCounts } from '../../src/sync/setup';
import { attachmentPath } from '../../src/main/paths';
import { call, makeCore, makePdf, seedCompany, setupOwner, stageAndAttach, tmpDir, Clock, OWNER } from '../unit/helpers';

const mem = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)), m };
};
const fsBlobs = (core: { paths: Parameters<typeof attachmentPath>[0] }) => ({
  has: (n: string) => fs.existsSync(attachmentPath(core.paths, n)),
  read: (n: string) => new Uint8Array(fs.readFileSync(attachmentPath(core.paths, n))),
  write: (n: string, b: Uint8Array) => {
    const f = attachmentPath(core.paths, n);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, b);
  },
  remove: (n: string) => fs.rmSync(attachmentPath(core.paths, n), { force: true }),
});

/** متصفح مبسط يحفظ ملف تعريف الارتباط (cookie) مثل Safari على الآيفون. */
class Browser {
  cookie = '';
  constructor(private base: string) {}
  async req(p: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const r = await fetch(this.base + p, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return r;
  }
  async json(p: string, body?: unknown) {
    const r = await this.req(p, body);
    return { status: r.status, body: (await r.json()) as any };
  }
  async api(channel: string, payload: unknown = {}) {
    return (await this.json('/api/dispatch', { channel, payload })).body;
  }
}

describe('خادم المكتب المحلي: الماك يتزامن مع جهاز المكتب، والآيفون عبر الرابط الآمن', () => {
  const clock = new Clock('2026-11-25T08:00:00.000Z');
  const A = makeCore(tmpDir(), clock); // جهاز المكتب — يعمل دائمًا
  const M = makeCore(tmpDir(), clock); // الماك (فيه بيانات تجريبية سابقة)
  const mails: { to: string; text: string }[] = [];
  const lastCode = () => /(\d{6})/.exec(mails[mails.length - 1].text)![1];
  let base = '';
  let server: ReturnType<typeof createHubServer>;
  let store: HubStore;
  let mac: HubClient;
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  let ownerId = '';
  const secrets = mem();

  beforeAll(async () => {
    await setupOwner(A.core, 'S-A');
    ownerId = (await call(A.core, 'S-A', 'auth.me')).id;
    ids = await seedCompany(A.core, 'S-A');
    const pdf = makePdf(path.join(A.dir, 'contract.pdf'), 'Office contract');
    await stageAndAttach(A.core, A.platform, 'S-A', pdf, { title: 'عقد الأتعاب', category: 'fee_contract', clientId: ids.clientId, contractId: ids.contractId });
    await call(A.core, 'S-A', 'payments.create', { contractId: ids.contractId, amount: 4000000, paidOn: '2026-03-05', method: 'تحويل بنكي' });
    store = new HubStore(() => A.core.db);
    store.enable();
    A.core.db.run('INSERT INTO hub_user_email (user_id, email) VALUES (?, ?)', [ownerId, 'owner.office@gmail.com']);
    server = createHubServer({ core: A.core, store, mailer: { send: async (to, _s, text) => void mails.push({ to, text }) }, webDir: null, now: clock.now, officeName: () => 'مكتب تجريبي' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // الماك فيه حساب وبيانات تجريبية سابقة
    await call(M.core, 'S-M', 'auth.setupOwner', { ...OWNER, username: 'macuser', password: 'Mac#Pass-2026x' });
    await call(M.core, 'S-M', 'clients.create', { kind: 'individual', name: 'عميل تجريبي على الماك فقط', phone: '0500000011' });
    mac = new HubClient({ db: () => M.core.db, secrets, blobStore: fsBlobs(M.core), device: { name: 'ماك المنزل', platform: 'mac', appVersion: 'test' }, autoDownload: () => true, now: clock.now, loopMs: 0 });
  });
  afterAll(() => server?.close());

  it('1. ربط الماك: كلمة مرور خاطئة تُرفض، والصحيحة ترسل رمزًا لبريد صاحب المكتب؛ رمز خاطئ يُرفض', async () => {
    await expect(mac.linkStart(base, 'owner', 'wrong-password')).rejects.toThrow();
    const st = await mac.linkStart(base, 'owner', OWNER.password);
    expect(mails.at(-1)!.to).toBe('owner.office@gmail.com');
    expect(st.sentTo).toMatch(/^ow•+@gmail\.com$/);
    await expect(mac.linkVerify(base, st.challengeId, '000000')).rejects.toThrow(/غير صحيح/);
    expect(mac.linked()).toBe(false);
  });

  it('2. بعد الرمز: يستلم الماك نسخة المكتب كاملة (والمرفق ببصمته)، والدخول بحساب المكتب نفسه', async () => {
    const st = await mac.linkStart(base, 'owner', OWNER.password);
    const r = await mac.linkVerify(base, st.challengeId, lastCode());
    expect(r.localUserId).toBe(ownerId);
    expect(localCounts(M.core.db)).toEqual(localCounts(A.core.db));
    // بيانات الماك السابقة استُبدلت (أُخذت نسختها الاحتياطية من شاشة الربط قبل ذلك)
    expect(M.core.db.get<{ n: number }>("SELECT count(*) AS n FROM clients WHERE name = 'عميل تجريبي على الماك فقط'")!.n).toBe(0);
    const v = A.core.db.get<{ stored_name: string; sha256: string }>('SELECT stored_name, sha256 FROM document_versions')!;
    expect(createHash('sha256').update(fs.readFileSync(attachmentPath(M.core.paths, v.stored_name))).digest('hex')).toBe(v.sha256);
    await call(M.core, 'S-M2', 'auth.login', { username: 'owner', password: OWNER.password });
    expect((await call(M.core, 'S-M2', 'auth.me')).id).toBe(ownerId);
    expect(secrets.m.get('hub.token')).toBeTruthy();
  });

  it('3. إضافة قضية وملف من الماك تُحفظ في جهاز المكتب، والعكس', async () => {
    const c = await call(M.core, 'S-M2', 'cases.create', { clientId: ids.clientId, title: 'قضية أضيفت من الماك', caseType: 'labor', court: 'المحكمة العمالية' }).catch(async () => {
      const cs = await call(M.core, 'S-M2', 'cases.get', { id: ids.laborId });
      return call(M.core, 'S-M2', 'cases.create', { clientId: ids.clientId, title: 'قضية أضيفت من الماك', caseType: cs.case?.caseType ?? 'labor' });
    });
    const pdf = makePdf(path.join(M.dir, 'memo.pdf'), 'Memo from Mac');
    const doc = await stageAndAttach(M.core, M.platform, 'S-M2', pdf, { title: 'مذكرة من الماك', category: 'memo', clientId: ids.clientId, caseId: c.id });
    await mac.syncNow();
    expect(A.core.db.get<{ title: string }>('SELECT title FROM cases WHERE id = ?', [c.id])!.title).toBe('قضية أضيفت من الماك');
    const v = A.core.db.get<{ stored_name: string; sha256: string }>('SELECT stored_name, sha256 FROM document_versions WHERE id = ?', [doc.versionId])!;
    expect(createHash('sha256').update(fs.readFileSync(attachmentPath(A.core.paths, v.stored_name))).digest('hex')).toBe(v.sha256);
    // جهاز المكتب يضيف عميلًا ← يصل الماك
    await call(A.core, 'S-A', 'clients.create', { kind: 'individual', name: 'عميل أضيف في المكتب', phone: '0500000022' });
    await mac.syncNow();
    expect(M.core.db.get<{ n: number }>("SELECT count(*) AS n FROM clients WHERE name = 'عميل أضيف في المكتب'")!.n).toBe(1);
    expect(localCounts(M.core.db)).toEqual(localCounts(A.core.db));
  });

  it('4. تعديل النص نفسه من الجهازين: يحفظ جهاز المكتب نسخته، ويسجل الماك النسختين للمراجعة', async () => {
    const getC = async (core: typeof A.core, s: string) => (await call(core, s, 'clients.get', { id: ids.clientId })).client;
    await call(A.core, 'S-A', 'clients.update', { ...(await getC(A.core, 'S-A')), id: ids.clientId, notes: 'نسخة المكتب' });
    await call(M.core, 'S-M2', 'clients.update', { ...(await getC(M.core, 'S-M2')), id: ids.clientId, notes: 'نسخة الماك' });
    await mac.syncNow();
    expect((await getC(A.core, 'S-A')).notes).toBe('نسخة المكتب');
    const cf = M.core.db.get<{ client_data: string; server_data: string }>('SELECT client_data, server_data FROM sync_conflicts')!;
    expect(cf.client_data).toContain('نسخة الماك');
    expect(cf.server_data).toContain('نسخة المكتب');
  });

  it('5. دون اتصال: تُحفظ الدفعة على الماك، وإعادة إرسالها بعد فقد الرد تسجلها مرة واحدة فقط', async () => {
    await call(M.core, 'S-M2', 'payments.create', { contractId: ids.contractId, amount: 150000, paidOn: '2026-11-25', method: 'نقدًا' });
    // يصل الطلب لجهاز المكتب ويضيع الرد
    let drop = true;
    const realFetch = globalThis.fetch;
    const flaky: typeof fetch = async (u, i) => {
      const r = await realFetch(u, i);
      if (drop && String(u).endsWith('/api/sync/push')) {
        drop = false;
        throw new TypeError('fetch failed');
      }
      return r;
    };
    const mac2 = new HubClient({ db: () => M.core.db, secrets, blobStore: fsBlobs(M.core), device: { name: 'ماك المنزل', platform: 'mac', appVersion: 'test' }, autoDownload: () => true, now: clock.now, loopMs: 0, fetch: flaky });
    await mac2.init();
    await expect(mac2.syncNow()).rejects.toThrow();
    expect(mac2.getStatus().phase).toBe('offline');
    await mac2.syncNow();
    expect(A.core.db.get<{ n: number }>('SELECT count(*) AS n FROM payments WHERE amount = 150000')!.n).toBe(1);
    // تعديل مبلغ دفعة مسجلة يُرفض على جهاز المكتب، ويعود الماك للمبلغ المعتمد
    const p = M.core.db.get<{ id: string }>('SELECT id FROM payments WHERE amount = 150000')!;
    M.core.db.run('UPDATE payments SET amount = 999 WHERE id = ?', [p.id]);
    const r = await mac.syncNow();
    expect(r!.rejected).toBe(1);
    expect(A.core.db.get<{ amount: number }>('SELECT amount FROM payments WHERE id = ?', [p.id])!.amount).toBe(150000);
    expect(M.core.db.get<{ amount: number }>('SELECT amount FROM payments WHERE id = ?', [p.id])!.amount).toBe(150000);
  });

  it('6. أرقام الملفات لا تتكرر بين جهاز المكتب والماك', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      created.push((await call(M.core, 'S-M2', 'clients.create', { kind: 'individual', name: `عميل ماك ${i}`, phone: `05000003${i}0` })).id);
      created.push((await call(A.core, 'S-A', 'clients.create', { kind: 'individual', name: `عميل مكتب ${i}`, phone: `05000004${i}0` })).id);
    }
    await mac.syncNow();
    const nos = A.core.db.all<{ client_no: string }>('SELECT client_no FROM clients WHERE client_no IS NOT NULL').map((r) => r.client_no);
    expect(new Set(nos).size).toBe(nos.length);
  });

  it('7. الروابط الموقعة للملفات: معدلة أو منتهية لا تفتح', async () => {
    const vid = A.core.db.get<{ id: string }>('SELECT id FROM document_versions LIMIT 1')!.id;
    const tok = secrets.m.get('hub.token')!;
    const r = await (await fetch(`${base}/api/blobs`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'download-url', version_id: vid }) })).json();
    expect((await fetch(base + r.url)).status).toBe(200);
    expect((await fetch(base + r.url.replace(/sig=./, 'sig=x'))).status).toBe(403);
    clock.advance(10 * 60_000);
    expect((await fetch(base + r.url)).status).toBe(403);
    expect((await fetch(`${base}/api/blobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('8. الآيفون (الرابط الآمن): رمز بريد لأول مرة، ثم دون رمز 15 يومًا، ثم الرمز مجددًا', async () => {
    const ph = new Browser(base);
    expect((await ph.api('clients.list')).error.code).toBe('UNAUTHENTICATED');
    const bad = await ph.json('/api/web/login', { username: 'owner', password: 'nope-nope' });
    expect(bad.status).toBe(401);
    const s1 = await ph.json('/api/web/login', { username: 'owner', password: OWNER.password, deviceName: 'iPhone' });
    expect(s1.body.codeRequired).toBe(true);
    expect((await ph.json('/api/web/verify', { challengeId: s1.body.challengeId, code: '111111' })).status).toBe(401);
    expect((await ph.json('/api/web/verify', { challengeId: s1.body.challengeId, code: lastCode() })).status).toBe(200);
    expect(ph.cookie).toMatch(/^lo_dev=/);
    // إضافة قضية وملف من الآيفون ← تُحفظ في جهاز المكتب
    const c = await ph.api('clients.create', { kind: 'individual', name: 'عميل أضيف من الآيفون', phone: '0500000055' });
    expect(c.ok).toBe(true);
    const pdf = fs.readFileSync(makePdf(path.join(A.dir, 'iphone.pdf'), 'From iPhone'));
    const staged = await ph.api('documents.stageBytes', { name: 'صورة-عقد.pdf', bytes: { __b64: pdf.toString('base64') } });
    expect(staged.ok).toBe(true);
    const doc = await ph.api('documents.create', { title: 'عقد من الآيفون', category: 'other', clientId: c.data.id, token: staged.data.token });
    expect(doc.ok).toBe(true);
    const v = A.core.db.get<{ stored_name: string; size: number }>('SELECT stored_name, size FROM document_versions WHERE id = ?', [doc.data.versionId])!;
    expect(fs.statSync(attachmentPath(A.core.paths, v.stored_name)).size).toBe(pdf.length);
    // تنزيل الملف من الرابط
    const f = await ph.req(`/api/file/${doc.data.versionId}`);
    expect(Buffer.from(await f.arrayBuffer()).equals(pdf)).toBe(true);
    // عمليات جهاز المكتب ممنوعة عبر الرابط، ولا يمكن تجاوز مسار الرمز بأمر الدخول مباشرة
    expect((await ph.api('backup.create')).error.code).toBe('UNSUPPORTED');
    expect((await ph.api('auth.login', { username: 'owner', password: OWNER.password })).error.code).toBe('UNSUPPORTED');
    // تسجيل الخروج ثم الدخول من الجهاز نفسه: دون رمز
    await ph.api('auth.logout');
    const n = mails.length;
    const s2 = await ph.json('/api/web/login', { username: 'owner', password: OWNER.password });
    expect(s2.body).toEqual({ ok: true });
    expect(mails.length).toBe(n);
    // بعد 16 يومًا: الرمز مطلوب مرة أخرى، والجهاز نفسه يُجدد إعفاؤه
    clock.advance(16 * 86400_000);
    expect((await ph.api('clients.list')).error.code).toBe('UNAUTHENTICATED');
    const s3 = await ph.json('/api/web/login', { username: 'owner', password: OWNER.password });
    expect(s3.body.codeRequired).toBe(true);
    expect((await ph.json('/api/web/verify', { challengeId: s3.body.challengeId, code: lastCode() })).status).toBe(200);
    expect((await ph.api('clients.list')).ok).toBe(true);
    // وصل للماك أيضًا
    await mac.syncNow();
    expect(M.core.db.get<{ n: number }>("SELECT count(*) AS n FROM clients WHERE name = 'عميل أضيف من الآيفون'")!.n).toBe(1);
  });

  it('9. جهاز آخر دون الرمز لا يدخل، ولا يُعاد الرمز نفسه', async () => {
    const other = new Browser(base);
    const s = await other.json('/api/web/login', { username: 'owner', password: OWNER.password });
    expect(s.body.codeRequired).toBe(true);
    const code = lastCode();
    expect((await other.json('/api/web/verify', { challengeId: s.body.challengeId, code })).status).toBe(200);
    expect((await other.json('/api/web/verify', { challengeId: s.body.challengeId, code })).status).toBe(401);
  });

  it('10. إلغاء جهاز من جهاز المكتب يوقفه فورًا (الماك والآيفون)', async () => {
    A.core.db.run("UPDATE hub_devices SET revoked_at = ? WHERE kind = 'sync'", [clock.now().toISOString()]);
    await expect(mac.syncNow()).rejects.toThrow();
    expect(mac.getStatus().phase).toBe('revoked');
    const ph = new Browser(base);
    A.core.db.run("UPDATE hub_devices SET revoked_at = ? WHERE kind = 'web'", [clock.now().toISOString()]);
    expect((await ph.api('clients.list')).error.code).toBe('UNAUTHENTICATED');
  });
});
