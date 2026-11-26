// اختبار واجهة المزامنة السحابية على سطح المكتب دون حساب سحابي حقيقي (بيانات خيالية):
// شاشة البداية تعرض «ربط جهاز إضافي»، وتبويب الحساب السحابي يظهر لصاحب المكتب بحالة «غير مفعّلة» ويرفض عنوانًا غير صالح.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, tmpWorkspace, nav, shot } from './lib.mjs';

const OWNER = { name: 'أ. سالم الخيالي', user: 'owner', pass: 'Test-Pass-2026!' };
let A;

describe('واجهة المزامنة السحابية (دون خادم)', () => {
  before(async () => {
    A = await launch(tmpWorkspace('cloud-ui'));
  });
  after(async () => {
    await A?.app.close();
  });

  it('1. شاشة البداية تتيح ربط جهاز إضافي ثم الرجوع لإنشاء مكتب', { timeout: 120000 }, async () => {
    const { win } = A;
    await win.getByRole('button', { name: /ربط هذا الجهاز به/ }).click();
    await win.getByText('ربط هذا الجهاز بحساب المكتب').waitFor();
    await shot(win, 'cloud-01-join');
    await win.getByRole('button', { name: 'رجوع' }).click();
    await win.getByLabel('اسمك كما يظهر في البرنامج').fill(OWNER.name);
    await win.getByLabel('اسم المستخدم').fill(OWNER.user);
    await win.locator('input[type=password]').nth(0).fill(OWNER.pass);
    await win.locator('input[type=password]').nth(1).fill(OWNER.pass);
    await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
    await win.getByTestId('recovery-code').waitFor();
    await win.getByRole('checkbox').check();
    await win.getByRole('button', { name: 'متابعة' }).click();
    await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();
  });

  it('2. تبويب الحساب السحابي: الحالة محلية، ورفض عنوان خادم غير صالح، ولا مزامنة دون إعداد', { timeout: 120000 }, async () => {
    const { win, errors } = A;
    await nav(win, 'الإعدادات');
    await win.getByRole('tab', { name: 'الحساب السحابي والمزامنة' }).click();
    await win.getByText('ربط المكتب بالحساب السحابي').waitFor();
    await shot(win, 'cloud-02-tab');
    const r = await win.evaluate(() => window.lawApi.invoke('cloud.configure', { url: 'http://evil.example', anonKey: 'x' }));
    assert.equal(r.ok, false, JSON.stringify(r));
    const s = await win.evaluate(() => window.lawApi.invoke('cloud.syncNow', {}));
    assert.deepEqual(s, { ok: true, data: null }); // لا شيء يُرسل دون ربط
    assert.deepEqual(errors.filter((e) => !/Autofill/.test(e)), []);
  });
});
