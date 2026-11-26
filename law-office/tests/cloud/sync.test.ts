// اختبار المزامنة الفعلي بين أجهزة متعددة عبر قاعدة Supabase (PostgreSQL + RLS + الدوال) — بيانات خيالية.
// يتطلب قاعدة اختبار: docker run -p 54322:5432 supabase/postgres (يُتخطى إن لم تتوفر).
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { AppCore } from '../../src/main/core';
import { SyncEngine } from '../../src/sync/engine';
import { createCloudOffice, joinCloudOffice, localCounts } from '../../src/sync/setup';
import { buildOfficeReport } from '../../src/main/services/officeReport';
import { call, callErr, makeCore, seedCompany, setupOwner, tmpDir, Clock, CONSULTANT, makePdf, stageAndAttach } from '../unit/helpers';
import { PgTransport, adminQuery, createAuthUser, ensureSchema, newSession, pgAvailable } from './pg';

const available = await pgAvailable();
const d = available ? describe : describe.skip;

/** جهاز إضافي ببيانات فارغة ينضم للمكتب ويسجّل الدخول بحساب سحابي مرتبط بمستخدم المكتب. */
function newDevice(clock: Clock) {
  const env = makeCore(tmpDir(), clock);
  return env;
}
function cloudSession(core: AppCore, key: string, localUserId: string) {
  core.sessions.set(key, { userId: localUserId, lastActivity: core.now().getTime(), locked: false, dirty: false });
}

