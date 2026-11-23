import { describe, it, expect, beforeAll } from 'vitest';
import { riyadhToUtcIso, utcIsoToRiyadh, todayRiyadh, fmtDateTime, isValidDate } from '../../src/shared/dates';
import { normalizeArabic, searchTokens } from '../../src/shared/text';
import { parseAmount, fmtAmount } from '../../src/shared/money';
import { call, callErr, makeCore, seedCompany, setupOwner } from './helpers';
import { takeDueReminders, markMissed } from '../../src/main/services/reminders';

describe('التواريخ بتوقيت الرياض', () => {
  it('لا تنزاح التواريخ مع اختلاف منطقة الجهاز', () => {
    expect(riyadhToUtcIso('2026-03-01', '09:30')).toBe('2026-03-01T06:30:00.000Z');
    expect(riyadhToUtcIso('2026-03-01', '01:00')).toBe('2026-02-28T22:00:00.000Z');
    expect(utcIsoToRiyadh('2026-02-28T22:00:00.000Z')).toEqual({ date: '2026-03-01', time: '01:00' });
    expect(todayRiyadh(new Date('2026-11-23T22:30:00Z'))).toBe('2026-11-24');
    expect(fmtDateTime('2026-03-01T06:30:00.000Z')).toBe('2026/03/01 — 9:30 ص');
    expect(isValidDate('2026-02-30')).toBe(false);
  });
});

describe('التطبيع العربي للبحث', () => {
  it('يوحد الهمزات والتاء المربوطة والتشكيل والأرقام دون تغيير الأصل', () => {
    expect(normalizeArabic('شَرِكَةُ الْمِثَالِ')).toBe(normalizeArabic('شركه المثال'));
    expect(normalizeArabic('أحمد')).toBe(normalizeArabic('احمد'));
    expect(normalizeArabic('إبراهيم')).toBe('ابراهيم');
    expect(normalizeArabic('مصطفى')).toBe(normalizeArabic('مصطفي'));
    expect(normalizeArabic('٤٤٧٠')).toBe('4470');
    expect(searchTokens('  أحمد،  المثال ')).toEqual(['احمد', 'المثال']);
  });
});

describe('المبالغ', () => {
  it('تُحفظ بالهللة دون أخطاء كسور', () => {
    expect(parseAmount('15,000.50')).toBe(1500050);
    expect(parseAmount('١٥٠٠٠')).toBe(1500000);
    expect(parseAmount('0.1')).toBe(10);
    expect(Number.isNaN(parseAmount('12.345'))).toBe(true);
    expect(fmtAmount(1500050)).toBe('15,000.50 ر.س');
  });
});

describe('التنبيهات والمواعيد الفائتة', () => {
  const { core, clock } = makeCore();
  const S = 'S';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  beforeAll(async () => {
    await setupOwner(core, S);
    ids = await seedCompany(core, S);
  });

  it('يقترح تنبيهين (24 ساعة و30 دقيقة) للجلسة المؤكدة فقط', async () => {
    const c = await call(core, S, 'cases.get', { id: ids.laborId });
    const h = await call(core, S, 'hearings.create', { caseId: ids.laborId, stageId: c.stages[0].id, date: '2026-11-25', time: '10:00' });
    const rs = core.db.all<{ remind_at: string }>('SELECT remind_at FROM reminders WHERE entity_id = ? ORDER BY remind_at', [h.id]);
    expect(rs.map((r) => r.remind_at)).toEqual(['2026-11-24T07:00:00.000Z', '2026-11-25T06:30:00.000Z']);
    const u = await call(core, S, 'hearings.create', { caseId: ids.laborId, stageId: c.stages[0].id, date: '2026-11-26', time: '10:00', confirmed: false });
    expect(core.db.all('SELECT * FROM reminders WHERE entity_id = ?', [u.id])).toHaveLength(0);
    const ev = await call(core, S, 'calendar.events', { from: '2026-11-26', to: '2026-11-26' });
    expect(ev.find((e: any) => e.id === u.id).confirmed).toBe(false);
  });

  it('تعديل الموعد يُسجل أثره ويعيد حساب التنبيهات', async () => {
    const list = await call(core, S, 'hearings.list', { caseId: ids.laborId });
    const h = list.find((x: any) => x.confirmed);
    await call(core, S, 'hearings.update', { ...h, date: '2026-11-27', time: '12:00', changeReason: 'تأجيل بقرار الدائرة' });
    const g = await call(core, S, 'hearings.get', { id: h.id });
    expect(g.changes.find((x: any) => x.field === 'starts_at').reason).toBe('تأجيل بقرار الدائرة');
    const rs = core.db.all<{ remind_at: string }>('SELECT remind_at FROM reminders WHERE entity_id = ? ORDER BY remind_at', [h.id]);
    expect(rs[0].remind_at).toBe('2026-11-26T09:00:00.000Z');
  });

  it('تُطلق التنبيهات في وقتها، وما فات أثناء الإغلاق يظهر كفائت', async () => {
    clock.advance(5 * 24 * 3600_000); // أغلق البرنامج أيامًا
    const missed = markMissed(core.systemCtx());
    expect(missed).toBeGreaterThan(0);
    const m = await call(core, S, 'auth.state', {});
    expect(m).toBeTruthy();
    const ms = await core.dispatch(S, 'reminders.missed', {});
    expect(ms.ok || (ms as any).error.code === 'LOCKED').toBe(true);
    await call(core, S, 'auth.unlock', { password: 'Owner#Pass2026' }).catch(() => null);
    const list = await call(core, S, 'reminders.missed', {});
    expect(list.length).toBeGreaterThan(0);
    await call(core, S, 'reminders.acknowledge', { ids: list.map((x: any) => x.id) });
    expect(await call(core, S, 'reminders.missed', {})).toHaveLength(0);
    expect(takeDueReminders(core.systemCtx())).toHaveLength(0);
  });
});

