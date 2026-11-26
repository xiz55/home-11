// بناء نسخة الآيفون: الواجهة + منطق البرنامج (Vite) إلى dist/mobile، ثم نسخها إلى مشروع Xcode (npx cap sync ios).
import { build as viteBuild } from 'vite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/mobile');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

await viteBuild({ configFile: path.join(root, 'vite.mobile.config.ts'), logLevel: 'warn' });
const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
for (const sub of ['cmaps', 'standard_fonts', 'wasm']) copyDir(path.join(pdfjs, sub), path.join(out, 'pdfjs', sub));
if (process.argv.includes('--sync')) execSync('npx cap sync ios', { cwd: root, stdio: 'inherit' });
console.log('mobile build ok');
