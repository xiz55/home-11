// تشغيل اختبارات المنطق المشترك على محرك نسخة الآيفون (sql.js/WebAssembly) بدل node:sqlite.
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: [{ find: /^node:sqlite$/, replacement: path.resolve('tests/sqljs/node-sqlite-alias.ts') }] },
  // التكامل مع أدوات الذكاء الاصطناعي (MCP) يعمل على سطح المكتب فقط كعملية منفصلة تقرأ ملف القاعدة؛ لا ينطبق على الآيفون.
  test: { include: ['tests/unit/**/*.test.ts', 'tests/cloud/**/*.test.ts'], exclude: ['tests/unit/integration-mcp.test.ts'], testTimeout: 60000, hookTimeout: 120000, server: { deps: { inline: [/src\//] } } },
});
