// اختبار القبول الكامل عبر الواجهة الفعلية للبرنامج — بيانات خيالية في مساحة اختبار منفصلة.
// التشغيل: npm run build && xvfb-run -a node --test tests/e2e/journey.e2e.mjs
// لاختبار النسخة المغلفة: LAWOFFICE_EXEC=release/linux-unpacked/law-office-manager ...
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launch, tmpWorkspace, mockOpen, mockSave, mockShell, riyadhDate, makePdf, shot, modal, saveModal, expectToast, nav, invoke, OUT, ROOT } from './lib.mjs';

const OWNER = { name: 'المالك التجريبي', user: 'owner', pass: 'Owner#Pass2026' };
const CONS = { name: 'مستشار تجريبي', user: 'consultant', pass: 'Consult#Pass2026' };
const COMPANY = 'شركة المثال التجريبية';
const files = path.join(OUT, 'files');
fs.mkdirSync(files, { recursive: true });

let A; // التشغيل الحالي للمساحة الأساسية
const dataA = tmpWorkspace('main');
const ids = {};

async function login(win, user, pass) {
  await win.getByLabel('اسم المستخدم').fill(user);
  await win.locator('input[type=password]').first().fill(pass);
  await win.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await win.locator('.sidebar').waitFor();
}

async function logout(win) {
  await win.locator('.topbar').getByRole('button', { name: /المالك التجريبي|مستشار تجريبي/ }).click();
  await win.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await win.getByRole('button', { name: 'تسجيل الدخول' }).waitFor();
}

async function attachViaDialog(win, file) {
  await mockOpen(A.app, file);
  await modal(win).getByRole('button', { name: /اختيار ملف|تغيير الملف/ }).click();
  await modal(win).locator('.dropzone').getByText(path.basename(file)).waitFor();
}

function caseIdFromUrl(win) {
  const m = /#\/cases\/([0-9a-f-]{36})/.exec(win.url());
  assert.ok(m, 'case id in url: ' + win.url());
  return m[1];
}