describe('التقارير والإقفال والأرشفة', () => {
  const { core, platform } = makeCore();
  const S = 'S';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  beforeAll(async () => {
    await setupOwner(core, S);
    ids = await seedCompany(core, S);
    await call(core, S, 'notes.save', { clientId: ids.clientId, caseId: ids.laborId, body: 'ملاحظة داخلية سرية', isInternal: true });
    await call(core, S, 'notes.save', { clientId: ids.clientId, caseId: ids.laborId, body: 'ملاحظة للعميل', isInternal: false });
  });

  it('تقرير القضية عربي RTL ويستبعد الملاحظات الداخلية حسب الاختيار', async () => {
    const r = await call(core, S, 'reports.render', { type: 'case', caseId: ids.laborId, options: { includeInternalNotes: false } });
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('ملاحظة للعميل');
    expect(r.html).not.toContain('ملاحظة داخلية سرية');
    expect(r.html).toContain('تاريخ الاستخراج');
    expect(r.html).toContain('آخر تحديث مسجل');
    expect(r.html).not.toMatch(/<script/i);
    const r2 = await call(core, S, 'reports.render', { type: 'case', caseId: ids.laborId, options: { includeInternalNotes: true, includeFees: true } });
    expect(r2.html).toContain('ملاحظة داخلية سرية');
    expect(r2.html).toContain('عقد شامل لـ 2 قضايا');
    const fees = await call(core, S, 'reports.render', { type: 'fees', clientId: ids.clientId });
    expect(fees.html).toContain('ليس فاتورة ضريبية');
    platform.saveQueue.push(`${core.paths.tmpDir}/../../report.pdf`);
    const saved = await call(core, S, 'reports.savePdf', { type: 'hearings' });
    expect(saved.saved).toBe(true);
  });

  it('الإقفال قرار صريح بقائمة تحقق، وإعادة الفتح والأرشفة تحفظ التاريخ', async () => {
    const cl = await call(core, S, 'cases.closeChecklist', { id: ids.commercialId });
    expect(cl.fees.sharedContracts).toBe(1);
    expect((await callErr(core, S, 'cases.close', { id: ids.commercialId, outcome: 'صلح' })).code).toBe('VALIDATION');
    await call(core, S, 'cases.close', { id: ids.commercialId, outcome: 'انتهى النزاع صلحًا (خيالي)', confirm: true });
    await call(core, S, 'cases.setArchived', { id: ids.commercialId, archived: true, reason: 'انتهاء العمل' });
    expect((await call(core, S, 'cases.list', {})).map((c: any) => c.id)).not.toContain(ids.commercialId);
    expect((await call(core, S, 'cases.list', { archived: 'archived' })).map((c: any) => c.id)).toContain(ids.commercialId);
    const w = await callErr(core, S, 'hearings.create', { caseId: ids.commercialId, stageId: (await call(core, S, 'cases.get', { id: ids.commercialId })).stages[0].id, date: '2026-12-01', time: '09:00' });
    expect(w.code).toBe('CONFLICT');
    await call(core, S, 'cases.setArchived', { id: ids.commercialId, archived: false });
    await call(core, S, 'cases.reopen', { id: ids.commercialId, reason: 'استئناف الخصم' });
    const c = await call(core, S, 'cases.get', { id: ids.commercialId });
    expect(c.case.status).toBe('open');
    expect(c.case.outcome).toBe('انتهى النزاع صلحًا (خيالي)');
    const tl = await call(core, S, 'cases.timeline', { id: ids.commercialId });
    expect(tl.filter((e: any) => ['close', 'reopen', 'archive'].includes(e.kind)).length).toBe(4);
  });
});
