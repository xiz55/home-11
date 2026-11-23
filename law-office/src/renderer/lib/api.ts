// عميل الأوامر في الواجهة: يمر عبر الجسر المحدود في preload فقط.
import type { MethodInput, MethodName, MethodOutput } from '../../main/ipc/registry';

declare global {
  interface Window {
    lawApi: {
      invoke(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string; fields?: Record<string, string>; extra?: Record<string, unknown> } }>;
      on(event: string, cb: (data: unknown) => void): () => void;
    };
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Listener = () => void;
const authListeners = new Set<Listener>();
export function onAuthChange(l: Listener) {
  authListeners.add(l);
  return () => authListeners.delete(l);
}
export function emitAuthChange() {
  authListeners.forEach((l) => l());
}

export async function api<K extends MethodName>(channel: K, input?: MethodInput<K>): Promise<MethodOutput<K>> {
  const r = await window.lawApi.invoke(channel, input ?? {});
  if (!r.ok) {
    const e = r.error ?? { code: 'INTERNAL', message: 'خطأ غير معروف' };
    if (e.code === 'LOCKED' || e.code === 'UNAUTHENTICATED') emitAuthChange();
    throw new ApiError(e.code, e.message, e.fields ?? {}, e.extra ?? {});
  }
  return r.data as MethodOutput<K>;
}

// ———— إبطال البيانات بعد كل تعديل ————
let version = 0;
const versionListeners = new Set<Listener>();
export function invalidate() {
  version++;
  versionListeners.forEach((l) => l());
}
export function subscribeVersion(l: Listener) {
  versionListeners.add(l);
  return () => versionListeners.delete(l);
}
export function getVersion() {
  return version;
}
