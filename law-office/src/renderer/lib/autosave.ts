import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { confirmAsync } from '../components/ui';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** حفظ تلقائي بعد توقف الكتابة مع حالة حفظ فعلية، ومنع مغادرة الصفحة قبل الحفظ. */
export function useAutosave<K extends string>(saveFn: (key: K, value: string) => Promise<void>, delay = 1500) {
  const pending = useRef(new Map<K, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef(saveFn);
  saveRef.current = saveFn;

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current.size) {
        const [k, v] = pending.current.entries().next().value as [K, string];
        pending.current.delete(k);
        setStatus('saving');
        try {
          await saveRef.current(k, v);
        } catch (e) {
          // نعيد النص للانتظار حتى لا يضيع، ونعرض الخطأ الفعلي
          if (!pending.current.has(k)) pending.current.set(k, v);
          setError((e as Error).message ?? 'فشل الحفظ');
          setStatus('error');
          return;
        }
      }
      setError(null);
      setSavedAt(new Date().toISOString());
      setStatus('saved');
    } finally {
      running.current = false;
    }
  }, []);

  const change = useCallback(
    (k: K, v: string) => {
      pending.current.set(k, v);
      setStatus('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  const hasUnsaved = status === 'dirty' || status === 'saving' || status === 'error';

  useEffect(() => {
    void window.lawApi.invoke('ui.setDirty', { dirty: hasUnsaved });
  }, [hasUnsaved]);
  useEffect(() => () => void window.lawApi.invoke('ui.setDirty', { dirty: false }), []);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsaved && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void (async () => {
      await flush();
      if (pending.current.size === 0) {
        blocker.proceed();
        return;
      }
      const leave = await confirmAsync({ title: 'نص غير محفوظ', message: 'تعذر حفظ آخر تعديلاتك. إن غادرت الصفحة الآن ستفقد النص غير المحفوظ. انسخه أولًا إن احتجت.', confirmLabel: 'المغادرة دون حفظ', cancelLabel: 'البقاء في الصفحة', danger: true });
      if (leave) blocker.proceed();
      else blocker.reset();
    })();
  }, [blocker, flush]);

  return { change, flush, status, savedAt, error, hasUnsaved };
}
