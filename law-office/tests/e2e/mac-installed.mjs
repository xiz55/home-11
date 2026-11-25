// فحص خاص بماك للتطبيق المثبت فعليًا (يُشغَّل على جهاز اختبار ماك آلي لا يحمل بيانات مكتب حقيقية):
// - مجلد البيانات الافتراضي داخل ~/Library/Application Support وخارج التطبيق والمجلدات المؤقتة.
// - قائمة ماك العربية واختصارات Command، واتجاه RTL.
// - فتح PDF وWord بالبرامج الافتراضية فعليًا دون محاكاة، أو رسالة واضحة مع خيار الإظهار في Finder.
// يرفض العمل إذا وُجدت بيانات سابقة في المسار الافتراضي حتى لا يمس بيانات حقيقية.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { makePdf, OUT, shot } from './lib.mjs';
import yazl from 'yazl';

const exec = process.env.LAWOFFICE_EXEC;
assert.ok(exec && fs.existsSync(exec), 'LAWOFFICE_EXEC must point to the installed app binary');
assert.equal(process.platform, 'darwin');
const expectedData = path.join(os.homedir(), 'Library', 'Application Support', 'LawOfficeManager', 'data');
if (fs.existsSync(expectedData)) throw new Error(`بيانات موجودة مسبقًا في ${expectedData} — لن يُشغَّل الاختبار عليها`);
assert.ok(!exec.includes(os.tmpdir()), 'التطبيق المثبت يجب ألا يكون في مجلد مؤقت');

async function makeDocx(file) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels');
  zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>مذكرة خيالية للاختبار</w:t></w:r></w:p></w:body></w:document>'), 'word/document.xml');
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    ws.on('close', resolve);
    ws.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
  return file;
}

const app = await _electron.launch({ executablePath: exec, args: [], timeout: 60000 });
const win = await app.firstWindow();
win.setDefaultTimeout(20000);
await win.waitForLoadState('domcontentloaded');
const invoke = (c, p = {}) => win.evaluate(([c, p]) => window.lawApi.invoke(c, p), [c, p]);
try {
  assert.equal(await win.evaluate(() => document.documentElement.dir), 'rtl');
  await win.getByLabel('اسمك كما يظهر في البرنامج').fill('مالك تجريبي');
  await win.getByLabel('اسم المستخدم').fill('owner');
  await win.locator('input[type=password]').nth(0).fill('Owner#Pass2026');
  await win.locator('input[type=password]').nth(1).fill('Owner#Pass2026');
  await win.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await win.getByRole('checkbox').check();
  await win.getByRole('button', { name: 'متابعة' }).click();
  await win.getByRole('heading', { name: /مرحبًا/ }).waitFor();

  const info = await invoke('system.info');
  assert.equal(info.data.dataDir, expectedData, 'مجلد البيانات الافتراضي على ماك');
  assert.ok(fs.existsSync(path.join(expectedData, 'office.sqlite')), 'قاعدة SQLite منشأة في Application Support');
  assert.ok(info.data.isPackaged);
  const state = await invoke('auth.state');
  assert.equal(state.data.platform, 'darwin');

  // قائمة ماك واختصارات Command
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => ({ label: i.label, sub: i.submenu?.items.map((s) => [s.label, s.accelerator ?? s.role ?? '']) })));
  assert.ok(menu && menu.length >= 4, 'قائمة التطبيق موجودة');
  const flat = JSON.stringify(menu);
  for (const want of ['نسخ', 'لصق', 'تكبير', 'إنهاء']) assert.ok(flat.includes(want), `عنصر القائمة ${want}`);
  // اختصار ⌘= يعالجه نظام ماك عبر عنصر القائمة نفسه؛ نُفعّل العنصر كما يفعل الاختصار الحقيقي
  const clickMenu = (accel) =>
    app.evaluate(({ Menu, BrowserWindow }, a) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.focus();
      const find = (items) => {
        for (const i of items) {
          if (i.accelerator === a) return i;
          const sub = i.submenu && find(i.submenu.items);
          if (sub) return sub;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu().items);
      if (!item) return null;
      item.click(undefined, w, w.webContents);
      return w.webContents.getZoomLevel();
    }, accel);
  assert.ok((await clickMenu('Command+=')) > 0, 'Command+= يكبر العرض');
  assert.equal(await clickMenu('Command+0'), 0, 'Command+0 يعيد الحجم الافتراضي');

  // إرفاق PDF وWord (يُنسخان إلى مستودع التطبيق) وفتحهما بالبرامج الافتراضية فعليًا
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lom-mac-files-'));
  const pdf = makePdf(path.join(dir, 'test.pdf'), 'Mac PDF test');
  const docx = await makeDocx(path.join(dir, 'test.docx'));
  const client = await invoke('clients.create', { kind: 'individual', name: 'عميل خيالي لاختبار ماك', phone: '0500000009' });
  assert.equal(client.ok, true);
  const opened = [];
  for (const f of [pdf, docx]) {
    const st = await invoke('documents.stageBytes', { name: path.basename(f), bytes: new Uint8Array(fs.readFileSync(f)) });
    assert.equal(st.ok, true, JSON.stringify(st.error));
    const d = await invoke('documents.create', { token: st.data.token, title: path.basename(f), category: 'other', clientId: client.data.id });
    assert.equal(d.ok, true, JSON.stringify(d.error));
    const o = await invoke('documents.open', { versionId: d.data.versionId });
    assert.equal(o.ok, true);
    // إما يُفتح فعلًا بالبرنامج الافتراضي، أو رسالة واضحة تذكر Finder دون ادعاء الفتح
    if (!o.data.opened) assert.match(o.data.message, /Finder/);
    opened.push({ file: path.basename(f), opened: o.data.opened, message: o.data.message });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const docs = await invoke('documents.list', { clientId: client.data.id });
  const pdfDoc = docs.data.find((d) => d.current.ext === 'pdf');
  const bytes = await invoke('documents.readBytes', { versionId: pdfDoc.current.id });
  assert.ok(bytes.ok && bytes.data.bytes.byteLength > 100, 'المرفق محفوظ داخل التطبيق بعد حذف الأصل');
  const stored = fs.readdirSync(path.join(expectedData, 'attachments'), { recursive: true }).filter((f) => /\.(pdf|docx)$/.test(String(f)));
  assert.equal(stored.length, 2);
  await shot(win, 'mac-installed-dashboard');
  console.log('open results:', JSON.stringify(opened));
  console.log('mac installed-app checks passed; data dir:', info.data.dataDir);
} finally {
  await app.close().catch(() => undefined);
}
fs.mkdirSync(OUT, { recursive: true });
