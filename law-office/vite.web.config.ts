// بناء واجهة الرابط الآمن (يقدّمها خادم المكتب للآيفون والمتصفحات) — الواجهة نفسها، والأوامر تُنفّذ على جهاز المكتب.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  base: '/',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    target: 'safari15',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
});
