// أدوات اختبار التشغيل الفعلي للبرنامج (Electron + Playwright) ببيانات خيالية في مساحات مؤقتة منفصلة.
import { _electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'test-results', 'e2e');
fs.mkdirSync(OUT, { recursive: true });

/** EXEC=مسار ملف البرنامج المغلف لاختبار النسخة المغلفة بدل نسخة التطوير. */
export async function launch(dataDir, extraEnv = {}) {
  const exec = process.env.LAWOFFICE_EXEC;
  const args = exec ? [`--data-dir=${dataDir}`] : [ROOT, `--data-dir=${dataDir}`];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const app = await _electron.launch({ executablePath: exec || undefined, args, env: { ...process.env, ...extraEnv }, timeout: 60000 });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  win.setDefaultTimeout(20000);
  await win.setViewportSize({ width: 1366, height: 768 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win, errors };
}

export function tmpWorkspace(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `lom-e2e-${name}-`)), 'data');
}

export async function mockOpen(app, file) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, file);
}
export async function mockSave(app, file) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, file);
}
export async function mockShell(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openPath = async (p) => {
      globalThis.__opened.push(p);
      return '';
    };
    shell.showItemInFolder = (p) => globalThis.__opened.push('folder:' + p);
  });
}

export function riyadhDate(offsetDays = 0) {
  const d = new Date(Date.now() + 3 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function makePdf(file, text = 'Hearing minutes sample text') {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
  return file;
}

export async function shot(win, name) {
  await win.screenshot({ path: path.join(OUT, `${name}.png`) });
}

export function modal(win) {
  return win.locator('.overlay:not(.confirm) .modal').last();
}

export async function saveModal(win, label = 'حفظ') {
  const m = modal(win);
  await m.locator('.modal-foot').getByRole('button', { name: label, exact: true }).click();
}

export async function expectToast(win, re) {
  await win.locator('.toast').filter({ hasText: re }).first().waitFor({ timeout: 15000 });
}

export async function nav(win, label) {
  await win.locator('nav').getByRole('link', { name: label, exact: true }).click();
}

export async function invoke(win, channel, payload = {}) {
  return win.evaluate(([c, p]) => window.lawApi.invoke(c, p), [channel, payload]);
}
