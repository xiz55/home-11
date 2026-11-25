// الاستشارات والاجتماعات والتقرير الشامل للمكتب — ببيانات خيالية معزولة في مساحة بيانات مؤقتة.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { AppCore } from '../../src/main/core';
import { Db } from '../../src/main/db/db';
import { MIGRATIONS, migrate, currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations';
import { renderOfficeReportHtml, officeReportSheets } from '../../src/main/services/officeReport';
import { buildXlsx, halalasToDecimal } from '../../src/main/services/xlsx';
import { call, callErr, makeCore, makeDocx, makePdf, seedCompany, setupOwner, stageAndAttach, CONSULTANT, tmpDir } from './helpers';

function readZip(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, string>();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) return reject(e2);
          const chunks: Buffer[] = [];
          rs.on('data', (c) => chunks.push(c));
          rs.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

describe('الاستشارات والاجتماعات والتقرير الشامل', () => {
  const env = makeCore();
  const { core, platform, dir, clock } = env;
  let s = '';
  let ownerId = '';
  let consultantId = '';
  const S2 = 'S-consultant';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  const files = path.join(dir, 'outside');
  fs.mkdirSync(files, { recursive: true });
  let personId = '';
  let phoneConsult = '';
  let freeConsult = '';
  let meetingId = '';

  beforeAll(async () => {
    s = (await setupOwner(core)).session;
    ownerId = (await call(core, s, 'auth.me')).id;
    ids = await seedCompany(core, s);
    consultantId = (await call(core, s, 'users.create', { ...CONSULTANT, permissions: ['consultations.manage'] })).id;
    await call(core, S2, 'auth.login', { username: CONSULTANT.username, password: CONSULTANT.password });
  });

  it('1) يسجل طالب استشارة جديدًا دون قضية أو وكالة أو عقد، ويُعرف بأنه «طالب استشارة فقط»', async () => {
    const r = await call(core, s, 'consultations.create', {
      newContact: { kind: 'individual', name: 'طالب استشارة خيالي', phone: '0551112233', email: 'seeker@example.test' },
      title: 'استفسار عن مكافأة نهاية الخدمة',
      category: 'عمالي',
      description: 'موظف سابق يسأل عن احتساب المكافأة (وقائع خيالية).',
      questions: 'هل تحتسب الإجازات غير المستخدمة؟',
      method: 'phone',
      date: '2026-11-25',
      time: '10:00',
      durationMin: 30,
      responsibleUserId: ownerId,
      feeMode: 'paid',
      feeAmount: 50000,
      status: 'confirmed',
    });
    phoneConsult = r.id;
    expect(r.refNo).toMatch(/^CON-2026\/0001$/);
    const c = await call(core, s, 'consultations.get', { id: r.id });
    personId = c.consultation.clientId;
    expect(c.consultation.caseId).toBeNull();
    expect(c.consultation.endTime).toBe('10:30');
    const profile = await call(core, s, 'clients.get', { id: personId });
    expect(profile.relation).toBe('consultation_only');
    expect(profile.cases).toHaveLength(0);
    expect(profile.contracts).toHaveLength(0);
    expect(profile.client.clientNo).toMatch(/^\d{5}$/);
    const list = await call(core, s, 'clients.list', { relation: 'consultation_only' });
    expect(list.map((x: any) => x.id)).toEqual([personId]);
  });

  it('1b) لا يدمج تلقائيًا: جوال مطابق يُنبَّه عليه ويُعرض السجل الصحيح للاختيار', async () => {
    const err = await callErr(core, s, 'consultations.create', {
      newContact: { kind: 'individual', name: 'اسم مختلف تمامًا', phone: '+966 55 111 2233' },
      title: 'استشارة ثانية',
      method: 'phone',
      date: '2026-11-26',
      time: '11:00',
      durationMin: 30,
    });
    expect(err.code).toBe('DUPLICATE');
    expect((err.extra as any).matches[0].id).toBe(personId);
    const before = (await call(core, s, 'clients.list', {})).length;
    // اختيار السجل الموجود بدل إنشاء شخص مكرر
    await call(core, s, 'consultations.create', { clientId: personId, title: 'متابعة الاستفسار', method: 'phone', date: '2026-11-26', time: '11:00', durationMin: 20, feeMode: 'free' });
    expect((await call(core, s, 'clients.list', {})).length).toBe(before);
  });

  it('2) استشارة هاتفية مدفوعة ودفعة جزئية: حالة الموعد مستقلة عن السداد', async () => {
    await call(core, s, 'serviceTxns.create', { consultationId: phoneConsult, kind: 'payment', amount: 20000, txnOn: '2026-11-24', method: 'تحويل بنكي', referenceNo: 'TRX-1' });
    let c = await call(core, s, 'consultations.get', { id: phoneConsult });
    expect(c.consultation.finance).toMatchObject({ due: 50000, paid: 20000, netPaid: 20000, remaining: 30000, status: 'partial' });
    expect(c.consultation.status).toBe('confirmed');
    // تمت الاستشارة ويبقى المبلغ غير مسدد بالكامل
    const g = c.consultation;
    await call(core, s, 'consultations.update', { id: phoneConsult, clientId: personId, title: g.title, category: g.category, description: g.description, questions: g.questions, method: g.method, date: g.date, time: g.time, durationMin: g.durationMin, responsibleUserId: ownerId, feeMode: 'paid', feeAmount: 50000, status: 'done', writtenRequired: true });
    c = await call(core, s, 'consultations.get', { id: phoneConsult });
    expect(c.consultation.status).toBe('done');
    expect(c.consultation.finance.status).toBe('partial');
    expect(c.changes.some((x: any) => x.field === 'الحالة' && x.newValue === 'تمت الاستشارة')).toBe(true);
  });

  it('3) يرفق PDF وWord ويحفظ استشارة مكتوبة معدلة مع بقاء السابقة، والاعتماد لا يعني التسليم', async () => {
    const pdf = makePdf(path.join(files, 'seeker-id.pdf'), 'Seeker document');
    const docx = await makeDocx(path.join(files, 'seeker-letter.docx'), ['خطاب إنهاء الخدمة الخيالي']);
    await stageAndAttach(core, platform, s, pdf, { title: 'مستند مقدم من المستفيد', category: 'consultation_doc', consultationId: phoneConsult });
    await stageAndAttach(core, platform, s, docx, { title: 'خطاب الإنهاء', category: 'consultation_doc', consultationId: phoneConsult });
    const opinionFile = await makeDocx(path.join(files, 'opinion-v1.docx'), ['الرأي القانوني — النسخة الأولى']);
    const od = await stageAndAttach(core, platform, s, opinionFile, { title: 'الاستشارة المكتوبة', category: 'legal_opinion', consultationId: phoneConsult });
    const op = await call(core, s, 'opinions.create', { consultationId: phoneConsult, title: 'الرأي القانوني في المكافأة', opinionDate: '2026-11-25', authorName: 'المالك التجريبي', body: 'النص الأول للرأي.', documentId: od.id, status: 'draft' });
    // نسخة معدلة من الملف تحفظ النسخة السابقة
    const v2 = await makeDocx(path.join(files, 'opinion-v2.docx'), ['الرأي القانوني — النسخة المعدلة']);
    platform.openQueue.push(v2);
    const st = await call(core, s, 'documents.pickFile', {});
    await call(core, s, 'documents.addVersion', { documentId: od.id, token: st.token, note: 'تعديل بعد المراجعة' });
    await call(core, s, 'opinions.update', { id: op.id, title: 'الرأي القانوني في المكافأة', opinionDate: '2026-11-25', authorName: 'المالك التجريبي', body: 'النص المعدل للرأي.', documentId: od.id, status: 'approved', note: 'اعتماد داخلي', baseRevision: 1 });
    let g = await call(core, s, 'consultations.get', { id: phoneConsult });
    const o = g.opinions[0];
    expect(o.status).toBe('approved');
    expect(o.deliveredOn).toBeNull();
    expect(o.revisions.map((r: any) => r.revision)).toEqual([2, 1]);
    const old = await call(core, s, 'opinions.revision', { id: o.revisions[1].id });
    expect(old.body).toBe('النص الأول للرأي.');
    const doc = await call(core, s, 'documents.get', { id: od.id });
    expect(doc.versions).toHaveLength(2);
    const docs = await call(core, s, 'documents.list', { consultationId: phoneConsult });
    expect(docs).toHaveLength(3);
    // لا يُسجل التسليم عبر تغيير الحالة
    expect((await callErr(core, s, 'opinions.update', { id: op.id, title: 'x', body: 'y', status: 'delivered', baseRevision: 2 })).code).toBe('VALIDATION');
    await call(core, s, 'opinions.deliver', { id: op.id, deliveredOn: '2026-11-26', deliveryMethod: 'بريد إلكتروني' });
    g = await call(core, s, 'consultations.get', { id: phoneConsult });
    expect(g.opinions[0]).toMatchObject({ status: 'delivered', deliveredOn: '2026-11-26', deliveryMethod: 'بريد إلكتروني' });
    expect((await callErr(core, s, 'opinions.update', { id: op.id, title: 'x', body: 'y', status: 'draft', baseRevision: 3 })).code).toBe('CONFLICT');
  });

  it('4) استشارة حضورية مجانية صراحة لا تظهر كمتأخرات', async () => {
    const r = await call(core, s, 'consultations.create', {
      clientId: ids.clientId,
      title: 'استشارة حضورية مجانية',
      method: 'in_person',
      location: 'مقر المكتب',
      date: '2026-11-27',
      time: '13:00',
      durationMin: 45,
      responsibleUserId: ownerId,
      feeMode: 'free',
      status: 'confirmed',
    });
    freeConsult = r.id;
    const c = await call(core, s, 'consultations.get', { id: r.id });
    expect(c.consultation.finance).toMatchObject({ due: 0, remaining: 0, status: 'free' });
    const unpaid = await call(core, s, 'consultations.list', { payStatus: 'unpaid' });
    expect(unpaid.find((x: any) => x.id === r.id)).toBeUndefined();
  });

  it('6) التعارض: يُنبَّه عند تداخل موعد للمسؤول نفسه مع استشارة أو جلسة، ويُتاح التأكيد صراحة', async () => {
    const base = { title: 'اجتماع مراجعة عقد التوريد', purpose: 'مراجعة مسودة عقد', clientId: ids.clientId, caseId: ids.commercialId, method: 'video', meetingLink: 'رابط اجتماع داخلي', participants: [{ name: 'ممثل خيالي', role: 'المدير التنفيذي' }, { name: 'المالك التجريبي', role: 'المحامي' }], responsibleUserId: ownerId, date: '2026-11-27', startTime: '13:30', endTime: '14:30', agenda: '1- بنود الدفع\n2- الضمانات', status: 'confirmed' };
    const err = await callErr(core, s, 'meetings.create', base);
    expect(err.code).toBe('CONFLICT');
    expect((err.extra as any).conflicts[0]).toMatchObject({ kind: 'consultation', id: freeConsult });
    // جلسة قضائية للقضية التي مسؤولها المالك
    const cs = await call(core, s, 'cases.get', { id: ids.laborId });
    await call(core, s, 'cases.update', { ...cs.case, id: ids.laborId, responsibleUserId: ownerId });
    await call(core, s, 'hearings.create', { caseId: ids.laborId, stageId: cs.stages[0].id, date: '2026-11-30', time: '09:00', status: 'scheduled' });
    const chk = await call(core, s, 'appointments.conflicts', { responsibleUserId: ownerId, date: '2026-11-30', startTime: '09:30', durationMin: 30 });
    expect(chk.map((x: any) => x.kind)).toContain('hearing');
    const r = await call(core, s, 'meetings.create', { ...base, confirmConflicts: true });
    meetingId = r.id;
    expect(r.refNo).toMatch(/^MTG-2026\//);
    const act = await call(core, s, 'activity.list', {});
    expect(act.some((a: any) => a.summary.includes('مع تأكيد تعارض موعد'))).toBe(true);
  });

  it('5) محضر الاجتماع وتحويل قرار إلى مهمة مرتبطة بالاجتماع', async () => {
    const m = (await call(core, s, 'meetings.get', { id: meetingId })).meeting;
    await call(core, s, 'meetings.update', { ...m, id: meetingId, clientId: ids.clientId, status: 'held', minutes: 'ناقش الحضور بنود الدفع واتفقوا على مراجعة الضمانات.', confirmConflicts: true, feeAmount: null });
    const d = await call(core, s, 'meetingItems.save', { meetingId, kind: 'decision', text: 'إعداد مسودة ملحق للضمانات' });
    await call(core, s, 'meetingItems.save', { meetingId, kind: 'recommendation', text: 'طلب كشف حساب المورد' });
    const t = await call(core, s, 'meetingItems.toTask', { itemId: d.id, title: 'إعداد مسودة ملحق الضمانات', assigneeUserId: ownerId, dueDate: '2026-12-02', priority: 'high' });
    const g = await call(core, s, 'meetings.get', { id: meetingId });
    expect(g.meeting.hasMinutes).toBe(true);
    expect(g.items.find((i: any) => i.id === d.id).taskId).toBe(t.id);
    expect(g.tasks).toHaveLength(1);
    const tasks = await call(core, s, 'tasks.list', { meetingId });
    expect(tasks[0]).toMatchObject({ id: t.id, meetingId, caseId: ids.commercialId });
    expect((await callErr(core, s, 'meetingItems.toTask', { itemId: d.id, title: 'مكرر' })).code).toBe('CONFLICT');
  });

  it('6b) تظهر الاستشارات والاجتماعات في التقويم العام ولوحة القسم مميزة عن الجلسات', async () => {
    const ev = await call(core, s, 'calendar.events', { from: '2026-11-24', to: '2026-12-05' });
    const kinds = new Set(ev.map((e: any) => e.kind));
    expect(kinds.has('consultation')).toBe(true);
    expect(kinds.has('meeting')).toBe(true);
    expect(kinds.has('hearing')).toBe(true);
    expect(ev.find((e: any) => e.id === meetingId).title).toMatch(/^اجتماع:/);
    expect(ev.find((e: any) => e.id === phoneConsult).title).toMatch(/^استشارة:/);
    const ov = await call(core, s, 'appointments.overview', {});
    expect(ov.counts.consultationsDone).toBe(1);
    expect(ov.counts.consultationsUnpaid).toBe(1);
    const found = await call(core, s, 'consultations.list', { q: '0551112233' });
    expect(found.map((x: any) => x.id)).toContain(phoneConsult);
    expect((await call(core, s, 'consultations.list', { q: 'CON-2026/0001' }))[0].id).toBe(phoneConsult);
    const sr = await call(core, s, 'search.global', { q: 'الضمانات' });
    expect(sr.hits.some((h: any) => h.type === 'meeting' && h.id === meetingId)).toBe(true);
  });

  it('7) ربط طالب الاستشارة بقضية لاحقًا دون تكرار الشخص أو المبالغ، مع تسوية واضحة', async () => {
    const before = (await call(core, s, 'clients.list', {})).length;
    const kase = await call(core, s, 'cases.create', { clientId: personId, title: 'مطالبة مكافأة نهاية الخدمة (خيالية)', caseType: 'عمالية', openedOn: '2026-11-28', responsibleUserId: ownerId, parties: [{ name: 'جهة عمل خيالية', isOpponent: true }] });
    const k = await call(core, s, 'contracts.create', { clientId: personId, kind: 'fee', title: 'عقد أتعاب المطالبة', scope: 'المطالبة العمالية', feeType: 'fixed', fixedAmount: 300000, signedOn: '2026-11-28', caseIds: [kase.id] });
    // المبلغ أكبر من المسدد غير المحتسب يُرفض
    expect((await callErr(core, s, 'consultations.linkCase', { id: phoneConsult, caseId: kase.id, credit: { contractId: k.id, amount: 30000, reason: 'x', adjustedOn: '2026-11-28' } })).code).toBe('VALIDATION');
    await call(core, s, 'consultations.linkCase', { id: phoneConsult, caseId: kase.id, credit: { contractId: k.id, amount: 20000, reason: 'احتساب ما دُفع للاستشارة من أتعاب القضية', adjustedOn: '2026-11-28' } });
    expect((await call(core, s, 'clients.list', {})).length).toBe(before);
    const p = await call(core, s, 'clients.get', { id: personId });
    expect(p.relation).toBe('both');
    expect(p.consultations.map((x: any) => x.id)).toContain(phoneConsult);
    const kt = (await call(core, s, 'contracts.get', { id: k.id })).contract.totals;
    expect(kt).toMatchObject({ agreed: 300000, adjustments: 20000, paid: 0, remaining: 280000 });
    const c = await call(core, s, 'consultations.get', { id: phoneConsult });
    expect(c.consultation.caseId).toBe(kase.id);
    expect(c.consultation.finance).toMatchObject({ netPaid: 20000, credited: 20000, remaining: 30000 });
    expect(c.credits[0]).toMatchObject({ amount: 20000, contractId: k.id });
    // لا يُلغى دفع محتسب ضمن تسوية قبل إلغاء التسوية
    const tx = c.transactions.find((t: any) => t.kind === 'payment');
    expect((await callErr(core, s, 'serviceTxns.void', { id: tx.id, reason: 'تجربة' })).code).toBe('CONFLICT');
  });

  it('8-10) التقرير الشامل يطابق السجلات، ويحسب العقد الشامل مرة واحدة، ويُظهر أثر الاسترداد والتسوية والأقساط غير الحالة', async () => {
    // عقد الشركة الشامل (100,000) مع أقساط: 40,000 حلّ، و60,000 بعد نهاية التقرير
    await call(core, s, 'feeItems.save', { contractId: ids.contractId, title: 'القسط الأول', amount: 4000000, dueDate: '2026-03-01' });
    await call(core, s, 'feeItems.save', { contractId: ids.contractId, title: 'القسط الثاني', amount: 6000000, dueDate: '2027-03-01' });
    await call(core, s, 'payments.create', { contractId: ids.contractId, amount: 5000000, paidOn: '2026-03-05', method: 'تحويل بنكي', referenceNo: 'R-77' });
    await call(core, s, 'adjustments.create', { contractId: ids.contractId, kind: 'refund', amount: 1000000, adjustedOn: '2026-04-01', reason: 'رد مبلغ زائد بالخطأ' });
    await call(core, s, 'adjustments.create', { contractId: ids.contractId, kind: 'discount', amount: 500000, adjustedOn: '2026-04-02', reason: 'خصم متفق عليه' });
    // أتعاب نسبية مشروطة لم تتحقق — لا تُحتسب
    const r = await call(core, s, 'reports.office', { mode: 'asOf', asOf: '2026-11-30' });
    expect(r.meta).toMatchObject({ title: 'التقرير الشامل للمكتب', confidential: 'تقرير داخلي — سري', end: '2026-11-30', generatedBy: 'المالك التجريبي' });
    const item = (g: string, l: string) => r.summary.find((x: any) => x.title === g).items.find((i: any) => i.label === l).value;
    expect(item('العملاء', 'العملاء وجهات الاتصال الفريدون')).toBe(2);
    expect(item('العملاء', 'طالبو استشارة فقط')).toBe(0); // أصبح له قضية
    expect(item('العملاء', 'عملاء قضايا')).toBe(2);
    expect(item('القضايا والجلسات', 'إجمالي القضايا')).toBe(3);
    expect(item('الاستشارات', 'عدد الاستشارات')).toBe(3);
    expect(item('الاستشارات', 'المنجزة')).toBe(1);
    expect(item('الاجتماعات', 'المنعقدة')).toBe(1);
    const fin = r.sections.find((x: any) => x.key === 'finance');
    const company = fin.rows.find((x: any) => x.link.id === ids.clientId).cells;
    // العقد الشامل لقضيتين يُحسب مرة واحدة
    expect(company.contractValue).toBe(10000000);
    expect(company.feesDue).toBe(4000000); // القسط الذي حلّ فقط
    expect(company.notYetDue).toBe(6000000);
    expect(company.received).toBe(5000000);
    expect(company.refunds).toBe(1000000);
    expect(company.net).toBe(4000000);
    expect(company.discounts).toBe(500000);
    // المستحق 40,000 − خصم 5,000 − صافي 40,000 = −5,000 رصيد دائن، والمتبقي صفر
    expect(company.remaining).toBe(0);
    expect(company.credit).toBe(500000);
    expect(company.notes).toContain('مشروطة');
    const person = fin.rows.find((x: any) => x.link.id === personId).cells;
    expect(person.consultFees).toBe(50000); // المجانية لا تضيف شيئًا
    expect(person.contractValue).toBe(300000);
    expect(person.discounts).toBe(20000); // تسوية الاستشارة غير نقدية
    expect(person.received).toBe(20000); // دفعة الاستشارة مرة واحدة فقط
    expect(person.remaining).toBe(30000 + 280000);
    const caseRows = r.sections.find((x: any) => x.key === 'cases').rows;
    expect(caseRows).toHaveLength(3);
    const labor = caseRows.find((x: any) => x.link.id === ids.laborId).cells;
    expect(labor).toMatchObject({ officialNo: '4470001234', court: 'المحكمة العمالية التجريبية — الدائرة 3' });
    expect(caseRows.find((x: any) => x.link.id === ids.commercialId).cells.outcome).toBe('—');
    const cons = r.sections.find((x: any) => x.key === 'consultations').rows.find((x: any) => x.link.id === phoneConsult).cells;
    expect(cons).toMatchObject({ opinion: 'سُلّمت للمستفيد', delivered: '2026-11-26', amount: 50000, paid: 20000, remaining: 30000 });
    // بالمرشح: الاستشارات فقط وعميل محدد
    const only = await call(core, s, 'reports.office', { mode: 'period', from: '2026-11-01', to: '2026-11-30', serviceType: 'consultations', clientId: personId });
    expect(only.sections.find((x: any) => x.key === 'cases')).toBeUndefined();
    expect(only.sections.find((x: any) => x.key === 'consultations').rows).toHaveLength(2);
    // تقرير بتاريخ سابق لا يُدرج ما سُجل بعده كمستحق
    const early = await call(core, s, 'reports.office', { mode: 'asOf', asOf: '2026-02-15' });
    const ef = early.sections.find((x: any) => x.key === 'finance').rows.find((x: any) => x.link.id === ids.clientId).cells;
    expect(ef.feesDue).toBe(0);
    expect(ef.received).toBe(0);
    const alerts = r.sections.find((x: any) => x.key === 'alerts').rows.map((x: any) => x.cells.category);
    expect(alerts).toContain('استشارة برصيد غير مسدد');
    const act = await call(core, s, 'activity.list', {});
    expect(act.some((a: any) => a.action === 'report' && a.summary.includes('التقرير الشامل'))).toBe(true);
  });

  it('11) تصدير PDF وExcel: عربية سليمة، «غير مسجل» بدل الصفر، أرقام عشرية دقيقة، رؤوس مكررة، وتسجيل التصدير', async () => {
    const r = await call(core, s, 'reports.office', { mode: 'asOf', asOf: '2026-11-30' });
    const html = renderOfficeReportHtml(r);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('تقرير داخلي — سري');
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('غير مسجل');
    expect(html).toContain('100,000.00 ر.س');
    expect(html.slice(html.indexOf('</style>'))).not.toContain('NaN');
    const xbuf = await buildXlsx(officeReportSheets(r), { title: r.meta.title, createdAt: r.meta.generatedAt });
    const z = await readZip(xbuf);
    expect(z.has('xl/workbook.xml')).toBe(true);
    expect(z.get('xl/workbook.xml')).toContain('_xlnm.Print_Titles');
    const sheets = [...z.keys()].filter((k) => k.startsWith('xl/worksheets/'));
    expect(sheets.length).toBe(1 + r.sections.length);
    const all = sheets.map((k) => z.get(k)!).join('');
    expect(all).toContain('rightToLeft="1"');
    expect(all).toContain('شركة المثال التجريبية');
    expect(all).toContain('<v>100000.00</v>');
    expect(halalasToDecimal(5)).toBe('0.05');
    expect(halalasToDecimal(-123456)).toBe('-1234.56');
    platform.saveQueue.push(path.join(dir, 'office.xlsx'));
    const ex = await call(core, s, 'reports.officeExport', { mode: 'asOf', asOf: '2026-11-30', format: 'xlsx' });
    expect(ex.saved).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'office.xlsx')).subarray(0, 2).toString()).toBe('PK');
    platform.saveQueue.push(path.join(dir, 'office'));
    const pdf = await call(core, s, 'reports.officeExport', { mode: 'asOf', asOf: '2026-11-30', format: 'pdf' });
    expect(pdf.path.endsWith('.pdf')).toBe(true);
    const act = await call(core, s, 'activity.list', {});
    expect(act.filter((a: any) => a.action === 'export' && a.summary.includes('التقرير الشامل')).length).toBeGreaterThanOrEqual(2);
  });

  it('12) الصلاحيات في طبقة البيانات: المستشار لا يرى استشارات غيره ولا يتسرب شيء عبر التقرير أو المستندات', async () => {
    // المستشار ينشئ استشارته الخاصة (يملك صلاحية إدارة الاستشارات) دون مبلغ لأنه لا يملك صلاحية الأتعاب
    const own = await call(core, S2, 'consultations.create', { newContact: { name: 'مستفيد المستشار الخيالي', phone: '0569990000' }, title: 'استشارة المستشار', method: 'video', date: '2026-12-01', time: '09:00', durationMin: 30, responsibleUserId: consultantId, feeMode: 'paid', feeAmount: 99900 });
    const mine = await call(core, S2, 'consultations.list', {});
    expect(mine.map((x: any) => x.id)).toEqual([own.id]);
    expect(mine[0].finance).toBeNull();
    expect(mine[0].amountsHidden).toBe(true);
    const ownerView = await call(core, s, 'consultations.get', { id: own.id });
    expect(ownerView.consultation.finance.status).toBe('not_set'); // المبلغ لم يُحفظ لمن لا يملك الصلاحية
    expect((await callErr(core, S2, 'consultations.get', { id: phoneConsult })).code).toBe('FORBIDDEN');
    expect((await callErr(core, S2, 'meetings.get', { id: meetingId })).code).toBe('FORBIDDEN');
    const docs = await call(core, s, 'documents.list', { consultationId: phoneConsult });
    expect((await callErr(core, S2, 'documents.get', { id: docs[0].id })).code).toBe('FORBIDDEN');
    expect((await callErr(core, S2, 'documents.readBytes', { versionId: docs[0].current.id })).code).toBe('FORBIDDEN');
    const ev = await call(core, S2, 'calendar.events', { from: '2026-11-24', to: '2026-12-05' });
    expect(ev.filter((e: any) => e.kind === 'consultation' || e.kind === 'meeting').map((e: any) => e.id)).toEqual([own.id]);
    const sr = await call(core, S2, 'search.global', { q: 'الضمانات' });
    expect(sr.hits).toHaveLength(0);
    // التقرير الشامل غير متاح دون صلاحية، والتصدير يحتاج صلاحية منفصلة
    expect((await callErr(core, S2, 'reports.office', {})).code).toBe('FORBIDDEN');
    await call(core, s, 'users.update', { id: consultantId, displayName: CONSULTANT.displayName, active: true, permissions: ['consultations.manage', 'reports.office'] });
    const rep = await call(core, S2, 'reports.office', { mode: 'asOf', asOf: '2026-12-31' });
    expect(rep.meta.scopeLimited).toBe(true);
    expect(rep.sections.find((x: any) => x.key === 'finance')).toBeUndefined();
    const names = rep.sections.find((x: any) => x.key === 'clients').rows.map((x: any) => x.cells.name);
    expect(names).toEqual(['مستفيد المستشار الخيالي']);
    expect(rep.summary.find((x: any) => x.title === 'العملاء').items[0].value).toBe(1);
    expect(JSON.stringify(rep)).not.toContain('شركة المثال');
    expect((await callErr(core, S2, 'reports.office', { includeSensitive: true })).code).toBe('FORBIDDEN');
    expect((await callErr(core, S2, 'reports.officeExport', { format: 'xlsx' })).code).toBe('FORBIDDEN');
    // تذكيرات الاستشارات لا تظهر لغير المخول
    clock.advance(4 * 86400_000);
    await call(core, S2, 'auth.unlock', { password: CONSULTANT.password });
    await call(core, s, 'auth.unlock', { password: 'Owner#Pass2026' });
    const missed = await call(core, S2, 'reminders.missed', {});
    expect(missed.every((m: any) => m.entityType !== 'consultation' || m.entityId === own.id)).toBe(true);
  });

  it('12b) الحفظ بعد إعادة التشغيل، والنسخ الاحتياطي والاستعادة يشملان الاستشارات والاجتماعات ومرفقاتها ودفعاتها', async () => {
    const dataDir = core.paths.dataDir;
    platform.saveQueue.push(path.join(dir, 'b.lobk'));
    const b = await call(core, s, 'backup.create', {});
    expect(b.saved ?? true).toBeTruthy();
    core.shutdown();
    const re = new AppCore(dataDir, platform, clock.now);
    await call(re, 'S-r', 'auth.login', { username: 'owner', password: 'Owner#Pass2026' });
    const g = await call(re, 'S-r', 'consultations.get', { id: phoneConsult });
    expect(g.opinions[0].status).toBe('delivered');
    expect(g.transactions.length).toBe(1);
    re.shutdown();
    // استعادة في مساحة جديدة
    const fresh = makeCore(tmpDir(), clock);
    await setupOwner(fresh.core, 'S-f');
    fresh.platform.openQueue.push(path.join(dir, 'b.lobk'));
    const ins = await call(fresh.core, 'S-f', 'backup.inspectRestore', {});
    expect(ins.ok).toBe(true);
    expect(ins.manifest.counts.consultations).toBe(4);
    expect(ins.manifest.counts.meetings).toBe(1);
    expect(ins.manifest.counts.service_txns).toBe(1);
    await call(fresh.core, 'S-f', 'backup.applyRestore', { token: ins.token, confirm: true });
    await call(fresh.core, 'S-g', 'auth.login', { username: 'owner', password: 'Owner#Pass2026' });
    const rg = await call(fresh.core, 'S-g', 'consultations.get', { id: phoneConsult });
    expect(rg.opinions[0].revisions).toHaveLength(3);
    const rdocs = await call(fresh.core, 'S-g', 'documents.list', { consultationId: phoneConsult });
    expect(rdocs).toHaveLength(3);
    const bytes = await call(fresh.core, 'S-g', 'documents.readBytes', { versionId: rdocs.find((d: any) => d.current.ext === 'pdf').current.id });
    expect(bytes.bytes.byteLength).toBeGreaterThan(100);
    const mt = await call(fresh.core, 'S-g', 'meetings.get', { id: meetingId });
    expect(mt.items).toHaveLength(2);
    fresh.core.shutdown();
  });
});

