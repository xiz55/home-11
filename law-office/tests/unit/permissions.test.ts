// الصلاحيات تُطبق في العملية الرئيسية على كل أمر — الاختبار يستدعي الأوامر مباشرة كما لو جاءت عبر IPC من واجهة معدّلة.
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { call, callErr, CONSULTANT, makeCore, makePdf, seedCompany, setupOwner, stageAndAttach } from './helpers';

describe('الصلاحيات والجلسات', () => {
  const { core, platform, clock, dir } = makeCore();
  const O = 'S-owner';
  const C = 'S-consultant';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  let consultantId = '';
  let otherClientCase = '';
  let otherClient = '';

  beforeAll(async () => {
    await setupOwner(core, O);
    ids = await seedCompany(core, O);
    otherClient = (await call(core, O, 'clients.create', { kind: 'individual', name: 'أحمد الخيالي' })).id;
    otherClientCase = (await call(core, O, 'cases.create', { clientId: otherClient, title: 'قضية لا يراها المستشار' })).id;
    consultantId = (await call(core, O, 'users.create', { ...CONSULTANT, permissions: [] })).id;
    await call(core, O, 'users.setAccess', { userId: consultantId, caseIds: [ids.laborId], clientIds: [] });
    await call(core, C, 'auth.login', { username: CONSULTANT.username, password: CONSULTANT.password });
  });

  it('أول تشغيل: لا يمكن إنشاء مالك ثانٍ', async () => {
    const e = await callErr(core, 'S-x', 'auth.setupOwner', { officeName: 'x', displayName: 'y', username: 'hacker', password: 'Hacker#123456' });
    expect(e.code).toBe('FORBIDDEN');
  });

  it('كلمات المرور مخزنة بتجزئة scrypt وليست نصًا مقروءًا', () => {
    const rows = core.db.all<{ password_hash: string }>('SELECT password_hash FROM users');
    for (const r of rows) {
      expect(r.password_hash.startsWith('scrypt$')).toBe(true);
      expect(r.password_hash).not.toContain('Pass2026');
    }
  });

  it('المستشار يرى الملف المسند فقط', async () => {
    const list = await call(core, C, 'cases.list', {});
    expect(list.map((c: any) => c.id)).toEqual([ids.laborId]);
    const e = await callErr(core, C, 'cases.get', { id: ids.commercialId });
    expect(e.code).toBe('FORBIDDEN');
    const e2 = await callErr(core, C, 'cases.get', { id: otherClientCase });
    expect(e2.code).toBe('FORBIDDEN');
    const clients = await call(core, C, 'clients.list', {});
    expect(clients.map((c: any) => c.id)).toEqual([ids.clientId]);
    const prof = await call(core, C, 'clients.get', { id: ids.clientId });
    expect(prof.access).toBe('basic');
    expect(prof.cases.map((c: any) => c.id)).toEqual([ids.laborId]);
    expect(prof.client.notes).toBeNull();
    const s = await call(core, C, 'search.global', { q: 'أحمد' });
    expect(s.hits.find((h: any) => h.id === otherClient)).toBeUndefined();
  });

  it('المستشار يحدّث ملفه المسند لكنه لا يصل لعمليات الإدارة', async () => {
    const c = await call(core, C, 'cases.get', { id: ids.laborId });
    const h = await call(core, C, 'hearings.create', { caseId: ids.laborId, stageId: c.stages[0].id, date: '2026-12-10', time: '09:00' });
    expect(h.id).toBeTruthy();
    for (const ch of ['users.list', 'backup.create', 'backup.inspectRestore', 'integration.state', 'settings.update', 'activity.list', 'system.info']) {
      const e = await callErr(core, C, ch, ch === 'settings.update' ? { 'office.name': 'x' } : {});
      expect(e.code, ch).toBe('FORBIDDEN');
    }
    expect((await callErr(core, C, 'clients.create', { kind: 'individual', name: 'جديد' })).code).toBe('FORBIDDEN');
    expect((await callErr(core, C, 'cases.create', { clientId: ids.clientId, title: 'جديدة' })).code).toBe('FORBIDDEN');
    expect((await callErr(core, C, 'cases.close', { id: ids.laborId, outcome: 'x', confirm: true })).code).toBe('FORBIDDEN');
    expect((await callErr(core, C, 'cases.setArchived', { id: ids.laborId, archived: true })).code).toBe('FORBIDDEN');
  });

  it('الأتعاب مخفية عن المستشار دون صلاحية، ولا تُكشف عبر العقود أو الملخص', async () => {
    expect((await callErr(core, C, 'finance.clientSummary', { clientId: ids.clientId })).code).toBe('FORBIDDEN');
    expect((await callErr(core, C, 'payments.list', { clientId: ids.clientId })).code).toBe('FORBIDDEN');
    const ks = await call(core, C, 'contracts.list', { caseId: ids.laborId });
    expect(ks[0].amountsHidden).toBe(true);
    expect(ks[0].fixedAmount).toBeNull();
    expect(ks[0].totals).toBeNull();
    const dash = await call(core, C, 'dashboard.get', {});
    expect(dash.finance).toBeNull();
    expect((await callErr(core, C, 'payments.create', { contractId: ids.contractId, amount: 100, paidOn: '2026-01-01' })).code).toBe('FORBIDDEN');
  });

  it('لا يرفع المستشار صلاحياته بتعديل الطلب', async () => {
    const e = await callErr(core, C, 'users.update', { id: consultantId, displayName: 'x', active: true, permissions: ['fees.view', 'cases.create'] });
    expect(e.code).toBe('FORBIDDEN');
    // حقول إضافية مثل role تُتجاهل بالتحقق
    await call(core, C, 'session.ping', { role: 'owner' } as never).catch(() => null);
    const me = await call(core, C, 'auth.me', {});
    expect(me.role).toBe('consultant');
    expect(me.permissions).not.toContain('fees.view');
    const e2 = await callErr(core, C, 'users.setAccess', { userId: consultantId, caseIds: [ids.commercialId], clientIds: [] });
    expect(e2.code).toBe('FORBIDDEN');
    // تغيير المسؤول لنفسه على قضية غير مسندة غير ممكن
    const e3 = await callErr(core, C, 'cases.update', { id: ids.commercialId, clientId: ids.clientId, title: 'x', responsibleUserId: consultantId });
    expect(e3.code).toBe('FORBIDDEN');
  });

  it('المستندات غير المسموحة لا تُقرأ حتى بمعرّفها', async () => {
    const f = makePdf(path.join(dir, 'secret.pdf'));
    const d = await stageAndAttach(core, platform, O, f, { title: 'مستند تجاري', category: 'evidence', clientId: ids.clientId, caseId: ids.commercialId });
    expect((await callErr(core, C, 'documents.readBytes', { versionId: d.versionId })).code).toBe('FORBIDDEN');
    expect((await callErr(core, C, 'documents.get', { id: d.id })).code).toBe('FORBIDDEN');
    const g = makePdf(path.join(dir, 'general.pdf'), 'General client letter');
    const gd = await stageAndAttach(core, platform, O, g, { title: 'مستند عام للعميل', category: 'correspondence', clientId: ids.clientId });
    expect((await callErr(core, C, 'documents.readBytes', { versionId: gd.versionId })).code).toBe('FORBIDDEN');
    const list = await call(core, C, 'documents.list', { clientId: ids.clientId });
    expect(list.every((x: any) => x.caseId === ids.laborId)).toBe(true);
  });

  it('تعديل الصلاحيات يسري فورًا، وإيقاف الحساب ينهي جلسته', async () => {
    await call(core, O, 'users.update', { id: consultantId, displayName: CONSULTANT.displayName, active: true, permissions: ['fees.view'] });
    const sum = await call(core, C, 'finance.clientSummary', { clientId: ids.clientId });
    expect(sum.agreed).toBe(10000000);
    await call(core, O, 'users.update', { id: consultantId, displayName: CONSULTANT.displayName, active: false, permissions: [] });
    expect((await callErr(core, C, 'cases.list', {})).code).toBe('UNAUTHENTICATED');
    await call(core, O, 'users.update', { id: consultantId, displayName: CONSULTANT.displayName, active: true, permissions: [] });
    await call(core, C, 'auth.login', { username: CONSULTANT.username, password: CONSULTANT.password });
  });

  it('القفل بعد الخمول يمنع الأوامر حتى إدخال كلمة المرور', async () => {
    await call(core, O, 'settings.update', { 'security.idleLockMinutes': 5 });
    clock.advance(6 * 60_000);
    const e = await callErr(core, O, 'cases.list', {});
    expect(e.code).toBe('LOCKED');
    const st = await call(core, O, 'auth.state', {});
    expect(st.locked).toBe(true);
    expect((await callErr(core, O, 'auth.unlock', { password: 'wrong-password' })).code).toBe('VALIDATION');
    await call(core, O, 'auth.unlock', { password: 'Owner#Pass2026' });
    expect((await call(core, O, 'cases.list', {})).length).toBe(3);
  });

  it('تكرار كلمة مرور خاطئة يوقف المحاولات مؤقتًا، ورمز الاستعادة يعيد وصول المالك', async () => {
    const { core: c2 } = makeCore();
    const { recoveryCode } = await call(c2, 'A', 'auth.setupOwner', { officeName: 'x', displayName: 'مالك', username: 'boss', password: 'Boss#Pass2026' }).then((r: any) => ({ recoveryCode: r.recoveryCode }));
    for (let i = 0; i < 5; i++) await callErr(c2, 'B', 'auth.login', { username: 'boss', password: 'bad-password' });
    const locked = await callErr(c2, 'B', 'auth.login', { username: 'boss', password: 'Boss#Pass2026' });
    expect(locked.message).toContain('إيقاف');
    const bad = await callErr(c2, 'B', 'auth.recover', { username: 'boss', recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD', newPassword: 'New#Pass2026' });
    expect(bad.code).toBe('UNAUTHENTICATED');
    c2.db.run('UPDATE users SET locked_until = NULL, failed_attempts = 0');
    const r = await call(c2, 'B', 'auth.recover', { username: 'boss', recoveryCode: recoveryCode.toLowerCase(), newPassword: 'New#Pass2026' });
    expect(r.recoveryCode).not.toBe(recoveryCode);
    await call(c2, 'C', 'auth.login', { username: 'boss', password: 'New#Pass2026' });
    // الرمز القديم لم يعد صالحًا
    expect((await callErr(c2, 'D', 'auth.recover', { username: 'boss', recoveryCode, newPassword: 'Another#Pass1' })).code).toBe('UNAUTHENTICATED');
    c2.shutdown();
  });

  it('سجل الأنشطة يوثق المستخدم والوقت والعنصر', async () => {
    const log = await call(core, O, 'activity.list', { limit: 500 });
    expect(log.some((a: any) => a.action === 'create' && a.entity_type === 'hearing' && a.username === 'consultant')).toBe(true);
    expect(log.some((a: any) => a.action === 'permissions')).toBe(true);
  });
});