d('المزامنة السحابية بين ويندوز والماك والآيفون (منطق مشترك، قاعدة Supabase حقيقية)', () => {
  const clock = new Clock('2026-11-25T08:00:00.000Z');
  const A = makeCore(tmpDir(), clock); // جهاز المكتب (ويندوز)
  const B = newDevice(clock); // ماك
  const C = newDevice(clock); // آيفون (المنطق نفسه)
  let owner: { userId: string; sessionId: string };
  let tA: PgTransport, tB: PgTransport, tC: PgTransport;
  let eA: SyncEngine, eB: SyncEngine, eC: SyncEngine;
  let officeId = '';
  let ownerLocal = '';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  const sA = 'S-A';

  beforeAll(async () => {
    await ensureSchema();
    owner = await createAuthUser(`owner-${Date.now()}@example.test`);
    tA = new PgTransport(owner.userId, owner.sessionId);
    tB = new PgTransport(owner.userId, await newSession(owner.userId));
    tC = new PgTransport(owner.userId, await newSession(owner.userId));
    await setupOwner(A.core, sA);
    ownerLocal = (await call(A.core, sA, 'auth.me')).id;
    ids = await seedCompany(A.core, sA);
    const pdf = makePdf(path.join(A.dir, 'contract.pdf'), 'Contract');
    await stageAndAttach(A.core, A.platform, sA, pdf, { title: 'عقد الأتعاب', category: 'fee_contract', clientId: ids.clientId, contractId: ids.contractId });
    await call(A.core, sA, 'payments.create', { contractId: ids.contractId, amount: 4000000, paidOn: '2026-03-05', method: 'تحويل بنكي' });
    eA = new SyncEngine(() => A.core.db, tA, clock.now);
    eB = new SyncEngine(() => B.core.db, tB, clock.now);
    eC = new SyncEngine(() => C.core.db, tC, clock.now);
  });

  it('ترحيل بيانات المكتب القائم من جهاز واحد، ثم انضمام جهازين فارغين دون تكرار', async () => {
    const before = localCounts(A.core.db);
    officeId = await createCloudOffice(A.core.db, tA, { officeName: 'مكتب تجريبي — بيانات خيالية', localOwnerId: ownerLocal, displayName: 'المالك التجريبي' });
    const r = await eA.sync();
    expect(r.rejected).toBe(0);
    expect(eA.pendingCount()).toBe(0);
    // إعادة المزامنة لا ترفع شيئًا مكررًا
    expect((await eA.sync()).pushed).toBe(0);
    const server = await adminQuery<{ tbl: string; n: number }>("select split_part(tbl,'$',1) tbl, count(*)::int n from records where office_id = $1 and tbl not like '%$fin' group by 1", [officeId]);
    for (const row of server) expect(row.n, row.tbl).toBe(before[row.tbl]);
    // جهازا الماك والآيفون
    joinCloudOffice(B.core.db, officeId);
    joinCloudOffice(C.core.db, officeId);
    await eB.sync();
    await eC.sync();
    const cB = localCounts(B.core.db);
    for (const [t, n] of Object.entries(before)) if (t !== 'activity_log') expect(cB[t], t).toBe(n);
    // جهاز فيه بيانات محلية لا يُدمج بالتخمين
    expect(() => joinCloudOffice(A.core.db, officeId)).toThrow();
  });

  it('القضية ومرفقاتها والمبالغ تظهر على الجهاز الآخر بالقيم نفسها، والعقد الشامل يُحسب مرة واحدة', async () => {
    cloudSession(B.core, 'S-B', ownerLocal);
    const c = await call(B.core, 'S-B', 'cases.get', { id: ids.laborId });
    expect(c.case.title).toBe('مطالبة عمالية — موظف سابق (خيالي)');
    const docs = await call(B.core, 'S-B', 'documents.list', { clientId: ids.clientId });
    expect(docs.map((x: any) => x.title)).toContain('عقد الأتعاب');
    const kA = (await call(A.core, sA, 'contracts.get', { id: ids.contractId })).contract.totals;
    const kB = (await call(B.core, 'S-B', 'contracts.get', { id: ids.contractId })).contract.totals;
    expect(kB).toEqual(kA);
    expect(kB.paid).toBe(4000000);
  });

  it('إضافة استشارة واجتماع وملاحظة من «الآيفون» وظهورها على الجهازين الآخرين', async () => {
    cloudSession(C.core, 'S-C', ownerLocal);
    const k = await call(C.core, 'S-C', 'consultations.create', { clientId: ids.clientId, title: 'استشارة من الهاتف', method: 'phone', date: '2026-11-26', time: '10:00', durationMin: 30, feeMode: 'paid', feeAmount: 50000 });
    // الرقم المرجعي من كتلة محجوزة لهذا الجهاز
    expect(k.refNo).toMatch(/^CON-2026\/\d{4}$/);
    const m = await call(C.core, 'S-C', 'meetings.create', { clientId: ids.clientId, title: 'اجتماع من الهاتف', method: 'video', date: '2026-11-27', startTime: '11:00', endTime: '12:00' });
    await call(C.core, 'S-C', 'notes.save', { clientId: ids.clientId, caseId: ids.laborId, body: 'ملاحظة كُتبت على الآيفون' });
    await eC.sync();
    await eA.sync();
    await eB.sync();
    for (const [core, s] of [[A.core, sA], [B.core, 'S-B']] as const) {
      const g = await call(core, s, 'consultations.get', { id: k.id });
      expect(g.consultation.finance.due).toBe(50000);
      expect((await call(core, s, 'meetings.get', { id: m.id })).meeting.title).toBe('اجتماع من الهاتف');
      const notes = await call(core, s, 'notes.list', { clientId: ids.clientId, caseId: ids.laborId });
      expect(notes.some((n: any) => n.body === 'ملاحظة كُتبت على الآيفون')).toBe(true);
    }
  });

  it('العمل دون اتصال: الطابور يبقى بعد إعادة التشغيل ثم يُرسل عند عودة الاتصال', async () => {
    tB.offline = true;
    await call(B.core, 'S-B', 'notes.save', { clientId: ids.clientId, body: 'ملاحظة دون اتصال' });
    await expect(eB.sync()).rejects.toThrow();
    expect(eB.pendingCount()).toBeGreaterThan(0);
    // إغلاق التطبيق وإعادة فتحه
    const dir = B.core.paths.dataDir;
    B.core.shutdown();
    B.core = new AppCore(dir, B.platform, clock.now);
    eB = new SyncEngine(() => B.core.db, tB, clock.now);
    expect(eB.pendingCount()).toBeGreaterThan(0);
    tB.offline = false;
    await eB.sync();
    expect(eB.pendingCount()).toBe(0);
    await eA.sync();
    const notes = await call(A.core, sA, 'notes.list', { clientId: ids.clientId });
    expect(notes.some((n: any) => n.body === 'ملاحظة دون اتصال')).toBe(true);
  });

  it('تعديل النص نفسه من جهازين يحفظ النسختين للمراجعة ولا يستبدل بصمت؛ والحقول المستقلة تُدمج', async () => {
    cloudSession(B.core, 'S-B', ownerLocal);
    const memo = await call(A.core, sA, 'memos.create', { caseId: ids.laborId, title: 'مذكرة مشتركة', body: 'النص الأصلي' });
    await eA.sync();
    await eB.sync();
    await call(A.core, sA, 'memos.update', { id: memo.id, title: 'مذكرة مشتركة', body: 'نص المكتب (ويندوز)' });
    await call(B.core, 'S-B', 'memos.update', { id: memo.id, title: 'مذكرة مشتركة', body: 'نص الماك' });
    await eA.sync();
    const r = await eB.sync();
    expect(r.conflicts).toBe(1);
    const conflicts = await adminQuery<{ fields: string[]; server_data: any; client_data: any }>("select fields, server_data, client_data from sync_conflicts where office_id = $1 and tbl = 'memos'", [officeId]);
    expect(conflicts[0].fields).toContain('body');
    expect(conflicts[0].server_data.body).toBe('نص المكتب (ويندوز)');
    expect(conflicts[0].client_data.body).toBe('نص الماك');
    const local = B.core.db.get<{ client_data: string }>('SELECT client_data FROM sync_conflicts WHERE tbl = ?', ['memos'])!;
    expect(JSON.parse(local.client_data).body).toBe('نص الماك');
    // حقول مختلفة من جهازين تُدمج
    const t1 = await call(A.core, sA, 'tasks.create', { title: 'مهمة مشتركة', caseId: ids.laborId });
    await eA.sync();
    await eB.sync();
    A.core.db.run("UPDATE tasks SET priority = 'high' WHERE id = ?", [t1.id]);
    B.core.db.run("UPDATE tasks SET due_date = '2026-12-01' WHERE id = ?", [t1.id]);
    await eA.sync();
    await eB.sync();
    await eA.sync();
    for (const core of [A.core, B.core]) expect(core.db.get('SELECT priority, due_date FROM tasks WHERE id = ?', [t1.id])).toEqual({ priority: 'high', due_date: '2026-12-01' });
  });

  it('إعادة إرسال طلب دفعة بعد ضياع الرد تسجلها مرة واحدة فقط، والمبالغ المالية لا تُعدل بصمت', async () => {
    const p = await call(B.core, 'S-B', 'payments.create', { contractId: ids.contractId, amount: 1000000, paidOn: '2026-11-20', method: 'نقدًا' });
    tB.dropNextResponse = true;
    await expect(eB.sync()).rejects.toThrow();
    await eB.sync(); // يعيد الدفعة المعلقة بنفس المعرفات
    const rows = await adminQuery<{ n: number }>("select count(*)::int n from records where office_id = $1 and tbl = 'payments' and rid = $2", [officeId, p.id]);
    expect(rows[0].n).toBe(1);
    await eA.sync();
    const totals = (await call(A.core, sA, 'contracts.get', { id: ids.contractId })).contract.totals;
    expect(totals.paid).toBe(5000000);
    // تعديل مبلغ دفعة مباشرة يُرفض في الخادم ويُعاد المحلي لقيمته المعتمدة
    B.core.db.run('UPDATE payments SET amount = 1 WHERE id = ?', [p.id]);
    const r = await eB.sync();
    expect(r.rejected).toBe(1);
    expect(B.core.db.get<{ amount: number }>('SELECT amount FROM payments WHERE id = ?', [p.id])!.amount).toBe(1000000);
  });

  it('الأرقام المرجعية لا تتكرر بين جهازين يعملان دون اتصال', async () => {
    tA.offline = true;
    tB.offline = true;
    const a = await call(A.core, sA, 'cases.create', { clientId: ids.clientId, title: 'قضية دون اتصال 1' });
    const b = await call(B.core, 'S-B', 'cases.create', { clientId: ids.clientId, title: 'قضية دون اتصال 2' });
    expect(a.fileNo).not.toBe(b.fileNo);
    tA.offline = false;
    tB.offline = false;
    await eA.sync();
    await eB.sync();
    await eA.sync();
    expect(A.core.db.get<{ n: number }>("SELECT count(*) AS n FROM cases WHERE title LIKE 'قضية دون اتصال%'")!.n).toBe(2);
  });

  it('مطابقة التقرير المالي والشامل بين الأجهزة بعد المزامنة', async () => {
    await eA.sync();
    await eB.sync();
    await eC.sync();
    const input = { mode: 'asOf' as const, asOf: '2026-12-31', from: null, to: null, clientId: null, caseType: null, caseStatus: null, responsibleUserId: null, serviceType: null, payStatus: null, sections: [], columns: {}, includeSensitive: false, includeDetails: false, staleDays: 30, expiringDays: 30 };
    const ctx = (core: AppCore) => ({ db: core.db, paths: core.paths, user: { id: ownerLocal, username: 'owner', displayName: 'المالك التجريبي', role: 'owner' as const, permissions: new Set<never>() }, sessionKey: 'x', platform: core.platform, now: clock.now });
    const strip = (r: ReturnType<typeof buildOfficeReport>) => JSON.stringify({ summary: r.summary, fin: r.sections.find((s) => s.key === 'finance')?.rows });
    const rA = strip(buildOfficeReport(ctx(A.core), input));
    expect(strip(buildOfficeReport(ctx(B.core), input))).toBe(rA);
    expect(strip(buildOfficeReport(ctx(C.core), input))).toBe(rA);
  });

  it('المستشار يرى ملفاته فقط في الخادم ونسخته المحلية، ولا يصل إلى المالية دون صلاحية، ولا يكتب خارج نطاقه', async () => {
    const cons = await createAuthUser(`cons-${Date.now()}@example.test`);
    const local = await call(A.core, sA, 'users.create', { ...CONSULTANT, permissions: [] });
    await call(A.core, sA, 'users.setAccess', { userId: local.id, caseIds: [ids.laborId], clientIds: [] });
    await eA.sync();
    await tA.rpc('app_link_member', { p_office: officeId, p_user: cons.userId, p_local_user: local.id, p_display_name: CONSULTANT.displayName, p_permissions: [] });
    const tD = new PgTransport(cons.userId, cons.sessionId);
    const D = newDevice(clock);
    joinCloudOffice(D.core.db, officeId);
    const eD = new SyncEngine(() => D.core.db, tD, clock.now);
    await eD.sync();
    const caseIds = D.core.db.all<{ id: string }>('SELECT id FROM cases').map((r) => r.id);
    expect(caseIds).toEqual([ids.laborId]);
    expect(D.core.db.get<{ n: number }>('SELECT count(*) AS n FROM payments')!.n).toBe(0);
    expect(D.core.db.get<{ n: number }>('SELECT count(*) AS n FROM consultations')!.n).toBe(0);
    // استعلام مباشر في الخادم (تجاوز التطبيق) يخضع لـ RLS
    const direct = await tD.query<{ tbl: string; rid: string }>("select tbl, rid from records where tbl in ('payments','cases','contracts$fin')");
    expect(direct.filter((x) => x.tbl === 'cases').map((x) => x.rid)).toEqual([ids.laborId]);
    expect(direct.some((x) => x.tbl === 'payments' || x.tbl === 'contracts$fin')).toBe(false);
    // كتابة لقضية غير مسموحة تُرفض
    const res = await tD.push(officeId, [{ op_id: crypto.randomUUID(), tbl: 'notes', rid: crypto.randomUUID(), op: 'upsert', data: { client_id: ids.clientId, case_id: ids.commercialId, body: 'محاولة', is_internal: 1, created_at: 'x', updated_at: 'x' }, base: null, base_version: null }]);
    expect(res[0].status).toBe('rejected');
    // تسجيل دفعة دون صلاحية يُرفض في الخادم
    const pay = await tD.push(officeId, [{ op_id: crypto.randomUUID(), tbl: 'payments', rid: crypto.randomUUID(), op: 'upsert', data: { client_id: ids.clientId, contract_id: ids.contractId, amount: 1, paid_on: '2026-01-01' }, base: null, base_version: null }]);
    expect(pay[0].status).toBe('rejected');
    // سحب الصلاحية: عند الاتصال التالي تُزال القضية من نسخته المحلية
    await call(A.core, sA, 'users.setAccess', { userId: local.id, caseIds: [], clientIds: [] });
    await eA.sync();
    await eD.sync();
    expect(D.core.db.get<{ n: number }>('SELECT count(*) AS n FROM cases')!.n).toBe(0);
  });

  it('إلغاء جلسة جهاز يمنع وصوله الجديد فورًا', async () => {
    const devId = crypto.randomUUID();
    const touch = await tC.rpc<{ allowed: boolean }>('app_touch_device', { p_office: officeId, p_device: devId, p_name: 'iPhone تجريبي', p_platform: 'ios', p_version: '1.1.0' });
    expect(touch.allowed).toBe(true);
    const list = await tA.query<{ id: string; device_name: string }>('select id, device_name from devices');
    expect(list.map((x) => x.device_name)).toContain('iPhone تجريبي');
    await tA.rpc('app_revoke_device', { p_device: devId });
    expect(await tC.status(officeId)).toBeNull();
    await expect(tC.pull(officeId, 0, 10)).resolves.toEqual([]);
    expect((await tC.rpc<{ allowed: boolean }>('app_touch_device', { p_office: officeId, p_device: devId, p_name: 'x', p_platform: 'ios', p_version: '1' })).allowed).toBe(false);
    // الأجهزة الأخرى تعمل
    expect(await tB.status(officeId)).not.toBeNull();
  });

  it('التحقق بخطوتين إلزامي عند تفعيله: الجلسة دون خطوة ثانية لا تصل للبيانات', async () => {
    const t2 = new PgTransport(owner.userId, owner.sessionId, 'aal2');
    await t2.rpc('app_set_require_mfa', { p_office: officeId, p_on: true });
    expect(await tA.status(officeId)).toBeNull();
    expect(await t2.status(officeId)).not.toBeNull();
    await t2.rpc('app_set_require_mfa', { p_office: officeId, p_on: false });
  });

  it('غير العضو لا يرى شيئًا', async () => {
    const stranger = await createAuthUser(`x-${Date.now()}@example.test`);
    const t = new PgTransport(stranger.userId, stranger.sessionId);
    expect(await t.query('select * from records')).toEqual([]);
    expect(await t.status(officeId)).toBeNull();
    await expect(t.push(officeId, [])).rejects.toThrow();
  });

  it('المحذوف لا يُعاد إحياؤه من جهاز قديم', async () => {
    const it2 = await call(A.core, sA, 'meetings.create', { title: 'اجتماع للحذف', method: 'phone', date: '2026-12-02', startTime: '09:00', endTime: '09:30' });
    const item = await call(A.core, sA, 'meetingItems.save', { meetingId: it2.id, kind: 'decision', text: 'بند سيُحذف' });
    await eA.sync();
    await eB.sync();
    await call(A.core, sA, 'meetingItems.remove', { id: item.id });
    await eA.sync();
    // الجهاز القديم يعدل البند قبل أن يعلم بحذفه
    B.core.db.run("UPDATE meeting_items SET text = 'تعديل قديم' WHERE id = ?", [item.id]);
    await eB.sync();
    expect(B.core.db.get('SELECT 1 AS x FROM meeting_items WHERE id = ?', [item.id])).toBeUndefined();
    const srv = await adminQuery<{ deleted: boolean }>("select deleted from records where tbl = 'meeting_items' and rid = $1", [item.id]);
    expect(srv[0].deleted).toBe(true);
  });

  it('لا أسرار إدارية داخل شيفرة التطبيقات', async () => {
    const fs = await import('node:fs');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = [...walk('src'), ...walk('supabase')].filter((f) => /\.(ts|tsx|sql|json)$/.test(f));
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      expect(/service_role["']?\s*[:=]\s*["']ey/i.test(s), f).toBe(false);
      expect(/eyJhbGciOi[A-Za-z0-9_-]{20,}/.test(s), f).toBe(false);
      expect(/K00[0-9A-Za-z]{20,}/.test(s), f).toBe(false); // نمط مفاتيح B2
    }
  });
});

export const _x = callErr;