describe('ترحيل قاعدة قائمة إلى بنية الاستشارات دون فقد السجلات أو المرفقات', () => {
  it('ينقل المستندات وروابطها ويضيف أرقام العملاء ويأخذ لقطة متسقة قبل الترقية', async () => {
    const { core, platform, dir } = makeCore();
    const s = (await setupOwner(core)).session;
    const ids = await seedCompany(core, s);
    const pdf = makePdf(path.join(dir, 'm.pdf'), 'Legacy doc');
    const d = await stageAndAttach(core, platform, s, pdf, { title: 'مستند قديم', category: 'minutes', clientId: ids.clientId, caseId: ids.laborId });
    const dataDir = core.paths.dataDir;
    core.shutdown();
    // نعيد القاعدة إلى بنية الإصدار 2 بحذف إضافات الإصدار 3 ثم نشغّل البرنامج من جديد
    const db = new Db(path.join(dataDir, 'office.sqlite'));
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`DROP TABLE opinion_revisions; DROP TABLE consultation_opinions; DROP TABLE meeting_items; DROP TABLE appointment_changes;
      CREATE TABLE documents_v2 AS SELECT id, title, description, category, doc_date, hijri_text, hijri_source, client_id, case_id, stage_id, hearing_id, judgment_id, memo_id, contract_id, poa_id, payment_id, status, is_internal, current_version, archived_at, created_by, created_at, updated_by, updated_at FROM documents;`);
    db.exec(`DROP TABLE documents;`);
    db.exec(MIGRATIONS[0].sql.slice(MIGRATIONS[0].sql.indexOf('CREATE TABLE documents ('), MIGRATIONS[0].sql.indexOf('CREATE INDEX idx_documents_client')));
    db.exec(`INSERT INTO documents SELECT * FROM documents_v2; DROP TABLE documents_v2; DROP TABLE service_txns; DROP TABLE contract_adjustments;
      ALTER TABLE tasks DROP COLUMN consultation_id; ALTER TABLE tasks DROP COLUMN meeting_id; DROP TABLE meetings; DROP TABLE consultations;
      ALTER TABLE fee_items DROP COLUMN item_kind; ALTER TABLE fee_items DROP COLUMN basis; DROP INDEX idx_clients_no; ALTER TABLE clients DROP COLUMN client_no;
      DELETE FROM schema_migrations WHERE version >= 3;
      DROP TABLE sync_state; DROP TABLE sync_flags; DROP TABLE sync_outbox; DROP TABLE sync_inflight; DROP TABLE sync_meta; DROP TABLE sync_conflicts;
      DROP TABLE sync_rejected; DROP TABLE sync_blobs; DROP TABLE number_blocks;`);
    expect(currentSchemaVersion(db)).toBe(2);
    db.close();
    const before = fs.readdirSync(path.join(dataDir, 'backups', 'auto')).filter((f) => f.startsWith('قبل-الترقية'));
    expect(before).toHaveLength(0);
    const re = new AppCore(dataDir, platform);
    expect(currentSchemaVersion(re.db)).toBe(LATEST_SCHEMA_VERSION);
    const snaps = fs.readdirSync(path.join(dataDir, 'backups', 'auto')).filter((f) => f.startsWith('قبل-الترقية-بنية2'));
    expect(snaps).toHaveLength(1);
    const snapDb = new Db(path.join(dataDir, 'backups', 'auto', snaps[0]), { readOnly: true });
    expect(currentSchemaVersion(snapDb)).toBe(2);
    snapDb.close();
    await call(re, 'S2', 'auth.login', { username: 'owner', password: 'Owner#Pass2026' });
    const doc = await call(re, 'S2', 'documents.get', { id: d.id });
    expect(doc.document).toMatchObject({ caseId: ids.laborId, clientId: ids.clientId, category: 'minutes' });
    const bytes = await call(re, 'S2', 'documents.readBytes', { versionId: d.versionId });
    expect(bytes.bytes.byteLength).toBeGreaterThan(100);
    const cl = await call(re, 'S2', 'clients.get', { id: ids.clientId });
    expect(cl.client.clientNo).toBe('00001');
    expect(re.db.all('PRAGMA foreign_key_check')).toHaveLength(0);
    re.shutdown();
  });
});
