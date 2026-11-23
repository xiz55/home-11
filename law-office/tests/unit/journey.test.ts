// رحلة القبول على مستوى الخدمات (عبر مُرسل الأوامر نفسه الذي تستخدمه الواجهة).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { call, callErr, makeCore, makeDocx, makePdf, seedCompany, setupOwner, stageAndAttach } from './helpers';

describe('رحلة المكتب الكاملة ببيانات خيالية', () => {
  const env = makeCore();
  const { core, platform, dir } = env;
  let s = '';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  const files = path.join(dir, 'outside');
  fs.mkdirSync(files, { recursive: true });

  beforeAll(async () => {
    s = (await setupOwner(core)).session;
    ids = await seedCompany(core, s);
  });

  it('ينشئ الشركة والقضيتين مرتبطتين بالعقد والوكالة نفسيهما دون تكرار', async () => {
    const k = await call(core, s, 'contracts.get', { id: ids.contractId });
    expect(k.contract.cases.map((c: any) => c.id).sort()).toEqual([ids.laborId, ids.commercialId].sort());
    const poas = await call(core, s, 'poas.list', { clientId: ids.clientId });
    expect(poas).toHaveLength(1);
    expect(poas[0].cases).toHaveLength(2);
    const laborContracts = await call(core, s, 'contracts.list', { caseId: ids.laborId });
    const commContracts = await call(core, s, 'contracts.list', { caseId: ids.commercialId });
    expect(laborContracts[0].id).toBe(commContracts[0].id);
    expect(laborContracts[0].sharedAcrossCases).toBe(true);
  });

  let h1 = '';
  let h2 = '';
  let firstStage = '';
  it('يضيف جلستين للقضية العمالية مع ضبط لكل جلسة، ومذكرة مسودة ثم سجل تقديم، وحكمًا ومرحلة استئناف', async () => {
    const c = await call(core, s, 'cases.get', { id: ids.laborId });
    firstStage = c.stages[0].id;
    h1 = (await call(core, s, 'hearings.create', { caseId: ids.laborId, stageId: firstStage, date: '2026-03-01', time: '09:30', status: 'held', summary: 'الجلسة الأولى — قدّم المدعي لائحته', outcome: 'التأجيل للرد' })).id;
    h2 = (await call(core, s, 'hearings.create', { caseId: ids.laborId, stageId: firstStage, date: '2026-04-05', time: '10:00', status: 'held', summary: 'الجلسة الثانية — طلبت المحكمة كشف الرواتب', previousHearingId: h1 })).id;
    const m1 = makePdf(path.join(files, 'minutes-1.pdf'), 'Minutes of hearing one');
    const m2 = makePdf(path.join(files, 'minutes-2.pdf'), 'Minutes of hearing two');
    await stageAndAttach(core, platform, s, m1, { title: 'ضبط الجلسة الأولى', category: 'minutes', clientId: ids.clientId, caseId: ids.laborId, hearingId: h1 });
    await stageAndAttach(core, platform, s, m2, { title: 'ضبط الجلسة الثانية', category: 'minutes', clientId: ids.clientId, caseId: ids.laborId, hearingId: h2 });
    const prev = await call(core, s, 'hearings.get', { id: h1 });
    expect(prev.next?.id).toBe(h2);

    const memo = await call(core, s, 'memos.create', { caseId: ids.laborId, stageId: firstStage, hearingId: h2, title: 'مذكرة جوابية', memoType: 'reply', body: 'نص المذكرة الجوابية الخيالي' });
    await call(core, s, 'memos.setStatus', { id: memo.id, status: 'approved' });
    let mm = await call(core, s, 'memos.get', { id: memo.id });
    expect(mm.memo.status).toBe('approved'); // الاعتماد الداخلي لا يعني التقديم
    expect(mm.submissions).toHaveLength(0);
    const subErr = await callErr(core, s, 'memos.recordSubmission', { memoId: memo.id });
    expect(subErr.code).toBe('VALIDATION'); // التاريخ إلزامي
    await call(core, s, 'memos.recordSubmission', { memoId: memo.id, submittedOn: '2026-04-10', authority: 'المحكمة العمالية التجريبية' });
    mm = await call(core, s, 'memos.get', { id: memo.id });
    expect(mm.memo.status).toBe('submitted');
    expect(mm.submissions[0].submittedOn).toBe('2026-04-10');
    const edit = await callErr(core, s, 'memos.update', { id: memo.id, title: 'مذكرة جوابية', memoType: 'reply', body: 'تعديل بعد التقديم' });
    expect(edit.code).toBe('CONFLICT');

    const j = await call(core, s, 'judgments.create', { caseId: ids.laborId, stageId: firstStage, hearingId: h2, judgmentNo: 'ح/123', judgmentDate: '2026-05-01', summary: 'حكمت الدائرة بإلزام الشركة بجزء من المطالبة (خيالي)' });
    const jl = await call(core, s, 'judgments.list', { caseId: ids.laborId });
    expect(jl[0].followStatus).toBe('recorded'); // لا يعتبر نهائيًا تلقائيًا
    await call(core, s, 'deadlines.save', { caseId: ids.laborId, judgmentId: j.id, title: 'تقديم الاعتراض', dueDate: '2026-05-31', source: 'المدة كما وردت في صك الحكم المرفق (مُدخلة يدويًا)' });

    const appeal = await call(core, s, 'stages.create', { caseId: ids.laborId, stageType: 'الاستئناف', courtType: 'المحاكم العمالية', courtName: 'محكمة الاستئناف التجريبية', officialCaseNo: '4470055555', startedOn: '2026-06-01', previousStageId: firstStage });
    await call(core, s, 'hearings.create', { caseId: ids.laborId, stageId: appeal.id, date: '2026-12-01', time: '11:00' });
    const after = await call(core, s, 'cases.get', { id: ids.laborId });
    expect(after.stages.map((x: any) => x.stageType)).toEqual(['الدرجة الأولى', 'الاستئناف']); // تاريخ الدرجة الأولى محفوظ
    expect(after.stages[1].previousStageId).toBe(firstStage);
    expect(after.header.stage.stageType).toBe('الاستئناف');
    // الموعد الإجرائي المسجل في مايو فات ولم يُغلق — يظهر أولًا كمتأخر
    expect(after.header.nextEvent.kind).toBe('deadline');
    expect(after.header.nextEvent.overdue).toBe(true);
  });

  it('يمنع ربط مستند بجلسة من قضية أخرى (روابط متناقضة)', async () => {
    const f = makePdf(path.join(files, 'x.pdf'));
    platform.openQueue.push(f);
    const staged = await call(core, s, 'documents.pickFile', {});
    const err = await callErr(core, s, 'documents.create', { title: 'خطأ', category: 'other', clientId: ids.clientId, caseId: ids.commercialId, hearingId: h1, token: staged.token });
    expect(err.code).toBe('VALIDATION');
  });

  it('البحث باسم الشركة يصل للقضايا والمستندات والمواعيد من صفحتها', async () => {
    const r = await call(core, s, 'search.global', { q: 'شركه المثال' }); // تطبيع ة/ه
    expect(r.hits.some((h: any) => h.type === 'client' && h.id === ids.clientId)).toBe(true);
    const profile = await call(core, s, 'clients.get', { id: ids.clientId });
    expect(profile.cases).toHaveLength(2);
    expect(profile.documents.filter((d: any) => d.caseId === ids.laborId && d.category === 'minutes')).toHaveLength(2);
    expect(profile.upcoming.some((u: any) => u.kind === 'hearing' && u.caseId === ids.laborId)).toBe(true);
    const byOpponent = await call(core, s, 'search.global', { q: 'مؤسسة التوريد' });
    expect(byOpponent.hits.some((h: any) => h.type === 'case' && h.id === ids.commercialId)).toBe(true);
    const byNumber = await call(core, s, 'search.global', { q: '4470001234' });
    expect(byNumber.hits.some((h: any) => h.type === 'case' && h.id === ids.laborId)).toBe(true);
  });

  it('التحليل اليدوي وربط واقعة بدليل وتحويل طلب الجلسة إلى مهمة', async () => {
    const a = await call(core, s, 'analysis.get', { caseId: ids.laborId });
    const saved = await call(core, s, 'analysis.saveSection', { caseId: ids.laborId, key: 'facts', text: 'التحق المدعي بالعمل في 2020 (واقعة خيالية).', baseRevision: a.revision });
    const conflict = await callErr(core, s, 'analysis.saveSection', { caseId: ids.laborId, key: 'strengths', text: 'x', baseRevision: a.revision });
    expect(conflict.code).toBe('CONFLICT');
    await call(core, s, 'analysis.saveSection', { caseId: ids.laborId, key: 'strengths', text: 'وجود عقد عمل موقع.', baseRevision: saved.revision });
    const docs = await call(core, s, 'documents.list', { caseId: ids.laborId });
    const noDoc = await callErr(core, s, 'evidence.save', { caseId: ids.laborId, kind: 'fact', statement: 'تاريخ الالتحاق', reliability: 'confirmed' });
    expect(noDoc.code).toBe('VALIDATION');
    await call(core, s, 'evidence.save', { caseId: ids.laborId, kind: 'fact', statement: 'تاريخ الالتحاق', reliability: 'confirmed', documentId: docs[0].id, locationRef: 'ص 1' });
    const after = await call(core, s, 'analysis.get', { caseId: ids.laborId });
    expect(after.sections.find((x: any) => x.key === 'facts').text).toContain('2020');
    expect(after.sections.find((x: any) => x.key === 'facts').updatedByName).toBe('المالك التجريبي');
    expect(after.evidence[0].documentTitle).toBeTruthy();

    const req = await call(core, s, 'hearings.saveRequest', { hearingId: h2, text: 'تقديم كشف الرواتب', requestedBy: 'المحكمة', dueDate: '2026-04-20' });
    const task = await call(core, s, 'hearings.requestToTask', { requestId: req.id, title: 'إعداد كشف الرواتب' });
    const hd = await call(core, s, 'hearings.get', { id: h2 });
    expect(hd.requests[0].taskId).toBe(task.id);
    const tasks = await call(core, s, 'tasks.list', { caseId: ids.laborId, status: 'all' });
    expect(tasks[0].hearingId).toBe(h2);
  });

  it('تسجيل دفعة دون تكرار إجمالي العقد الشامل بين القضيتين', async () => {
    await call(core, s, 'payments.create', { contractId: ids.contractId, amount: 4000000, paidOn: '2026-02-01', method: 'تحويل بنكي', referenceNo: 'TRX-1' });
    const sum = await call(core, s, 'finance.clientSummary', { clientId: ids.clientId });
    expect(sum.agreed).toBe(10000000); // 100,000 ر.س مرة واحدة وليس 200,000
    expect(sum.paid).toBe(4000000);
    expect(sum.remaining).toBe(6000000);
    expect(sum.percentage).toHaveLength(1); // النسبية مسجلة دون تحويلها لمستحق
    const office = await call(core, s, 'finance.officeSummary', {});
    expect(office.agreed).toBe(10000000);
    const dash = await call(core, s, 'dashboard.get', {});
    expect(dash.finance.remaining).toBe(6000000);
    const payErr = await callErr(core, s, 'payments.create', { contractId: ids.contractId, amount: 0, paidOn: '2026-02-01' });
    expect(payErr.code).toBe('VALIDATION');
  });

  it('المرفقات تبقى سليمة بعد حذف الملفات الأصلية وإعادة فتح البرنامج', async () => {
    const docx = await makeDocx(path.join(files, 'memo.docx'), ['مذكرة اختبار عربية', 'سطر ثانٍ']);
    const d = await stageAndAttach(core, platform, s, docx, { title: 'مذكرة Word', category: 'memo', clientId: ids.clientId, caseId: ids.laborId });
    fs.rmSync(files, { recursive: true, force: true }); // نقل/حذف الأصول خارج البرنامج
    await core.extraction.idle();
    const preview = await call(core, s, 'documents.docxPreview', { versionId: d.versionId });
    expect(preview.html).toContain('مذكرة اختبار عربية');
    const txt = await call(core, s, 'documents.text', { versionId: d.versionId });
    expect(txt.status).toBe('done');
    const found = await call(core, s, 'search.global', { q: 'سطر ثان' });
    expect(found.hits.some((h: any) => h.type === 'document' && h.id === d.id)).toBe(true);
    const list = await call(core, s, 'documents.list', { caseId: ids.laborId, category: 'minutes' });
    const bytes = await call(core, s, 'documents.readBytes', { versionId: list[0].current.id });
    expect(Buffer.from(bytes.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const pdfText = await call(core, s, 'documents.text', { versionId: list[0].current.id });
    expect(pdfText.status).toBe('done');
    expect(pdfText.text).toMatch(/Minutes of hearing/);

    core.shutdown();
    const { AppCore } = await import('../../src/main/core');
    const reopened = new AppCore(path.join(dir, 'data'), platform, env.clock.now);
    await call(reopened, 'S2', 'auth.login', { username: 'owner', password: 'Owner#Pass2026' });
    const c = await call(reopened, 'S2', 'cases.get', { id: ids.laborId });
    expect(c.counts.hearings).toBe(3);
    expect(c.counts.docs).toBe(3);
    const b2 = await call(reopened, 'S2', 'documents.readBytes', { versionId: list[0].current.id });
    expect(b2.bytes.byteLength).toBeGreaterThan(100);
    const sum = await call(reopened, 'S2', 'finance.clientSummary', { clientId: ids.clientId });
    expect(sum.paid).toBe(4000000);
    const tl = await call(reopened, 'S2', 'cases.timeline', { id: ids.laborId });
    expect(tl.some((e: any) => e.kind === 'submission')).toBe(true);
    expect(tl.some((e: any) => e.kind === 'hearing' && e.documents.length === 1 && e.source === 'ضبط الجلسة المرفق')).toBe(true);
    reopened.shutdown();
  });
});