describe('رحلة القبول الكاملة عبر الواجهة', { concurrency: false }, () => {
  before(async () => {
    A = await launch(dataA);
    await mockShell(A.app);
  });
  after(async () => {
    await A?.app.close().catch(() => undefined);
  });

  it('1. إنشاء حساب المالك ثم حساب مستشار بصلاحيات محدودة', { timeout: 180000 }, async () => {
    const { win } = A;
    await win.getByLabel('اسمك كما يظهر في البرنامج').fill(OWNER.name);
    await win.getByLabel('اسم المستخدم').fill(OWNER.user);
    await win.locator('input[type=password]').nth(0).fill(OWNER.pass);
    await win.locator('input[type=password]').nth(1).fill(OWNER.pass);
    await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
    const code = await win.getByTestId('recovery-code').innerText();
    assert.match(code, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    ids.recovery = code;
    await win.getByRole('checkbox').check();
    await win.getByRole('button', { name: 'متابعة' }).click();
    await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();
    await shot(win, '01-dashboard-empty');
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'المستخدمون والصلاحيات' }).click();
    await win.getByRole('button', { name: 'إضافة مستشار' }).click();
    const m = modal(win);
    await m.getByLabel(L('الاسم')).fill(CONS.name);
    await m.getByLabel('اسم المستخدم').fill(CONS.user);
    await m.getByLabel('كلمة المرور المؤقتة').fill(CONS.pass);
    assert.equal(await m.getByRole('checkbox', { name: PERMS.fees }).isChecked(), false);
    await saveModal(win);
    await expectToast(win, /أُنشئ حساب المستشار/);
    await win.getByRole('cell', { name: new RegExp(CONS.name) }).waitFor();
  });

  it('2. شركة بعقد شامل ووكالة، وقضية عمالية وتجارية مرتبطتان بهما', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'العملاء والشركات');
    await win.getByRole('button', { name: 'إضافة عميل' }).click();
    let m = modal(win);
    await m.getByLabel('اسم الشركة / المنشأة').fill(COMPANY);
    await m.getByLabel(L('الجوال')).fill('0500000001');
    await m.getByLabel('اسم الممثل').fill('ممثل خيالي');
    await m.getByLabel('صفة الممثل').fill('المدير التنفيذي');
    await saveModal(win);
    await win.getByRole('heading', { name: COMPANY }).waitFor();
    ids.clientId = /#\/clients\/([0-9a-f-]{36})/.exec(win.url())[1];
    const addCase = async (title, type, opponent, court, no, start) => {
      await win.getByRole('button', { name: 'إضافة قضية' }).first().click();
      m = modal(win);
      await m.getByLabel('عنوان القضية').fill(title);
      await m.getByLabel('نوع القضية').selectOption({ label: type });
      await m.getByLabel('تاريخ فتح الملف').fill(start);
      await m.getByLabel('اسم الطرف').fill(opponent);
      await m.getByLabel(L('المحكمة')).fill(court);
      await m.getByLabel('رقم القضية الرسمي').fill(no);
      await m.getByLabel('تاريخ بدء المرحلة').fill(start);
      await saveModal(win);
      await win.getByRole('heading', { name: title }).waitFor();
      return caseIdFromUrl(win);
    };
    ids.labor = await addCase('مطالبة عمالية — موظف سابق خيالي', 'عمالية', 'خصم عمالي خيالي', 'المحكمة العمالية التجريبية', '4470001234', riyadhDate(-120));
    await win.locator('.breadcrumb').getByRole('link', { name: COMPANY }).click();
    ids.commercial = await addCase('نزاع توريد — مورد خيالي', 'تجارية', 'مؤسسة التوريد الخيالية', 'المحكمة التجارية التجريبية', '4470009999', riyadhDate(-100));
    await win.locator('.breadcrumb').getByRole('link', { name: COMPANY }).click();

    await win.getByRole('tab', { name: /العقود/ }).click();
    await win.getByRole('button', { name: 'إضافة عقد' }).click();
    m = modal(win);
    await m.getByLabel('عنوان العقد').fill('عقد أتعاب شامل 2026');
    await m.getByLabel('نطاق العقد').fill('تمثيل الشركة في القضية العمالية والقضية التجارية المحددتين فقط.');
    await m.getByLabel('الأتعاب الثابتة (إجمالي العقد)').fill('100000');
    await m.getByRole('checkbox', { name: /مطالبة عمالية/ }).check();
    await m.getByRole('checkbox', { name: /نزاع توريد/ }).check();
    await saveModal(win);
    await expectToast(win, /سُجل العقد/);
    await win.getByText('عقد شامل لعدة قضايا').waitFor();
    // إرفاق ملف العقد (PDF) مباشرة من تبويب العقود
    await win.getByRole('button', { name: 'إرفاق ملف العقد' }).click();
    await attachViaDialog(win, makePdf(path.join(files, 'fee-contract.pdf'), 'Fee contract'));
    await saveModal(win, 'حفظ المرفق');
    await expectToast(win, /حُفظ المرفق/);
    await win.getByRole('button', { name: /عقد أتعاب شامل 2026 \(PDF\)/ }).waitFor();

    await win.getByRole('tab', { name: /الوكالات/ }).click();
    await win.getByRole('button', { name: 'تسجيل وكالة' }).click();
    m = modal(win);
    await m.getByLabel('رقم الوكالة').fill('470000111');
    await m.getByLabel('نطاق الوكالة (كما ورد فيها)').fill('المرافعة والمدافعة في القضيتين المحددتين.');
    await m.getByRole('checkbox', { name: /مطالبة عمالية/ }).check();
    await m.getByRole('checkbox', { name: /نزاع توريد/ }).check();
    await saveModal(win);
    await expectToast(win, /سُجلت الوكالة/);
    await shot(win, '02-client-poas');
  });

  it('3. جلستان بضبطين، مذكرة مسودة ثم تقديم، حكم، ومرحلة استئناف وجلستها', { timeout: 180000 }, async () => {
    const { win } = A;
    await go(win, `/cases/${ids.labor}?tab=stages`);
    await win.getByRole('button', { name: 'إضافة جلسة' }).first().click();
    let m = modal(win);
    await m.getByLabel(L('التاريخ')).fill(riyadhDate(-60));
    await m.getByLabel(L('الوقت')).fill('09:30');
    await m.getByLabel('حالة الجلسة').selectOption('held');
    await m.getByLabel('ملخص ما جرى في الجلسة').fill('الجلسة الأولى — قدّم المدعي لائحته (خيالي).');
    await m.getByLabel(L('النتيجة')).fill('التأجيل للرد');
    await saveModal(win);
    await expectToast(win, /أُضيفت الجلسة/);
    await win.getByRole('button', { name: 'إضافة جلسة' }).first().click();
    m = modal(win);
    await m.getByLabel(L('التاريخ')).fill(riyadhDate(-30));
    await m.getByLabel(L('الوقت')).fill('10:00');
    await m.getByLabel('حالة الجلسة').selectOption('held');
    await m.getByLabel('ملخص ما جرى في الجلسة').fill('الجلسة الثانية — طلبت المحكمة كشف الرواتب.');
    await saveModal(win);
    await expectToast(win, /أُضيفت الجلسة/);
    const rows = win.locator('.stage-body table.data tbody tr.clickable');
    await waitCount(rows, 2);
    for (const [i, name] of [[0, 'minutes-1.pdf'], [1, 'minutes-2.pdf']]) {
      await rows.nth(i).click();
      await win.getByRole('heading', { name: 'تفاصيل الجلسة' }).waitFor();
      await win.getByRole('button', { name: 'إرفاق ضبط' }).click();
      await attachViaDialog(win, makePdf(path.join(files, name), `Minutes of hearing ${i + 1}`));
      await saveModal(win, 'حفظ المرفق');
      await expectToast(win, /حُفظ المرفق/);
      await win.locator('.doc-list-item').first().waitFor();
      if (i === 1) {
        await win.getByRole('button', { name: 'تسجيل طلب' }).click();
        const rm = modal(win);
        await rm.getByLabel('نص الطلب').fill('تقديم كشف الرواتب للمدعي');
        await rm.getByLabel('صاحب الطلب').fill('المحكمة');
        await saveModal(win);
        await win.getByRole('button', { name: 'تحويل إلى مهمة' }).click();
        await saveModal(win, 'إنشاء المهمة');
        await expectToast(win, /أُنشئت المهمة/);
        await win.locator('.modal').getByText('بانتظار البدء').waitFor();
        await shot(win, '03-hearing-detail');
      }
      await win.locator('.overlay .modal-head').getByRole('button', { name: 'إغلاق' }).click();
    }

    // مذكرة مسودة ثم سجل تقديم مستقل
    await win.locator('.file-head').getByRole('button', { name: 'إضافة' }).click();
    await win.getByRole('menu').getByRole('button', { name: 'مذكرة' }).click();
    m = modal(win);
    await m.getByLabel('عنوان المذكرة').fill('مذكرة جوابية خيالية');
    await m.getByLabel('النوع').selectOption('reply');
    await saveModal(win, 'إنشاء وفتح المحرر');
    await win.getByLabel('نص المذكرة').fill('بسم الله الرحمن الرحيم\nنص المذكرة الجوابية الخيالي للاختبار.');
    await win.locator('.save-state.saved').waitFor({ timeout: 15000 });
    await win.getByText('مسودة', { exact: true }).first().waitFor();
    await win.getByRole('button', { name: 'اعتماد داخلي' }).click();
    await win.locator('.badge').filter({ hasText: 'معتمدة داخليًا' }).first().waitFor();
    await win.getByRole('button', { name: 'تسجيل التقديم للجهة' }).click();
    m = modal(win);
    await m.getByLabel('الجهة المقدَّم إليها').fill('المحكمة العمالية التجريبية');
    await saveModal(win, 'تسجيل التقديم');
    await expectToast(win, /سُجّل تقديم المذكرة/);
    await win.locator('.badge').filter({ hasText: 'مقدمة للجهة' }).first().waitFor();
    assert.equal(await win.getByLabel('نص المذكرة').getAttribute('readonly'), '');
    await shot(win, '04-memo-submitted');

    // حكم
    await go(win, `/cases/${ids.labor}?tab=stages`);
    await win.getByRole('button', { name: 'إضافة حكم' }).click();
    m = modal(win);
    await m.getByLabel('رقم الحكم / الصك').fill('ح/123');
    await m.getByLabel('تاريخ الحكم').fill(riyadhDate(-20));
    await m.getByLabel('خلاصة المنطوق (يكتبها المستخدم)').fill('حكمت الدائرة بإلزام الشركة بجزء من المطالبة (خيالي).');
    await saveModal(win);
    await expectToast(win, /سُجل الحكم/);
    await win.getByText('مسجل — لم يُدرس').first().waitFor();

    // مرحلة الاستئناف وجلستها
    await win.getByRole('button', { name: /إضافة مرحلة/ }).click();
    m = modal(win);
    assert.equal(await m.getByLabel(L('المرحلة')).inputValue(), 'الاستئناف');
    await m.getByLabel('رقم القضية الرسمي في هذه المرحلة').fill('4470055555');
    await m.getByLabel('تاريخ البدء').fill(riyadhDate(-10));
    await saveModal(win);
    await expectToast(win, /أُضيفت المرحلة/);
    await win.getByRole('button', { name: 'إضافة جلسة' }).first().click();
    m = modal(win);
    await m.getByLabel(L('التاريخ')).fill(riyadhDate(9));
    await m.getByLabel(L('الوقت')).fill('11:00');
    await saveModal(win);
    await expectToast(win, /أُضيفت الجلسة/);
    await win.locator('.stage').filter({ hasText: 'الدرجة الأولى' }).first().waitFor();
    await win.locator('.stage-head').filter({ hasText: 'الاستئناف' }).getByText('بعد الدرجة الأولى').waitFor();
    const headerStage = await win.locator('.file-head .meta').first().innerText();
    assert.match(headerStage, /الاستئناف/);
    await shot(win, '05-stages');
  });

  it('4. البحث باسم الشركة والوصول للقضايا والمستندات والمواعيد من صفحتها', { timeout: 180000 }, async () => {
    const { win } = A;
    await win.getByLabel('البحث العام').fill('شركه المثال');
    await win.getByLabel('البحث العام').press('Enter');
    await win.getByRole('heading', { name: 'نتائج البحث' }).waitFor();
    await win.locator('li').filter({ hasText: COMPANY }).first().click();
    await win.getByRole('heading', { name: COMPANY }).waitFor();
    await win.getByRole('tab', { name: /القضايا/ }).click();
    await waitCount(win.locator('table.data tbody tr.clickable'), 2);
    await win.getByRole('tab', { name: /المستندات/ }).click();
    const minutes = win.locator('.doc-list-item').filter({ hasText: 'minutes' });
    await waitCount(minutes, 2);
    await minutes.first().click();
    await win.locator('.viewer-canvas canvas').waitFor({ timeout: 20000 });
    await win.locator('.viewer').getByText('ضبط جلسة').first().waitFor();
    await win.getByRole('tab', { name: 'الملخص' }).click();
    await win.getByText('المواعيد القادمة من كل القضايا').waitFor();
    await win.locator('.card').filter({ hasText: 'المواعيد القادمة من كل القضايا' }).getByText('جلسة').first().waitFor();
    await shot(win, '06-client-docs-search');
  });

  it('5. تحليل يدوي وربط واقعة بدليل، ومهمة للطلب الوارد في الجلسة', { timeout: 180000 }, async () => {
    const { win } = A;
    await go(win, `/cases/${ids.labor}?tab=analysis`);
    await win.getByRole('button', { name: 'فتح صفحة التحليل' }).click();
    await win.getByRole('heading', { name: 'تحليل القضية' }).waitFor();
    await win.getByLabel('الوقائع وتسلسلها').fill('التحق المدعي بالعمل في 2020 وانتهت العلاقة في 2025 (وقائع خيالية).');
    await win.getByLabel(L('الطلبات')).fill('مستحقات نهاية الخدمة.');
    await win.locator('.save-state.saved').waitFor({ timeout: 15000 });
    await win.getByRole('button', { name: 'إضافة بند' }).click();
    const m = modal(win);
    await m.getByLabel('الواقعة أو الطلب').fill('تاريخ انتهاء العلاقة العمالية');
    await m.getByLabel('درجة الثبوت').selectOption('confirmed');
    await m.getByLabel('المستند المؤيد').selectOption({ index: 1 });
    await m.getByLabel('الموضع في المستند').fill('ص 1');
    await saveModal(win);
    await expectToast(win, /حُفظ البند/);
    await win.getByRole('cell', { name: 'مؤكدة بمستند' }).waitFor();
    // حماية النص غير المحفوظ: الانتقال فورًا بعد الكتابة يحفظ النص قبل المغادرة
    await win.locator('.collapsible .c-head').filter({ hasText: 'نقاط القوة' }).click();
    await win.getByLabel('نقاط القوة').fill('وجود عقد عمل موقع.');
    await nav(win, 'المهام');
    await win.getByRole('heading', { name: 'المهام', exact: true }).waitFor();
    await win.getByRole('cell', { name: /تقديم كشف الرواتب/ }).waitFor();
    await go(win, `/cases/${ids.labor}/analysis`);
    assert.equal(await win.getByLabel('نقاط القوة').inputValue(), 'وجود عقد عمل موقع.');
    await shot(win, '07-analysis');
  });

  it('6. تسجيل دفعة دون تكرار إجمالي العقد الشامل بين القضايا', { timeout: 180000 }, async () => {
    const { win } = A;
    await go(win, `/clients/${ids.clientId}?tab=fees`);
    await win.getByRole('button', { name: 'تسجيل دفعة' }).first().click();
    const m = modal(win);
    await m.getByLabel(L('العقد')).selectOption({ label: 'عقد أتعاب شامل 2026' });
    await m.getByLabel(L('المبلغ')).fill('40000');
    await m.getByLabel('رقم السند / المرجع').fill('TRX-1');
    await saveModal(win);
    await expectToast(win, /سُجلت الدفعة/);
    const stats = await win.locator('.stat').allInnerTexts();
    assert.match(stats[0], /100,000\.00/);
    assert.doesNotMatch(stats[0], /200,000/);
    assert.match(stats[2], /60,000\.00/);
    await go(win, '/');
    await win.locator('.stat').filter({ hasText: 'المستحقات المسجلة' }).getByText(/60,000\.00/).waitFor();
    await shot(win, '08-fees');
  });

  it('13. جدول أتعاب القضية: مبلغ القضية والمقدم والمسدد والمتبقي', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'العملاء والشركات');
    await win.getByRole('button', { name: 'إضافة عميل' }).click();
    let m = modal(win);
    await m.getByLabel('نوع العميل').selectOption('individual');
    await m.getByLabel(L('الاسم')).fill('عميل الأتعاب الخيالي');
    await saveModal(win);
    await win.getByRole('heading', { name: 'عميل الأتعاب الخيالي' }).waitFor();
    await win.getByRole('button', { name: 'إضافة قضية' }).first().click();
    m = modal(win);
    await m.getByLabel('عنوان القضية').fill('قضية مطالبة مالية خيالية');
    await m.getByRole('checkbox', { name: 'تسجيل المرحلة الأولى الآن' }).uncheck();
    await saveModal(win);
    await win.getByRole('heading', { name: 'قضية مطالبة مالية خيالية' }).waitFor();
    ids.feesCase = caseIdFromUrl(win);
    const card = win.locator('.card').filter({ has: win.getByRole('heading', { name: 'أتعاب القضية' }) });
    await card.getByRole('button', { name: 'تحديد أتعاب القضية' }).click();
    m = modal(win);
    assert.match(await m.getByLabel('عنوان العقد').inputValue(), /أتعاب قضية/);
    await m.getByLabel('الأتعاب الثابتة (إجمالي العقد)').fill('10000');
    await saveModal(win);
    await expectToast(win, /سُجل العقد/);
    await card.getByRole('button', { name: 'تسجيل دفعة' }).click();
    m = modal(win);
    await m.getByLabel(L('المبلغ')).fill('3000');
    await m.getByRole('checkbox', { name: 'دفعة مقدمة (عربون)' }).check();
    await saveModal(win);
    await expectToast(win, /سُجلت الدفعة المقدمة/);
    await card.getByRole('button', { name: 'تسجيل دفعة' }).click();
    m = modal(win);
    await m.getByLabel(L('المبلغ')).fill('2000');
    await saveModal(win);
    await expectToast(win, /سُجلت الدفعة/);
    const row = card.locator('table.fee-mini tbody tr').first();
    await row.getByText('5,000.00 ر.س').first().waitFor();
    const cells = await row.locator('td').allInnerTexts();
    assert.deepEqual(cells.slice(1), ['10,000.00 ر.س', '3,000.00 ر.س', '5,000.00 ر.س', '5,000.00 ر.س']);
    await shot(win, '15-case-fees-table');
    // القضية العمالية مرتبطة بعقد شامل: يظهر كذلك مع التنبيه بعدم التكرار
    await go(win, `/cases/${ids.labor}`);
    await win.getByText(/عقد شامل لـ 2 قضايا — المبالغ للعقد كاملًا/).waitFor();
  });

  it('8. منع المستشار من العمليات والملفات غير المسموحة — بما فيها استدعاء IPC مباشرة', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'المستخدمون والصلاحيات' }).click();
    await win.getByRole('row', { name: new RegExp(CONS.name) }).getByRole('button', { name: 'الملفات' }).click();
    await modal(win).getByRole('checkbox', { name: /مطالبة عمالية/ }).check();
    await saveModal(win);
    await expectToast(win, /حُفظت الملفات المسموحة/);
    await logout(win);
    await login(win, CONS.user, CONS.pass);
    await nav(win, 'القضايا');
    await win.getByRole('heading', { name: 'القضايا' }).waitFor();
    await win.locator('table.data tbody tr').first().waitFor();
    await waitCount(win.locator('table.data tbody tr.clickable'), 1);
    assert.equal(await win.locator('nav').getByRole('link', { name: 'الأتعاب' }).count(), 0);
    await go(win, `/cases/${ids.commercial}`);
    await win.getByText('لا تملك صلاحية الوصول إلى ملف هذه القضية').waitFor();
    for (const [ch, payload] of [
      ['users.list', {}],
      ['backup.create', {}],
      ['integration.state', {}],
      ['cases.get', { id: ids.commercial }],
      ['finance.clientSummary', { clientId: ids.clientId }],
      ['users.update', { id: '00000000-0000-4000-8000-000000000000', displayName: 'x', active: true, permissions: ['fees.view'] }],
    ]) {
      const r = await invoke(win, ch, payload);
      assert.equal(r.ok, false, ch);
      assert.equal(r.error.code, 'FORBIDDEN', ch);
    }
    const bad = await win.evaluate(() => window.lawApi.invoke('../../etc', {}).then(() => 'ok', (e) => String(e)));
    assert.match(bad, /قناة غير مسموحة/);
    assert.equal(await win.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await win.evaluate(() => typeof window.process), 'undefined');
    await nav(win, 'الإعدادات');
    assert.equal(await win.getByRole('tab').count(), 1);
    await shot(win, '09-consultant');
    await logout(win);
    await login(win, OWNER.user, OWNER.pass);
  });

  it('11. أسماء متشابهة، فشل رفع مرفق، تعديل موعد، أرشفة وإعادة فتح، ومنع فقد النص', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'العملاء والشركات');
    await win.getByRole('button', { name: 'إضافة عميل' }).click();
    let m = modal(win);
    await m.getByLabel('اسم الشركة / المنشأة').fill('شركة المثال التجريبيه');
    await m.getByText('يوجد عملاء مشابهون').waitFor();
    await win.keyboard.press('Escape');
    await win.getByRole('alertdialog').getByText('تغييرات غير محفوظة').waitFor();
    await win.getByRole('alertdialog').getByRole('button', { name: 'الإغلاق دون حفظ' }).click();

    await go(win, `/cases/${ids.labor}?tab=docs`);
    await win.getByRole('button', { name: 'إرفاق مستند' }).click();
    const fake = path.join(files, 'fake.pdf');
    fs.writeFileSync(fake, 'MZ this is not really a pdf');
    await mockOpen(A.app, fake);
    await modal(win).getByRole('button', { name: 'اختيار ملف' }).click();
    await modal(win).getByText(/لا يطابق امتداده/).waitFor();
    await saveModal(win, 'حفظ المرفق');
    await modal(win).getByText('اختر الملف أولًا').waitFor();
    await modal(win).locator('.modal-foot').getByRole('button', { name: 'إلغاء' }).click();

    await go(win, `/cases/${ids.labor}?tab=stages`);
    const appealRow = win.locator('.stage').filter({ hasText: 'الاستئناف' }).locator('table.data tbody tr').first();
    await appealRow.click();
    await win.getByRole('button', { name: /تعديل \/ تحديث النتيجة/ }).click();
    m = modal(win);
    await m.getByLabel(L('التاريخ')).fill(riyadhDate(12));
    await m.getByLabel('سبب تعديل الموعد').fill('تأجيل بقرار الدائرة');
    await saveModal(win);
    await expectToast(win, /حُفظت الجلسة/);
    await win.getByText('أثر التعديلات على الجلسة').waitFor();
    await win.getByText(/السبب: تأجيل بقرار الدائرة/).waitFor();
    await win.locator('.overlay .modal-head').getByRole('button', { name: 'إغلاق' }).click();

    await go(win, `/cases/${ids.commercial}`);
    await win.getByRole('button', { name: 'إقفال' }).click();
    m = modal(win);
    await m.getByLabel('النتيجة المسجلة').fill('انتهى النزاع صلحًا (خيالي)');
    await m.getByRole('checkbox', { name: /أؤكد قرار إقفال الملف/ }).check();
    await saveModal(win, 'تأكيد الإقفال');
    await expectToast(win, /أُقفل الملف/);
    await win.locator('.file-head').getByRole('button', { name: 'أرشفة' }).click();
    await saveModal(win, 'أرشفة');
    await win.getByText('الملف مؤرشف:').waitFor();
    await win.locator('.file-head').getByRole('button', { name: 'إلغاء الأرشفة' }).click();
    await win.locator('.file-head').getByRole('button', { name: 'إعادة فتح' }).click();
    m = modal(win);
    await m.getByLabel('سبب إعادة الفتح').fill('استأنف الخصم (خيالي)');
    await saveModal(win, 'إعادة الفتح');
    await win.locator('.file-head .badge').filter({ hasText: 'مفتوحة' }).waitFor();
    await win.getByRole('tab', { name: 'السجل الزمني' }).click();
    await win.locator('.tl-title').filter({ hasText: /إقفال ملف/ }).waitFor();
    await win.locator('.tl-title').filter({ hasText: /إعادة فتح/ }).waitFor();
    await shot(win, '10-timeline');
  });

  it('10. طباعة تقرير عربي وحفظه PDF للمراجعة البصرية', { timeout: 180000 }, async () => {
    const { win } = A;
    await go(win, `/cases/${ids.labor}`);
    await win.locator('.file-head').getByRole('button', { name: 'تقرير' }).click();
    await win.getByRole('heading', { name: 'التقارير' }).waitFor();
    await win.getByRole('checkbox', { name: 'تضمين الأتعاب' }).check();
    await win.getByRole('button', { name: 'معاينة' }).click();
    await win.frameLocator('iframe.iframe-report').getByText('تقرير موقف قضية').waitFor();
    const pdf = path.join(OUT, 'case-report.pdf');
    fs.rmSync(pdf, { force: true });
    await mockSave(A.app, pdf);
    await win.getByRole('button', { name: 'حفظ PDF' }).click();
    await expectToast(win, /حُفظ التقرير PDF/);
    assert.ok(fs.statSync(pdf).size > 10000);
    assert.equal(fs.readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
    try {
      execFileSync('pdftoppm', ['-png', '-r', '70', '-f', '1', '-l', '2', pdf, path.join(OUT, 'case-report-page')]);
    } catch {
      /* أداة التحويل غير متوفرة */
    }
    await shot(win, '11-report-preview');
  });

  it('12. وحدة التكامل: غير المفعلة لا تتيح بيانات، والمفعلة تحترم النطاق ولا تكتب', { timeout: 180000 }, async () => {
    const { win } = A;
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: /الربط بأدوات/ }).click();
    await win.getByText('غير مفعّل', { exact: true }).waitFor();
    await win.getByRole('checkbox', { name: /فهمت أن النص المسموح/ }).check();
    await win.getByRole('button', { name: 'تفعيل وحدة التكامل' }).click();
    await win.getByRole('button', { name: 'إصدار رمز ربط' }).click();
    const m = modal(win);
    await m.getByLabel('اسم الربط').fill('اختبار Claude Code');
    await m.getByRole('checkbox', { name: /مطالبة عمالية/ }).check();
    await saveModal(win, 'إصدار الرمز');
    const token = (await win.locator('.code-box').innerText()).trim();
    assert.match(token, /^lom_/);
    await win.locator('pre.snippet').first().waitFor();
    await shot(win, '12-integration-token');
    await modal(win).locator('.modal-foot').getByRole('button', { name: 'تم' }).click();
    const exe = process.env.LAWOFFICE_EXEC || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
    const script = process.env.LAWOFFICE_MCP_SCRIPT || path.join(ROOT, 'dist', 'mcp', 'server.js');
    const transport = new StdioClientTransport({ command: exe, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LAWOFFICE_DATA_DIR: dataA, LAWOFFICE_MCP_TOKEN: token }, stderr: 'pipe' });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /write|create|update|delete|sql|exec/i.test(t)));
    const found = JSON.parse((await client.callTool({ name: 'find_cases', arguments: { query: 'المثال' } })).content[0].text);
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].case_id, ids.labor);
    const denied = await client.callTool({ name: 'get_case_summary', arguments: { case_id: ids.commercial } });
    assert.equal(denied.isError, true);
    const summary = JSON.parse((await client.callTool({ name: 'get_case_summary', arguments: { case_id: ids.labor } })).content[0].text);
    assert.equal(summary.current_stage.official_case_no, '4470055555');
    assert.ok(summary.memos.some((x) => x.submitted_on));
    await win.getByRole('button', { name: 'تعطيل التكامل' }).click();
    await win.getByRole('alertdialog').getByRole('button', { name: 'تعطيل' }).click();
    await win.getByText('غير مفعّل', { exact: true }).waitFor();
    const off = await client.callTool({ name: 'find_cases', arguments: { query: 'المثال' } });
    assert.equal(off.isError, true);
    await client.close();
  });

  it('9. نسخة احتياطية واستعادتها إلى مساحة اختبار، وحزمة تالفة لا تتلف البيانات', { timeout: 180000 }, async () => {
    const { win } = A;
    const pkg = path.join(OUT, 'backup-e2e.lobk');
    fs.rmSync(pkg, { force: true });
    await mockSave(A.app, pkg);
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'مكان الحفظ والنسخ الاحتياطي' }).click();
    await win.getByRole('button', { name: 'إنشاء نسخة احتياطية الآن' }).click();
    await expectToast(win, /حُفظت الحزمة/);
    assert.ok(fs.existsSync(pkg));
    const corrupt = path.join(OUT, 'corrupt.lobk');
    // حزمة تالفة: نُسخت ناقصة (انقطاع أثناء النسخ)
    const buf = fs.readFileSync(pkg);
    fs.writeFileSync(corrupt, buf.subarray(0, Math.floor(buf.length * 0.6)));
    await mockOpen(A.app, corrupt);
    await win.getByRole('button', { name: 'استعادة من نسخة' }).click();
    await expectToast(win, /رُفضت الحزمة/);
    await nav(win, 'العملاء والشركات');
    await win.getByRole('cell', { name: new RegExp(COMPANY) }).waitFor();

    const dataB = tmpWorkspace('restore');
    const B = await launch(dataB);
    try {
      const w = B.win;
      await w.getByLabel('اسمك كما يظهر في البرنامج').fill('مختبر الاستعادة');
      await w.getByLabel('اسم المستخدم').fill('tester');
      await w.locator('input[type=password]').nth(0).fill('Tester#Pass2026');
      await w.locator('input[type=password]').nth(1).fill('Tester#Pass2026');
      await w.getByRole('button', { name: 'إنشاء الحساب' }).click();
      await w.getByRole('checkbox').check();
      await w.getByRole('button', { name: 'متابعة' }).click();
      await w.locator('nav').getByRole('link', { name: 'الإعدادات' }).click();
      await w.getByRole('tab', { name: 'مكان الحفظ والنسخ الاحتياطي' }).click();
      await mockOpen(B.app, pkg);
      await w.getByRole('button', { name: 'استعادة من نسخة' }).click();
      await w.getByRole('heading', { name: 'تأكيد الاستعادة' }).waitFor();
      await shot(w, '13-restore-confirm');
      await w.getByRole('button', { name: 'استبدال البيانات الحالية بالنسخة' }).click();
      await w.getByRole('button', { name: 'تسجيل الدخول' }).waitFor({ timeout: 30000 });
      await login(w, OWNER.user, OWNER.pass);
      await go(w, `/clients/${ids.clientId}?tab=docs`);
      await waitCount(w.locator('.doc-list-item').filter({ hasText: 'minutes' }), 2);
      await w.locator('.doc-list-item').filter({ hasText: 'minutes' }).first().click();
      await w.locator('.viewer-canvas canvas').waitFor({ timeout: 20000 });
      const r = await invoke(w, 'finance.clientSummary', { clientId: ids.clientId });
      assert.equal(r.data.agreed, 10000000);
      assert.equal(r.data.paid, 4000000);
      const ca = await invoke(w, 'contracts.list', { clientId: ids.clientId });
      assert.equal(ca.data[0].cases.length, 2);
      const integrity = await invoke(w, 'system.verifyAttachments', { hash: true });
      assert.equal(integrity.data.missing.length + integrity.data.corrupted.length, 0);
    } finally {
      await B.app.close();
    }
  });

  it('7. إغلاق البرنامج وإعادة فتحه دون شبكة، بعد نقل الملفات الأصلية خارج البرنامج', { timeout: 180000 }, async () => {
    fs.rmSync(files, { recursive: true, force: true }); // الأصول خارج البرنامج لم تعد موجودة
    await A.app.close();
    A = await launch(dataA, { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' });
    const { win } = A;
    await login(win, OWNER.user, OWNER.pass);
    await go(win, `/cases/${ids.labor}?tab=docs`);
    await win.locator('.doc-list-item').filter({ hasText: 'minutes-2.pdf' }).click();
    await win.locator('.viewer-canvas canvas').waitFor({ timeout: 20000 });
    await win.getByRole('button', { name: 'النص المستخرج' }).click();
    await win.getByText('Minutes of hearing 2').waitFor();
    const r = await invoke(win, 'cases.get', { id: ids.labor });
    assert.equal(r.data.counts.hearings, 3);
    assert.equal(r.data.counts.memos, 1);
    const sum = await invoke(win, 'finance.clientSummary', { clientId: ids.clientId });
    assert.equal(sum.data.remaining, 6000000);
    await shot(win, '14-after-restart');
    assert.deepEqual(A.errors.filter((e) => !/ResizeObserver/.test(e)), []);
  });
});

async function go(win, hashPath) {
  await win.goto(win.url().split('#')[0] + '#' + hashPath);
}

async function waitCount(loc, n, timeout = 15000) {
  const end = Date.now() + timeout;
  let c = -1;
  while (Date.now() < end) {
    c = await loc.count();
    if (c === n) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(c, n, 'عدد العناصر');
}

function L(t) {
  return new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(\\s*\\*)?$');
}

const PERMS = { fees: 'الاطلاع على الأتعاب والدفعات والمصاريف' };
