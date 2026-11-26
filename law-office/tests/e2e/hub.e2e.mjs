// تشغيل فعلي: نسختان من البرنامج (جهاز المكتب + الماك) ومتصفح بمقاس iPhone عبر الرابط الآمن — بيانات خيالية.
// رسائل رموز التحقق تُكتب في ملف اختبار بدل إرسالها (LAWOFFICE_TEST_MAILBOX).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { launch, tmpWorkspace, nav, shot, modal, invoke, makePdf, OUT } from './lib.mjs';

const OWNER = { name: 'أ. محمد الخيالي', user: 'owner', pass: 'Office#Pass-2026' };
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const box = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lom-mail-')), 'mail.jsonl');
const lastCode = () => /(\d{6})/.exec(fs.readFileSync(box, 'utf8').trim().split('\n').pop())[1];
let A, M, browser, phone;
const macDir = tmpWorkspace('hub-mac');

async function setup(win, name, user, pass) {
  await win.getByLabel('اسمك كما يظهر في البرنامج').fill(name);
  await win.getByLabel('اسم المستخدم').fill(user);
  await win.locator('input[type=password]').nth(0).fill(pass);
  await win.locator('input[type=password]').nth(1).fill(pass);
  await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await win.getByTestId('recovery-code').waitFor();
  await win.getByRole('checkbox').check();
  await win.getByRole('button', { name: 'متابعة' }).click();
  await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();
}
const names = async (win) => {
  const r = await invoke(win, 'clients.list', {});
  return (r.data.items ?? r.data).map((c) => c.name);
};

