// الرابط الآمن بمحرك Safari نفسه (WebKit) وبمقاس iPhone: الصفحة تفتح، الدخول برمز البريد، والبرنامج يظهر.
// يُشغَّل حين يتوفر WebKit (في GitHub Actions)، ويُتخطى خلاف ذلك ويُذكر ذلك صراحة.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { webkit, devices, type Browser } from 'playwright';
import { HubStore } from '../../src/hub/store';
import { createHubServer } from '../../src/hub/server';
import { makeCore, setupOwner, call, tmpDir, Clock, OWNER } from '../unit/helpers';

const webDir = path.resolve('dist/web');
let available = fs.existsSync(path.join(webDir, 'index.html'));
if (available) {
  try {
    const b = await webkit.launch();
    await b.close();
  } catch {
    available = false;
  }
}
if (!available && process.env.LAWSYNC_REQUIRE_WEBKIT) throw new Error('WebKit or dist/web unavailable');
const d = available ? describe : describe.skip;

d('الرابط الآمن على محرك Safari (WebKit) بمقاس iPhone', () => {
  const A = makeCore(tmpDir(), new Clock(new Date().toISOString()));
  const mails: string[] = [];
  let server: ReturnType<typeof createHubServer>;
  let base = '';
  let browser: Browser;
  beforeAll(async () => {
    await setupOwner(A.core, 'S');
    const me = await call(A.core, 'S', 'auth.me');
    await call(A.core, 'S', 'clients.create', { kind: 'individual', name: 'عميل تجريبي في المكتب', phone: '0500000909' });
    const store = new HubStore(() => A.core.db);
    store.enable();
    A.core.db.run('INSERT INTO hub_user_email (user_id, email) VALUES (?, ?)', [me.id, 'owner@example.test']);
    server = createHubServer({ core: A.core, store, mailer: { send: async (_t, _s, text) => void mails.push(text) }, webDir, officeName: () => 'مكتب تجريبي' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await webkit.launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it('تفتح صفحة الدخول، ويتم الدخول برمز البريد، ويظهر البرنامج وقائمة العملاء', async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 15'], locale: 'ar' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.stack ?? e.message)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.setDefaultTimeout(30000);
    await page.goto(base + '/');
    const outDir = path.resolve('test-results/webkit');
    fs.mkdirSync(outDir, { recursive: true });
    try {
      await page.getByLabel('اسم المستخدم').waitFor();
    } catch (e) {
      await page.screenshot({ path: path.join(outDir, 'fail-gate.png') });
      throw new Error(`gate not shown: ${(await page.locator('body').innerText()).slice(0, 500)} | errors: ${errors.join(' || ')}`);
    }
    await page.screenshot({ path: path.join(outDir, '01-gate.png') });
    await page.getByLabel('اسم المستخدم').fill(OWNER.username);
    await page.getByLabel('كلمة المرور').fill(OWNER.password);
    await page.getByRole('button', { name: 'دخول' }).click();
    await page.getByLabel('رمز التحقق').waitFor();
    await page.getByLabel('رمز التحقق').fill(/(\d{6})/.exec(mails.at(-1)!)![1]);
    await page.getByRole('button', { name: 'تحقق' }).click();
    try {
      await page.locator('.app').waitFor();
    } catch (e) {
      await page.screenshot({ path: path.join(outDir, 'fail-app.png') });
      throw new Error(`app not shown: ${(await page.locator('body').innerText()).slice(0, 500)} | errors: ${errors.join(' || ')}`);
    }
    await page.screenshot({ path: path.join(outDir, '02-app.png') });
    const r = await page.evaluate(() => window.lawApi.invoke('clients.list', {}));
    expect(JSON.stringify(r)).toContain('عميل تجريبي في المكتب');
    expect(errors).toEqual([]);
  }, 120000);
});
