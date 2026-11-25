// جسر محدود بين الواجهة والعملية الرئيسية: استدعاء أوامر مسماة فقط، والاستماع لأحداث محددة.
import { contextBridge, ipcRenderer } from 'electron';

const EVENTS = new Set(['session:locked', 'reminders:fired', 'app:navigate', 'cloud:status']);
const CHANNEL = /^[a-zA-Z]+\.[a-zA-Z]+$/;

contextBridge.exposeInMainWorld('lawApi', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (typeof channel !== 'string' || !CHANNEL.test(channel)) return Promise.reject(new Error('قناة غير مسموحة'));
    return ipcRenderer.invoke(`api:${channel}`, payload);
  },
  on(event: string, cb: (data: unknown) => void): () => void {
    if (!EVENTS.has(event)) return () => {};
    const h = (_e: unknown, data: unknown) => cb(data);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
});
