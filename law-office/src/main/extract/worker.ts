// خيط عامل منفصل للاستخراج حتى لا تتجمد الواجهة أثناء معالجة ملفات كبيرة.
import { parentPort } from 'node:worker_threads';
import { extractText } from './core';

parentPort?.on('message', async (msg: { id: string; file: string; ext: string }) => {
  try {
    const r = await extractText(msg.file, msg.ext);
    parentPort?.postMessage({ id: msg.id, ok: true, ...r });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
});
