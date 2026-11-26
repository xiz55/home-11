// فحص سريع للبرنامج بعد تثبيته فعليًا: يفتح، ينشئ المالك، يضيف عميلًا، يغلق ويعيد الفتح ويتحقق من بقاء البيانات.
import assert from 'node:assert/strict';
import { launch, tmpWorkspace, shot } from './lib.mjs';

const data = tmpWorkspace('installed');
let A = await launch(data);
let win = A.win;
await win.getByLabel('اسمك كما يظهر في البرنامج').fill('مالك تجريبي');
await win.getByLabel('اسم المستخدم').fill('owner');
await win.locator('input[type=password]').nth(0).fill('Owner#Pass2026');
await win.locator('input[type=password]').nth(1).fill('Owner#Pass2026');
await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
await win.getByRole('checkbox').check();
await win.getByRole('button', { name: 'متابعة' }).click();
await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();
const r = await win.evaluate(() => window.lawApi.invoke('clients.create', { kind: 'company', name: 'عميل خيالي بعد التثبيت' }));
assert.equal(r.ok, true);
await shot(win, 'installed-dashboard');
await A.app.close();
A = await launch(data);
win = A.win;
await win.getByLabel('اسم المستخدم').fill('owner');
await win.locator('input[type=password]').first().fill('Owner#Pass2026');
await win.getByRole('button', { name: 'تسجيل الدخول' }).click();
await win.locator('.sidebar').waitFor();
const list = await win.evaluate(() => window.lawApi.invoke('clients.list', {}));
assert.equal(list.data.length, 1);
await A.app.close();
console.log('installed app smoke test passed');
