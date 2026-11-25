// بناء نسخة الآيفون (Capacitor): الواجهة نفسها + منطق البرنامج نفسه، مع بدائل لوحدات Node غير الموجودة في iOS.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  root: r('src/mobile/web'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: r('src/mobile/sqlite-shim.ts') },
      { find: /^(node:)?fs$/, replacement: r('src/mobile/shims/vfs.ts') },
      { find: /^(node:)?crypto$/, replacement: r('src/mobile/shims/crypto.ts') },
      { find: /^(node:)?path$/, replacement: 'path-browserify' },
      { find: /^(node:)?os$/, replacement: r('src/mobile/shims/misc.ts') },
      { find: /^(node:)?worker_threads$/, replacement: r('src/mobile/shims/misc.ts') },
      { find: /^(yazl|yauzl)$/, replacement: r('src/mobile/shims/misc.ts') },
      { find: /^(node:)?buffer$/, replacement: 'buffer' },
    ],
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: r('dist/mobile'),
    emptyOutDir: true,
    target: 'safari15',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
});
