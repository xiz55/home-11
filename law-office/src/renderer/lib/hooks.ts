import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, getVersion, subscribeVersion } from './api';

export interface Query<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** يجلب بيانات ويعيد الجلب عند تغير المعطيات أو بعد أي تعديل في البرنامج. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}): Query<T> {
  const v = useSyncExternalStore(subscribeVersion, getVersion);
  const [state, setState] = useState<{ data: T | undefined; error: ApiError | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState((s) => ({ data: s.data, error: e instanceof ApiError ? e : new ApiError('INTERNAL', String(e?.message ?? e)), loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, v, tick, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface FormState<T extends Record<string, unknown>> {
  values: T;
  set: <K extends keyof T>(k: K, v: T[K]) => void;
  setMany: (p: Partial<T>) => void;
  errors: Record<string, string>;
  setErrors: (e: Record<string, string>) => void;
  dirty: boolean;
  reset: (v?: T) => void;
  bind: (k: keyof T & string) => { value: string; onChange: (e: { target: { value: string } }) => void; error?: string; name: string };
}

export function useForm<T extends Record<string, unknown>>(initial: T): FormState<T> {
  const initialRef = useRef(JSON.stringify(initial));
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((e) => {
      if (!e[k as string]) return e;
      const n = { ...e };
      delete n[k as string];
      return n;
    });
  }, []);
  const setMany = useCallback((p: Partial<T>) => setValues((s) => ({ ...s, ...p })), []);
  const reset = useCallback((v?: T) => {
    const nv = v ?? (JSON.parse(initialRef.current) as T);
    initialRef.current = JSON.stringify(nv);
    setValues(nv);
    setErrors({});
  }, []);
  const dirty = useMemo(() => JSON.stringify(values) !== initialRef.current, [values]);
  const bind = useCallback(
    (k: keyof T & string) => ({
      name: k,
      value: (values[k] ?? '') as string,
      onChange: (e: { target: { value: string } }) => set(k, e.target.value as T[keyof T & string]),
      error: errors[k],
    }),
    [values, errors, set],
  );
  return { values, set, setMany, errors, setErrors, dirty, reset, bind };
}

/** يحوّل القيم الفارغة إلى null قبل الإرسال. */
export function clean<T extends Record<string, unknown>>(v: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' && val.trim() === '' ? null : val;
  return out as T;
}
