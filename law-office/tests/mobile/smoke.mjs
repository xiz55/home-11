// تشغيل نسخة الآيفون المبنية (dist/mobile) في متصفح بمقاس iPhone — بيانات خيالية في مخزن متصفح مؤقت.
import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist/mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const srv = http.createServer((q, s) => {
  const p = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname));
  const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(root, 'index.html');
  s.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/?testBackend`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, locale: 'ar' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const out = process.env.OUT ?? 'test-results/mobile';
fs.mkdirSync(out, { recursive: true });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const step = async (name, fn) => {
  try {
    await fn();
    console.log('✔', name);
  } catch (e) {
    console.log('✖', name, e.message.split('\n')[0]);
    await shot('fail-' + name.slice(0, 20));
    process.exitCode = 1;
  }
};
page.setDefaultTimeout(20000);
await page.goto(url);
await step('1 شاشة البداية', async () => {
  await page.getByLabel('اسمك كما يظهر في البرنامج').waitFor();
  await shot('01-setup');
});
await step('2 إنشاء حساب المالك على الآيفون', async () => {
  await page.getByLabel('اسمك كما يظهر في البرنامج').fill('أ. سالم الخيالي');
  await page.getByLabel('اسم المستخدم').fill('owner');
  await page.locator('input[type=password]').nth(0).fill('Test-Pass-2026!');
  await page.locator('input[type=password]').nth(1).fill('Test-Pass-2026!');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByTestId('recovery-code').waitFor({ timeout: 60000 });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByRole('heading', { name: /مرحبًا/ }).waitFor();
  await shot('02-home');
});
await step('3 إضافة عميل', async () => {
  const r = await page.evaluate(() => window.lawApi.invoke('clients.create', { kind: 'individual', name: 'عميل خيالي للآيفون', phone: '0500000077' }));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
});
await step('4 البقاء بعد إعادة فتح التطبيق', async () => {
  await page.evaluate(() => window.__lawHost.flush());
  await page.reload();
  await page.getByLabel('اسم المستخدم').waitFor({ timeout: 60000 });
  await page.getByLabel('اسم المستخدم').fill('owner');
  await page.locator('input[type=password]').first().fill('Test-Pass-2026!');
  await page.getByRole('button', { name: /دخول/ }).first().click();
  await page.getByRole('heading', { name: /مرحبًا/ }).waitFor();
  const r = await page.evaluate(() => window.lawApi.invoke('clients.list', {}));
  const items = r.data.items ?? r.data;
  if (!items.some((c) => c.name === 'عميل خيالي للآيفون')) throw new Error('client lost after reload');
});
await step('5 قائمة العملاء على شاشة الهاتف', async () => {
  await page.goto(url.replace('/?', '/?') + '#/clients').catch(() => undefined);
  await page.waitForTimeout(500);
  await shot('03-clients');
  const w = await page.evaluate(() => ({ iw: innerWidth, sw: document.documentElement.scrollWidth, main: Math.round(document.querySelector('.main').getBoundingClientRect().width) }));
  const over = await page.evaluate(() => [...document.querySelectorAll('.main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).slice(0, 3).map((e) => e.className));
  if (w.sw > w.iw || w.main > w.iw || over.length) throw new Error('horizontal overflow ' + JSON.stringify({ w, over }));
});
await step('5b القائمة الجانبية بالترتيب نفسه في درج منزلق', async () => {
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.waitForTimeout(400);
  const labels = await page.locator('nav .nav-label:visible').allInnerTexts();
  if (labels[0] !== 'الرئيسية' || !labels.includes('الاستشارات والاجتماعات')) throw new Error(labels.join('|'));
  await shot('04-menu');
  await page.locator('nav').getByRole('link', { name: 'القضايا', exact: true }).click();
  await page.getByRole('heading', { name: 'القضايا' }).waitFor();
  if (await page.locator('.app.nav-open').count()) throw new Error('drawer stayed open');
});
await step('6 عمليات سطح المكتب فقط تُرفض بوضوح', async () => {
  const r = await page.evaluate(() => window.lawApi.invoke('backup.create', {}));
  if (r.ok || r.error.code !== 'UNSUPPORTED') throw new Error(JSON.stringify(r));
});
console.log('errors:', JSON.stringify(errors.filter((e) => !/favicon|Autofill/.test(e))));
await browser.close();
srv.close();
