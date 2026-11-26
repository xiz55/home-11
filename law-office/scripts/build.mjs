// بناء البرنامج: العملية الرئيسية وpreload وخادم MCP وعامل الاستخراج عبر esbuild، والواجهة عبر Vite.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const only = process.argv[2];

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };

async function buildBackend() {
  await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', format: 'cjs', external: ['electron'] });
  await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/main/preload.js', format: 'cjs', external: ['electron'] });
  await build({
    ...common,
    entryPoints: ['src/main/extract/worker.ts'],
    outfile: 'dist/main/extract-worker.mjs',
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  await build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp/server.js', format: 'cjs' });
}

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (filter(e.name)) fs.copyFileSync(s, d);
  }
}

function copyAssets() {
  const fontSrc = path.join(root, 'node_modules/@fontsource/ibm-plex-sans-arabic/files');
  copyDir(fontSrc, path.join(dist, 'fonts'), (n) => /-(arabic|latin)-(400|500|600)-normal\.woff2$/.test(n));
  fs.copyFileSync(path.join(root, 'node_modules/@fontsource/ibm-plex-sans-arabic/LICENSE'), path.join(dist, 'fonts', 'OFL-LICENSE.txt'));
  const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
  for (const sub of ['cmaps', 'standard_fonts', 'wasm']) copyDir(path.join(pdfjs, sub), path.join(dist, 'renderer', 'pdfjs', sub));
  if (fs.existsSync(path.join(root, 'resources/icon.png'))) fs.copyFileSync(path.join(root, 'resources/icon.png'), path.join(dist, 'icon.png'));
}

if (!only || only === 'backend') {
  fs.rmSync(path.join(dist, 'main'), { recursive: true, force: true });
  fs.rmSync(path.join(dist, 'mcp'), { recursive: true, force: true });
  await buildBackend();
}
if (!only || only === 'renderer') {
  fs.rmSync(path.join(dist, 'renderer'), { recursive: true, force: true });
  await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn' });
  // واجهة الرابط الآمن التي يقدّمها «خادم المكتب» للآيفون
  await viteBuild({ configFile: path.join(root, 'vite.web.config.ts'), logLevel: 'warn' });
  const web = path.join(dist, 'web');
  fs.copyFileSync(path.join(root, 'src/web/manifest.webmanifest'), path.join(web, 'manifest.webmanifest'));
  fs.copyFileSync(path.join(root, 'src/web/boot-errors.js'), path.join(web, 'boot-errors.js'));
  fs.copyFileSync(path.join(root, 'resources/icon-512.png'), path.join(web, 'icon.png'));
  const pdfjsWeb = path.join(root, 'node_modules/pdfjs-dist');
  for (const sub of ['cmaps', 'standard_fonts', 'wasm']) copyDir(path.join(pdfjsWeb, sub), path.join(web, 'pdfjs', sub));
}
copyAssets();
console.log('build ok');
