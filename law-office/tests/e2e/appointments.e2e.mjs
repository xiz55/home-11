// اختبار تشغيل فعلي لقسم «الاستشارات والاجتماعات» و«التقرير الشامل للمكتب» عبر الواجهة — بيانات خيالية في مساحة منفصلة.
// التشغيل: npm run build && xvfb-run -a node --test tests/e2e/appointments.e2e.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yazl from 'yazl';
import { launch, tmpWorkspace, mockOpen, mockSave, mockShell, riyadhDate, makePdf, shot, modal, saveModal, expectToast, invoke, OUT } from './lib.mjs';

async function nav(win, label) {
  await win.locator('.sidebar nav').getByRole('link', { name: label, exact: true }).click();
}

const OWNER = { name: 'المالك التجريبي', user: 'owner', pass: 'Owner#Pass2026' };
const SEEKER = { name: 'طالب استشارة خيالي', phone: '0551112233' };
const files = path.join(OUT, 'files-appt');
fs.mkdirSync(files, { recursive: true });
const data = tmpWorkspace('appt');
let A;
const ids = {};
const tomorrow = riyadhDate(1);

function L(t) {
  return new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(\\s*\\*)?$');
}

async function makeDocx(file, text) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels');
  zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`), 'word/document.xml');
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    ws.on('close', resolve);
    ws.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
  return file;
}

async function attach(win, file) {
  await mockOpen(A.app, file);
  await modal(win).getByRole('button', { name: /اختيار ملف|تغيير الملف/ }).click();
  await modal(win).locator('.dropzone').getByText(path.basename(file)).waitFor();
}

async function confirmDialog(win, label) {
  const c = win.locator('.overlay.confirm');
  await c.waitFor();
  await c.getByRole('button', { name: label }).click();
}

describe('الاستشارات والاجتماعات والتقرير الشامل عبر الواجهة', { concurrency: false }, () => {
  before(async () => {
    A = await launch(data);
    await mockShell(A.app);
  });
  after(async () => {
    await A?.app.close().catch(() => undefined);
  });

  it('1. إنشاء حساب المالك وظهور القسم المستقل في القائمة الجانبية', { timeout: 120000 }, async () => {
    const { win } = A;
    await win.getByLabel('اسمك كما يظهر في البرنامج').fill(OWNER.name);
    await win.getByLabel('اسم المستخدم').fill(OWNER.user);
    await win.locator('input[type=password]').nth(0).fill(OWNER.pass);
    await win.locator('input[type=password]').nth(1).fill(OWNER.pass);
    await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await win.getByTestId('recovery-code').waitFor();
    await win.getByRole('checkbox').check();
    await win.getByRole('button', { name: 'متابعة' }).click();
    await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();
    await nav(win, 'الاستشارات والاجتماعات');
    await win.getByRole('heading', { name: 'الاستشارات والاجتماعات' }).waitFor();
    await win.getByRole('tab', { name: 'الاستشارات القانونية' }).waitFor();
    await win.getByRole('tab', { name: 'الاجتماعات' }).waitFor();
    await shot(win, 'appt-01-empty');
  });

  it('2. استشارة هاتفية مدفوعة لطالب استشارة جديد دون قضية، ودفعة جزئية', { timeout: 120000 }, async () => {
    const { win } = A;
    await win.getByRole('button', { name: 'إضافة استشارة' }).first().click();
    const m = modal(win);
    await m.getByRole('button', { name: 'شخص أو شركة جديدة' }).click();
    await m.getByLabel(L('الاسم')).fill(SEEKER.name);
    await m.getByLabel(L('الجوال')).fill(SEEKER.phone);
    await m.getByLabel('البريد (اختياري)').fill('seeker@example.test');
    await m.getByLabel(L('عنوان الاستشارة')).fill('استفسار عن مكافأة نهاية الخدمة');
    await m.getByLabel('التصنيف القانوني').selectOption({ label: 'عمالي' });
    await m.getByLabel(L('طريقة الاستشارة')).selectOption({ label: 'هاتفية' });
    await m.getByLabel(L('تاريخ الاستشارة')).fill(tomorrow);
    await m.getByLabel(L('وقت البداية')).fill('10:00');
    await m.getByLabel(L('المدة بالدقائق')).fill('30');
    await m.locator('.field').filter({ hasText: 'وقت النهاية' }).getByText('10:30').waitFor();
    await m.getByLabel('حالة الموعد').selectOption({ label: 'مؤكد' });
    await m.getByLabel('الأتعاب').selectOption({ label: 'استشارة مدفوعة' });
    await m.getByLabel(L('مبلغ الاستشارة')).fill('500');
    await m.getByLabel('وصف الموضوع').fill('موظف سابق يسأل عن احتساب المكافأة (وقائع خيالية).');
    await m.getByLabel('الأسئلة المطلوب بحثها').fill('هل تحتسب الإجازات غير المستخدمة؟');
    await m.getByLabel(/ملاحظات داخلية/).fill('ملاحظة داخلية سرية لا تُطبع');
    await shot(win, 'appt-02-consultation-form');
    await saveModal(win);
    await win.getByRole('heading', { name: 'استفسار عن مكافأة نهاية الخدمة' }).waitFor();
    ids.c1 = /consultations\/([0-9a-f-]{36})/.exec(win.url())[1];
    await win.getByText('غير مرتبطة بقضية').waitFor();
    await win.getByText('غير مسدد').first().waitFor();
    await win.getByRole('button', { name: 'تسجيل دفعة' }).click();
    const p = modal(win);
    await p.getByLabel(L('المبلغ')).fill('200');
    await p.getByLabel('الطريقة').selectOption({ label: 'تحويل بنكي' });
    await p.getByLabel('رقم السند / المرجع').fill('TRX-1');
    await saveModal(win);
    await expectToast(win, /سُجلت الحركة المالية/);
    await win.getByRole('tab', { name: 'الأتعاب والدفعات' }).click();
    await win.getByText('مسدد جزئيًا').first().waitFor();
    const fin = await win.locator('.fin-mini').first().innerText();
    assert.match(fin, /500\.00/);
    assert.match(fin, /300\.00/);
    // العلاقة بالمكتب: طالب استشارة فقط، دون قضية أو عقد
    const r = await invoke(win, 'consultations.get', { id: ids.c1 });
    ids.person = r.data.consultation.clientId;
    const prof = await invoke(win, 'clients.get', { id: ids.person });
    assert.equal(prof.data.relation, 'consultation_only');
    assert.equal(prof.data.cases.length, 0);
    await shot(win, 'appt-03-consultation-fees');
  });

  it('3. إرفاق PDF وWord واستشارة مكتوبة بنسختين ثم تسجيل التسليم', { timeout: 180000 }, async () => {
    const { win } = A;
    const pdf = makePdf(path.join(files, 'seeker-letter.pdf'), 'Seeker provided letter');
    const docx = await makeDocx(path.join(files, 'seeker-contract.docx'), 'عقد العمل الخيالي');
    for (const f of [pdf, docx]) {
      await win.getByRole('button', { name: 'إرفاق مستند' }).first().click();
      await attach(win, f);
      await saveModal(win, 'حفظ المرفق');
      await expectToast(win, /حُفظ المرفق/);
    }
    await win.getByRole('tab', { name: /مستندات المستفيد/ }).click();
    await win.getByText('seeker-letter').first().waitFor();
    // الاستشارة المكتوبة: نص + ملف Word
    await win.getByRole('button', { name: 'إضافة الاستشارة المكتوبة' }).first().click();
    let m = modal(win);
    await m.getByLabel('نص الاستشارة (محرر محلي)').fill('النص الأول للرأي القانوني الخيالي.');
    await m.getByRole('button', { name: 'رفع ملف PDF أو Word' }).click();
    const opinionDoc = await makeDocx(path.join(files, 'opinion-v1.docx'), 'الرأي القانوني النسخة الأولى');
    await attach(win, opinionDoc);
    await saveModal(win, 'حفظ المرفق');
    await expectToast(win, /حُفظ المرفق/);
    m = modal(win);
    await m.getByLabel('الحالة').selectOption({ label: 'قيد المراجعة' });
    await saveModal(win);
    await expectToast(win, /حُفظت الاستشارة المكتوبة/);
    await win.getByRole('tab', { name: /الاستشارة المكتوبة/ }).click();
    await win.getByRole('button', { name: 'نسخة معدلة' }).click();
    m = modal(win);
    await m.getByLabel('نص الاستشارة (محرر محلي)').fill('النص المعدل للرأي القانوني الخيالي.');
    await m.getByLabel('الحالة').selectOption({ label: 'معتمدة داخليًا' });
    await m.getByLabel('ملاحظة على هذه النسخة').fill('بعد المراجعة');
    await saveModal(win, 'حفظ نسخة معدلة');
    await expectToast(win, /النسخ السابقة محفوظة/);
    await win.getByText('معتمدة داخليًا').first().waitFor();
    assert.equal(await win.getByText(/سُلّمت للمستفيد في/).count(), 0, 'الاعتماد لا يعني التسليم');
    await win.locator('details summary', { hasText: 'النسخ السابقة' }).click();
    await win.getByRole('button', { name: 'عرض' }).last().click();
    await modal(win).getByText('النص الأول للرأي القانوني الخيالي.').waitFor();
    await win.keyboard.press('Escape');
    await modal(win).waitFor({ state: 'detached' });
    await win.getByRole('button', { name: 'تسجيل التسليم' }).click();
    m = modal(win);
    await m.getByLabel(L('طريقة التسليم')).selectOption({ label: 'بريد إلكتروني' });
    await saveModal(win, 'تسجيل التسليم');
    await expectToast(win, /سُجل التسليم/);
    await win.getByText(/سُلّمت للمستفيد في/).waitFor();
    await shot(win, 'appt-04-written-opinion');
    const docs = await invoke(win, 'documents.list', { consultationId: ids.c1 });
    assert.equal(docs.data.length, 3);
    // الملفات منسوخة داخل مستودع البرنامج: حذف الأصل لا يؤثر
    fs.rmSync(pdf);
    const pdfDoc = docs.data.find((d) => d.current.ext === 'pdf');
    const bytes = await invoke(win, 'documents.readBytes', { versionId: pdfDoc.current.id });
    assert.ok(bytes.ok && bytes.data.bytes.byteLength > 100);
  });

  it('4. طباعة ملخص الاستشارة لا تتضمن الملاحظات الداخلية افتراضيًا', { timeout: 60000 }, async () => {
    const { win } = A;
    await win.getByRole('button', { name: 'طباعة ملخص' }).click();
    const frame = win.frameLocator('iframe[title="معاينة الملخص"]');
    await frame.getByText('ملخص استشارة قانونية').waitFor();
    await frame.getByText('النص المعدل للرأي القانوني الخيالي.').waitFor();
    assert.equal(await frame.getByText('ملاحظة داخلية سرية لا تُطبع').count(), 0);
    await shot(win, 'appt-05-summary-preview');
    await modal(win).locator('.modal-foot').getByRole('button', { name: 'إغلاق' }).click();
  });

  it('5. استشارة حضورية مجانية لنفس الشخص (اختيار السجل الموجود عند الجوال المطابق)', { timeout: 120000 }, async () => {
    const { win } = A;
    await nav(win, 'الاستشارات والاجتماعات');
    await win.getByRole('button', { name: 'إضافة استشارة' }).first().click();
    const m = modal(win);
    await m.getByRole('button', { name: 'شخص أو شركة جديدة' }).click();
    await m.getByLabel(L('الاسم')).fill('اسم مكتوب بطريقة أخرى');
    await m.getByLabel(L('الجوال')).fill('+966 55 111 2233');
    await m.getByLabel(L('عنوان الاستشارة')).fill('استشارة حضورية مجانية');
    await m.getByLabel(L('طريقة الاستشارة')).selectOption({ label: 'حضورية' });
    await m.getByLabel('مكان الحضور').fill('مقر المكتب');
    await m.getByLabel(L('تاريخ الاستشارة')).fill(tomorrow);
    await m.getByLabel(L('وقت البداية')).fill('13:00');
    await m.getByLabel(L('المدة بالدقائق')).fill('45');
    await m.getByLabel('الأتعاب').selectOption({ label: 'استشارة مجانية (صفر)' });
    await saveModal(win);
    await win.locator('.overlay.confirm').getByText('جوال مطابق لسجل موجود').waitFor();
    await shot(win, 'appt-06-duplicate-phone');
    await confirmDialog(win, 'استخدام السجل الموجود');
    await win.getByRole('heading', { name: 'استشارة حضورية مجانية' }).waitFor();
    ids.c2 = /consultations\/([0-9a-f-]{36})/.exec(win.url())[1];
    const r = await invoke(win, 'consultations.get', { id: ids.c2 });
    assert.equal(r.data.consultation.clientId, ids.person);
    assert.equal(r.data.consultation.finance.status, 'free');
    const all = await invoke(win, 'clients.list', {});
    assert.equal(all.data.length, 1, 'لم يُكرر الشخص');
  });

  it('6. اجتماع بتعارض موعد يُنبَّه عليه ويؤكَّد، ومحضر وتحويل قرار إلى مهمة', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'الاستشارات والاجتماعات');
    await win.getByRole('button', { name: 'إضافة اجتماع' }).click();
    const m = modal(win);
    await m.getByLabel(L('عنوان الاجتماع')).fill('اجتماع مراجعة المستندات');
    await m.getByRole('button', { name: 'عميل أو جهة اتصال مسجلة' }).click();
    await m.getByLabel(L('الاسم')).selectOption({ index: 1 });
    await m.getByLabel(L('الطريقة')).selectOption({ label: 'اتصال مرئي' });
    await m.getByLabel(L('التاريخ')).fill(tomorrow);
    await m.getByLabel(L('وقت البداية')).fill('13:30');
    await m.getByLabel(L('وقت النهاية')).fill('14:15');
    await m.getByLabel('الاسم 1').fill('طالب استشارة خيالي');
    await m.getByLabel('الصفة').first().fill('المستفيد');
    await m.getByLabel('جدول الأعمال').fill('مراجعة عقد العمل');
    await m.getByText(/يتعارض الموعد مع/).waitFor();
    await saveModal(win);
    await win.locator('.overlay.confirm').getByText('تعارض في المواعيد').waitFor();
    await shot(win, 'appt-07-conflict');
    await confirmDialog(win, 'متابعة الحفظ رغم التعارض');
    await win.getByRole('heading', { name: 'اجتماع مراجعة المستندات' }).waitFor();
    ids.m1 = /meetings\/([0-9a-f-]{36})/.exec(win.url())[1];
    await win.getByRole('button', { name: 'تعديل الاجتماع والمحضر' }).click();
    const e = modal(win);
    await e.getByLabel('الحالة').selectOption({ label: 'منعقد' });
    await e.getByLabel('محضر الاجتماع').fill('راجع الحضور عقد العمل واتفقوا على طلب شهادة الخدمة.');
    await saveModal(win);
    await expectToast(win, /حُفظ تعديل الاجتماع/);
    await win.getByRole('button', { name: 'إضافة قرار أو توصية' }).click();
    await modal(win).getByLabel(L('النص')).fill('طلب شهادة الخدمة من جهة العمل');
    await saveModal(win);
    await win.getByRole('tab', { name: /المحضر والقرارات/ }).click();
    await win.getByRole('button', { name: 'تحويل إلى مهمة' }).click();
    await saveModal(win, 'إنشاء المهمة');
    await expectToast(win, /أُنشئت المهمة مرتبطة بالاجتماع/);
    await win.getByText(/مهمة: طلب شهادة الخدمة/).waitFor();
    await shot(win, 'appt-08-meeting-minutes');
    const t = await invoke(win, 'tasks.list', { meetingId: ids.m1 });
    assert.equal(t.data.length, 1);
  });

  it('7. ظهور المواعيد في القسم والتقويم العام مميزة عن الجلسات', { timeout: 90000 }, async () => {
    const { win } = A;
    await nav(win, 'الاستشارات والاجتماعات');
    await win.getByRole('cell', { name: /طالب استشارة خيالي/ }).first().waitFor();
    await win.getByPlaceholder(/ابحث بالاسم/).fill('0551112233');
    await win.getByRole('cell', { name: /استفسار عن مكافأة/ }).waitFor();
    await win.getByPlaceholder(/ابحث بالاسم/).fill('');
    await shot(win, 'appt-09-list');
    await win.getByRole('tab', { name: 'تقويم' }).click();
    await win.locator('.cal-ev.consultation').first().waitFor();
    await nav(win, 'التقويم والجلسات');
    await win.getByRole('tab', { name: 'قائمة' }).click();
    await win.getByText('استشارة: استفسار عن مكافأة نهاية الخدمة').waitFor();
    await win.getByText('اجتماع: اجتماع مراجعة المستندات').waitFor();
    await shot(win, 'appt-10-general-calendar');
  });

  it('8. ربط طالب الاستشارة بقضية لاحقًا دون تكرار الشخص', { timeout: 120000 }, async () => {
    const { win } = A;
    await win.evaluate((id) => (window.location.hash = `#/appointments/consultations/${id}`), ids.c1);
    await win.getByRole('button', { name: 'ربط بقضية' }).click();
    await modal(win).getByRole('button', { name: 'فتح قضية جديدة لهذا الشخص' }).click();
    const c = modal(win);
    await c.getByLabel('عنوان القضية').fill('مطالبة مكافأة نهاية الخدمة (خيالية)');
    await c.getByLabel('اسم الطرف').fill('جهة عمل خيالية');
    await saveModal(win);
    await expectToast(win, /./);
    await saveModal(win);
    await expectToast(win, /رُبطت الاستشارة بالقضية/);
    await win.getByText(/القضية:/).first().waitFor();
    const all = await invoke(win, 'clients.list', {});
    assert.equal(all.data.length, 1);
    assert.equal(all.data[0].relation, 'both');
  });

  it('9-11. التقرير الشامل: عرض الأرقام الحقيقية وتصدير PDF وExcel سليمين', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'التقارير');
    await win.getByRole('tab', { name: 'التقرير الشامل للمكتب' }).click();
    await win.getByRole('button', { name: 'إنشاء التقرير' }).click();
    await win.getByText('تقرير داخلي — سري').first().waitFor();
    const sum = await win.locator('.sum-grid').first().innerText();
    assert.match(sum, /العملاء وجهات الاتصال الفريدون\s+1/);
    await win.getByText('أتعاب الاستشارات').waitFor();
    await win.locator('summary, button').filter({ hasText: 'كشف الاستشارات' }).first().click();
    await win.getByRole('cell', { name: 'استفسار عن مكافأة نهاية الخدمة' }).waitFor();
    await shot(win, 'appt-11-office-report');
    const pdfOut = path.join(files, 'office-report.pdf');
    const xlsxOut = path.join(files, 'office-report.xlsx');
    await mockSave(A.app, pdfOut);
    await win.getByRole('button', { name: 'حفظ PDF' }).click();
    await expectToast(win, /حُفظ التقرير PDF/);
    await mockSave(A.app, xlsxOut);
    await win.getByRole('button', { name: 'تصدير Excel' }).click();
    await expectToast(win, /صُدّرت الجداول/);
    assert.equal(fs.readFileSync(pdfOut).subarray(0, 4).toString(), '%PDF');
    assert.equal(fs.readFileSync(xlsxOut).subarray(0, 2).toString(), 'PK');
    try {
      execFileSync('pdftoppm', ['-png', '-r', '70', '-f', '1', '-l', '2', pdfOut, path.join(OUT, 'appt-12-office-report-pdf')]);
      const txt = execFileSync('pdftotext', [pdfOut, '-']).toString();
      assert.match(txt, /صفحة/);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const act = await invoke(win, 'activity.list', {});
    assert.ok(act.data.some((a) => a.summary.includes('تصدير التقرير الشامل PDF')));
    assert.ok(act.data.some((a) => a.summary.includes('تصدير التقرير الشامل Excel')));
  });

  it('12. الحفظ بعد إعادة التشغيل', { timeout: 120000 }, async () => {
    await A.app.close();
    A = await launch(data);
    const { win } = A;
    await win.getByLabel('اسم المستخدم').fill(OWNER.user);
    await win.locator('input[type=password]').first().fill(OWNER.pass);
    await win.getByRole('button', { name: 'تسجيل الدخول' }).click();
    await win.locator('.sidebar').waitFor();
    await win.keyboard.press('Escape').catch(() => undefined);
    await nav(win, 'الاستشارات والاجتماعات');
    await win.getByRole('cell', { name: /استفسار عن مكافأة/ }).waitFor();
    const r = await invoke(win, 'consultations.get', { id: ids.c1 });
    assert.equal(r.data.opinions[0].status, 'delivered');
    assert.equal(r.data.transactions.length, 1);
    assert.deepEqual(A.errors.filter((e) => !/favicon/.test(e)), []);
  });
});