describe('خادم المكتب المحلي: جهاز المكتب + الماك + الآيفون عبر الرابط الآمن', () => {
  before(async () => {
    A = await launch(tmpWorkspace('hub-office'), { LAWOFFICE_TEST_MAILBOX: box });
    M = await launch(macDir, { LAWOFFICE_TEST_MAILBOX: box });
    browser = await chromium.launch();
  });
  after(async () => {
    await phone?.context().close();
    await browser?.close();
    await A?.app.close();
    await M?.app.close();
  });

  it('1. جهاز المكتب: إنشاء المكتب وتشغيل خادم المكتب من الإعدادات', { timeout: 120000 }, async () => {
    const { win } = A;
    await setup(win, OWNER.name, OWNER.user, OWNER.pass);
    assert.equal((await invoke(win, 'clients.create', { kind: 'individual', name: 'عميل في جهاز المكتب', phone: '0500000101' })).ok, true);
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'ربط الأجهزة بجهاز المكتب' }).click();
    await win.getByLabel('المنفذ').fill(String(PORT));
    await win.getByRole('button', { name: 'تشغيل خادم المكتب' }).click();
    await win.getByText('يعمل', { exact: true }).waitFor();
    const st = await invoke(win, 'hub.state', {});
    const owner = st.data.users[0];
    await win.getByLabel(`بريد ${owner.display_name}`).fill('owner.office@gmail.com');
    await win.getByRole('row', { name: new RegExp(owner.display_name) }).getByRole('button', { name: 'حفظ' }).click();
    await win.getByText('حُفظ البريد').first().waitFor();
    await shot(win, 'hub-01-office-server');
  });

  it('2. الآيفون: الدخول عبر الرابط برمز البريد، وإضافة عميل وملف يُحفظان في جهاز المكتب', { timeout: 180000 }, async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, locale: 'ar' });
    phone = await ctx.newPage();
    const errors = [];
    phone.on('pageerror', (e) => errors.push(e.message));
    phone.setDefaultTimeout(20000);
    await phone.goto(BASE + '/');
    await phone.getByLabel('اسم المستخدم').fill(OWNER.user);
    await phone.getByLabel('كلمة المرور').fill(OWNER.pass);
    await shot(phone, 'hub-02-iphone-login');
    await phone.getByRole('button', { name: 'دخول' }).click();
    await phone.getByLabel('رمز التحقق').waitFor();
    await shot(phone, 'hub-03-iphone-code');
    await phone.getByLabel('رمز التحقق').fill(lastCode());
    await phone.getByRole('button', { name: 'تحقق' }).click();
    await phone.getByRole('heading', { name: /مرحبًا/ }).waitFor();
    await shot(phone, 'hub-04-iphone-home');
    const c = await phone.evaluate(() => window.lawApi.invoke('clients.create', { kind: 'individual', name: 'عميل أضيف من الآيفون', phone: '0500000202' }));
    assert.equal(c.ok, true);
    const pdf = makePdf(path.join(OUT, 'iphone-upload.pdf'), 'Uploaded from iPhone');
    const chooser = phone.waitForEvent('filechooser');
    const staged = phone.evaluate(() => window.lawApi.invoke('documents.pickFile', {}));
    await (await chooser).setFiles(pdf);
    const st = await staged;
    assert.equal(st.ok, true, JSON.stringify(st));
    const doc = await phone.evaluate(([cid, token]) => window.lawApi.invoke('documents.create', { title: 'مستند من الآيفون', category: 'other', clientId: cid, token }), [c.data.id, st.data.token]);
    assert.equal(doc.ok, true, JSON.stringify(doc));
    // محفوظ في جهاز المكتب نفسه
    assert.ok((await names(A.win)).includes('عميل أضيف من الآيفون'));
    const docs = await invoke(A.win, 'documents.list', { clientId: c.data.id });
    assert.equal(JSON.stringify(docs.data).includes('مستند من الآيفون'), true);
    await nav(phone, 'العملاء والشركات').catch(async () => {
      await phone.getByRole('button', { name: 'القائمة' }).click();
      await nav(phone, 'العملاء والشركات');
    });
    await phone.getByText('عميل أضيف من الآيفون').first().waitFor();
    await shot(phone, 'hub-05-iphone-clients');
    const w = await phone.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth }));
    assert.ok(w.sw <= w.iw, JSON.stringify(w));
    // عمليات جهاز المكتب غير متاحة عبر الرابط
    assert.equal((await phone.evaluate(() => window.lawApi.invoke('backup.create', {}))).error.code, 'UNSUPPORTED');
    assert.deepEqual(errors, []);
  });

  it('3. الآيفون: الخروج ثم الدخول من الجهاز نفسه دون رمز', { timeout: 120000 }, async () => {
    const before = fs.readFileSync(box, 'utf8').split('\n').length;
    await Promise.all([phone.waitForEvent('load'), phone.evaluate(() => void window.lawApi.invoke('auth.logout', {}))]);
    await phone.getByRole('button', { name: 'دخول' }).waitFor();
    await phone.getByLabel('اسم المستخدم').fill(OWNER.user);
    await phone.getByLabel('كلمة المرور').fill(OWNER.pass);
    await phone.getByRole('button', { name: 'دخول' }).click();
    await phone.locator('.app').waitFor().catch(async (e) => {
      await shot(phone, 'fail-3');
      console.log('PHONE TEXT', (await phone.locator('body').innerText()).slice(0, 400));
      throw e;
    });
    assert.equal(fs.readFileSync(box, 'utf8').split('\n').length, before);
  });

  it('4. الماك: ربطه بجهاز المكتب من الإعدادات (نسخة احتياطية ثم استبدال)، والدخول بحساب المكتب', { timeout: 180000 }, async () => {
    const { win } = M;
    await setup(win, 'مستخدم الماك', 'macuser', 'Mac#Pass-2026x');
    await invoke(win, 'clients.create', { kind: 'individual', name: 'بيانات تجريبية على الماك', phone: '0500000303' });
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'ربط الأجهزة بجهاز المكتب' }).click();
    await win.getByLabel('الرابط الآمن لجهاز المكتب').fill(BASE);
    await win.getByLabel('اسم المستخدم في المكتب').fill(OWNER.user);
    await win.locator('form').filter({ hasText: 'الرابط الآمن لجهاز المكتب' }).getByLabel('كلمة المرور').fill(OWNER.pass);
    await win.getByRole('button', { name: 'متابعة' }).click();
    await win.getByLabel('رمز التحقق (6 أرقام)').waitFor();
    await win.getByLabel('رمز التحقق (6 أرقام)').fill(lastCode());
    await shot(win, 'hub-06-mac-link');
    await win.getByRole('button', { name: 'تحقق واربط' }).click();
    await win.getByRole('button', { name: 'ربط واستبدال' }).click();
    // حسابات الماك استُبدلت بحسابات المكتب ← شاشة الدخول
    await win.getByLabel('اسم المستخدم').waitFor({ timeout: 60000 }).catch(async (e) => {
      await shot(win, 'fail-4');
      console.log('MAC TEXT', (await win.locator('main').innerText()).split('ربط هذا الجهاز بجهاز المكتب')[1], '\nTOASTS', await win.locator('[role=status], .toast, [role=alert]').allInnerTexts());
      throw e;
    });
    await win.getByLabel('اسم المستخدم').fill(OWNER.user);
    await win.locator('input[type=password]').first().fill(OWNER.pass);
    await win.getByRole('button', { name: /دخول/ }).first().click();
    await win.locator('.app').waitFor();
    const n = await names(win);
    assert.ok(n.includes('عميل في جهاز المكتب') && n.includes('عميل أضيف من الآيفون'), n.join('|'));
    assert.ok(!n.includes('بيانات تجريبية على الماك'));
    const backups = fs.readdirSync(path.join(macDir, 'backups', 'auto')).filter((f) => f.includes('قبل-الربط-بجهاز-المكتب'));
    assert.ok(backups.length >= 1, 'pre-link backup exists');
    await win.locator('.cloud-chip').waitFor();
    await shot(win, 'hub-07-mac-linked');
  });

  it('5. الماك يضيف عميلًا ← يصل لجهاز المكتب وللآيفون', { timeout: 120000 }, async () => {
    await invoke(M.win, 'clients.create', { kind: 'individual', name: 'عميل أضيف من الماك', phone: '0500000404' });
    await invoke(M.win, 'hub.syncNow', {});
    assert.ok((await names(A.win)).includes('عميل أضيف من الماك'));
    const r = await phone.evaluate(() => window.lawApi.invoke('clients.list', {}));
    assert.ok(JSON.stringify(r.data).includes('عميل أضيف من الماك'));
  });

  it('6. إلغاء الآيفون من جهاز المكتب يمنعه فورًا', { timeout: 60000 }, async () => {
    const st = await invoke(A.win, 'hub.state', {});
    const web = st.data.devices.find((d) => d.kind === 'web');
    await invoke(A.win, 'hub.revokeDevice', { id: web.id });
    await phone.reload();
    await phone.getByLabel('اسم المستخدم').waitFor();
    const r = await phone.evaluate(() => fetch('/api/dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'clients.list', payload: {} }) }).then((x) => x.json()));
    assert.equal(r.error.code, 'UNAUTHENTICATED');
    await nav(A.win, 'الإعدادات');
    await A.win.getByRole('tab', { name: 'ربط الأجهزة بجهاز المكتب' }).click();
    await A.win.getByText('الأجهزة المرتبطة').waitFor();
    await shot(A.win, 'hub-08-office-devices');
  });
  it('7. إغلاق نافذة جهاز المكتب لا يوقف الخادم (يُخفى البرنامج في الخلفية)', { timeout: 60000 }, async () => {
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await new Promise((r) => setTimeout(r, 1500));
    const visible = await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
    assert.deepEqual(visible, [false]);
    const r = await fetch(BASE + '/api/web/state');
    assert.equal(r.status, 200);
    // يعود عند فتحه
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  });
});
