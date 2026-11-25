// نسخة الآيفون المبنية مع مكدس Supabase محلي حقيقي (انظر scripts/cloud-test-stack.sh) — بيانات خيالية:
// جهاز المكتب ينقل بياناته للسحابة، والآيفون ينضم ويستلمها، ثم يضيف ملاحظة تصل لجهاز المكتب.
import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const AUTH = 'http://127.0.0.1:9999';
const REST = 'http://127.0.0.1:54401';
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const b64u = (b) => Buffer.from(b).toString('base64url');
const jwt = (p) => {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: 'supabase-test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...p }));
  return `${h}.${body}.${b64u(createHmac('sha256', SECRET).update(`${h}.${body}`).digest())}`;
};
const ANON = jwt({ role: 'anon' });
const SERVICE = jwt({ role: 'service_role' });

const root = path.resolve('dist/mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const m = u.pathname.match(/^\/(auth|rest)\/v1(\/.*)?$/);
  if (m) {
    const target = new URL((m[2] ?? '/') + u.search, m[1] === 'auth' ? AUTH : REST);
    const p = http.request(target, { method: q.method, headers: { ...q.headers, host: target.host } }, (r) => {
      s.writeHead(r.statusCode, r.headers);
      r.pipe(s);
    });
    p.on('error', () => s.writeHead(502).end());
    return q.pipe(p);
  }
  const p = path.join(root, decodeURIComponent(u.pathname));
  const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(root, 'index.html');
  s.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const email = `owner-${Date.now()}@example.test`;
const password = 'Cloud#Owner-Pass-2026';
const cr = await fetch(`${AUTH}/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
if (!cr.ok) throw new Error('admin create user ' + cr.status);

const browser = await chromium.launch();
const errors = [];
async function device(name, dev) {
  const ctx = await browser.newContext({ ...dev, locale: 'ar' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.setDefaultTimeout(30000);
  await page.goto(`${base}/?testBackend`);
  await page.waitForFunction(() => !!window.lawApi);
  const call = async (ch, p = {}) => {
    const r = await page.evaluate(([c, x]) => window.lawApi.invoke(c, x), [ch, p]);
    if (!r.ok) throw new Error(`${name} ${ch}: ${r.error.code} ${r.error.message}`);
    return r.data;
  };
  return { page, call };
}
let ok = true;
const step = async (n, fn) => {
  try {
    await fn();
    console.log('✔', n);
  } catch (e) {
    ok = false;
    console.log('✖', n, e.message.split('\n')[0]);
  }
};

const A = await device('office', devices['Desktop Chrome']);
const I = await device('iphone', { ...devices['iPhone 15'], deviceScaleFactor: 1 });
let officeId;
await step('1 جهاز المكتب: إعداد محلي وبيانات ثم نقلها للسحابة', async () => {
  await A.call('auth.setupOwner', { officeName: 'مكتب تجريبي — بيانات خيالية', displayName: 'المالك التجريبي', username: 'owner', password: 'Owner#Pass2026' });
  await A.call('clients.create', { kind: 'individual', name: 'عميل خيالي للمزامنة', phone: '0500000088' });
  await A.call('cloud.configure', { url: base, anonKey: ANON });
  const s = await A.call('cloud.signIn', { email, password });
  if (!s.needsOffice) throw new Error(JSON.stringify(s));
  officeId = (await A.call('cloud.createOffice', {})).officeId;
  const r = await A.call('cloud.syncNow', {});
  if (r.rejected) throw new Error('rejected ' + r.rejected);
});
await step('2 الآيفون: ربط الجهاز بالحساب واختيار المكتب، ووصول البيانات', async () => {
  await I.call('cloud.configure', { url: base, anonKey: ANON });
  const s = await I.call('cloud.signIn', { email, password });
  if (!s.needsOffice) throw new Error(JSON.stringify(s));
  await I.call('cloud.joinOffice', { officeId });
  const list = await I.call('clients.list', {});
  const items = list.items ?? list;
  if (!items.some((c) => c.name === 'عميل خيالي للمزامنة')) throw new Error('client missing on iPhone');
  const st = await I.call('cloud.status', {});
  if (st.phase !== 'idle' || st.pending !== 0) throw new Error(JSON.stringify(st));
});
await step('3 الآيفون يضيف عميلًا، فيصل لجهاز المكتب بعد المزامنة', async () => {
  await I.call('clients.create', { kind: 'individual', name: 'عميل أضيف من الآيفون', phone: '0500000066' });
  await I.call('cloud.syncNow', {});
  await A.call('cloud.syncNow', {});
  const items = ((await A.call('clients.list', {})).items ?? (await A.call('clients.list', {})));
  if (!items.some((c) => c.name === 'عميل أضيف من الآيفون')) throw new Error('not received on office device');
});
await step('4 الآيفون: البيانات والجلسة السحابية تبقى بعد إعادة فتح التطبيق', async () => {
  await I.page.evaluate(() => window.__lawHost.flush());
  await I.page.reload();
  await I.page.waitForFunction(() => !!window.lawApi);
  const st = await I.page.evaluate(() => window.lawApi.invoke('auth.state', {}));
  if (!st.data.cloudLinked) throw new Error('not linked after reload');
});
await step('5 واجهة الآيفون: شاشة الدخول بالحساب السحابي وحالة المزامنة', async () => {
  await I.page.getByText('الدخول بحساب المكتب').first().waitFor();
  fs.mkdirSync('test-results/mobile', { recursive: true });
  await I.page.screenshot({ path: 'test-results/mobile/05-cloud-login.png' });
});
console.log('errors:', JSON.stringify(errors));
await browser.close();
srv.close();
process.exit(ok && !errors.length ? 0 : 1);
