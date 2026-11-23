import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes, type KeyboardEvent as RKeyboardEvent } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, Inbox, Loader2, X } from 'lucide-react';
import type { Tone } from '../../shared/constants';
import { ApiError } from '../lib/api';

export function Ltr({ children, className = '' }: { children: ReactNode; className?: string }) {
  if (children === null || children === undefined || children === '') return <span className="muted">—</span>;
  return (
    <bdi dir="ltr" className={`ltr ${className}`}>
      {children}
    </bdi>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'default'; size?: 'sm' | 'md'; icon?: ReactNode; loading?: boolean; iconOnly?: boolean };
export function Button({ variant = 'default', size = 'md', icon, loading, iconOnly, children, className = '', disabled, type = 'button', ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', size === 'sm' ? 'sm' : '', iconOnly ? 'icon' : '', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="spin-icon" style={{ animation: 'spin 0.8s linear infinite' }} /> : icon}
      {!iconOnly && children}
    </button>
  );
}

export function Field({ label, required, error, hint, children, className = '', htmlFor }: { label?: ReactNode; required?: boolean; error?: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={`field ${className}`}>
      {label && (
        <label htmlFor={htmlFor}>
          {label}
          {required && <span className="req" aria-hidden> *</span>}
        </label>
      )}
      {children}
      {error ? (
        <div className="error" role="alert">
          <AlertCircle size={14} /> {error}
        </div>
      ) : hint ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  );
}

let idSeq = 0;
function useId(prefix: string) {
  const r = useRef<string | undefined>(undefined);
  if (!r.current) r.current = `${prefix}-${++idSeq}`;
  return r.current;
}

interface InputProps {
  label?: ReactNode;
  value: string | null | undefined;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  placeholder?: string;
  type?: string;
  ltr?: boolean;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  name?: string;
  maxLength?: number;
  readOnly?: boolean;
  onKeyDown?: (e: RKeyboardEvent<HTMLInputElement>) => void;
}
export function TextInput({ label, value, onChange, error, hint, required, placeholder, type = 'text', ltr, className, autoFocus, disabled, name, maxLength, readOnly, onKeyDown }: InputProps) {
  const id = useId('in');
  return (
    <Field label={label} required={required} error={error} hint={hint} className={className} htmlFor={id}>
      <input
        id={id}
        name={name}
        className={`input ${error ? 'invalid' : ''} ${ltr ? 'ltr-input' : ''}`}
        dir={ltr ? 'ltr' : undefined}
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={maxLength}
        readOnly={readOnly}
        onKeyDown={onKeyDown}
      />
    </Field>
  );
}

export function TextArea({ label, value, onChange, error, hint, required, placeholder, rows = 4, className, tall, name, maxLength }: Omit<InputProps, 'type' | 'ltr'> & { rows?: number; tall?: boolean }) {
  const id = useId('ta');
  return (
    <Field label={label} required={required} error={error} hint={hint} className={className} htmlFor={id}>
      <textarea id={id} name={name} className={`textarea ${tall ? 'tall' : ''} ${error ? 'invalid' : ''}`} value={value ?? ''} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} maxLength={maxLength} />
    </Field>
  );
}

export interface Opt {
  value: string;
  label: string;
}
export function Select({ label, value, onChange, options, error, hint, required, placeholder, className, disabled, name }: Omit<InputProps, 'type'> & { options: Opt[] }) {
  const id = useId('sel');
  const opts = useMemo(() => {
    if (value && !options.some((o) => o.value === value)) return [...options, { value, label: value }];
    return options;
  }, [options, value]);
  return (
    <Field label={label} required={required} error={error} hint={hint} className={className} htmlFor={id}>
      <select id={id} name={name} className={`select ${error ? 'invalid' : ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} disabled={disabled}>
        <option value="">{placeholder ?? '— اختر —'}</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function DateInput(props: Omit<InputProps, 'type' | 'ltr'>) {
  return <TextInput {...props} type="date" ltr />;
}
export function TimeInput(props: Omit<InputProps, 'type' | 'ltr'>) {
  return <TextInput {...props} type="time" ltr />;
}

export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <div>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        <span>{label}</span>
      </label>
      {hint && <div className="help" style={{ marginRight: 26 }}>{hint}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone | 'outline'; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/** شارة حالة: اللون مع اسم الحالة دائمًا. */
export function StatusBadge<K extends string>({ map, value }: { map: Record<K, { label: string; tone: Tone }>; value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const m = (map as Record<string, { label: string; tone: Tone }>)[value];
  return <Badge tone={m?.tone ?? 'neutral'} dot>{m?.label ?? value}</Badge>;
}

export function Card({ title, actions, children, className = '', flush, sub }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; sub?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {typeof title === 'string' ? <h2>{title}</h2> : title}
            {sub && <div className="help">{sub}</div>}
          </div>
          {actions && <div className="btn-group">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox />}
      <div className="title">{title}</div>
      {children && <div className="help">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'جارٍ التحميل…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : (error as Error)?.message ?? 'حدث خطأ';
  return (
    <div className="alert danger" role="alert">
      <AlertCircle />
      <div className="grow">
        {msg}
        {onRetry && (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={onRetry}>
              إعادة المحاولة
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; children: ReactNode }) {
  const Icon = tone === 'warning' ? AlertTriangle : tone === 'danger' ? AlertCircle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`alert ${tone}`}>
      <Icon />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number; hidden?: boolean }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
            {t.label}
            {t.count !== undefined && <span className="count">{t.count}</span>}
          </button>
        ))}
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === '' ? <span className="muted">غير مسجل</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Collapsible({ title, right, children, defaultOpen = false }: { title: ReactNode; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button className="c-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        <div className="grow">{title}</div>
        {right}
      </button>
      {open && <div className="c-body">{children}</div>}
    </div>
  );
}

// ———— النوافذ والتأكيد ————
export function Modal({ title, onClose, children, footer, size = 'normal', dirty }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'normal' | 'wide' | 'narrow'; dirty?: boolean }) {
  const tryClose = async () => {
    if (dirty && !(await confirmAsync({ title: 'تغييرات غير محفوظة', message: 'لديك بيانات لم تُحفظ في هذه النافذة. هل تريد إغلاقها وفقدان التغييرات؟', confirmLabel: 'الإغلاق دون حفظ', danger: true }))) return;
    onClose();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay.confirm')) void tryClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  useEffect(() => {
    if (dirty === undefined) return;
    void window.lawApi.invoke('ui.setDirty', { dirty: !!dirty });
    return () => void window.lawApi.invoke('ui.setDirty', { dirty: false });
  }, [dirty]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && void tryClose()}>
      <div className={`modal ${size === 'wide' ? 'wide' : size === 'narrow' ? 'narrow' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" iconOnly icon={<X />} aria-label="إغلاق" title="إغلاق" onClick={() => void tryClose()} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmReq {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
let confirmState: ConfirmReq | null = null;
const confirmListeners = new Set<() => void>();
export function confirmAsync(o: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { ...o, resolve };
    confirmListeners.forEach((l) => l());
  });
}
export function ConfirmHost() {
  const st = useSyncExternalStore(
    (l) => {
      confirmListeners.add(l);
      return () => confirmListeners.delete(l);
    },
    () => confirmState,
  );
  if (!st) return null;
  const done = (v: boolean) => {
    confirmState = null;
    confirmListeners.forEach((l) => l());
    st.resolve(v);
  };
  return (
    <div className="overlay confirm" role="alertdialog" aria-modal="true" style={{ zIndex: 300 }}>
      <div className="modal narrow">
        <div className="modal-head">
          <h2>{st.title}</h2>
        </div>
        <div className="modal-body">{typeof st.message === 'string' ? <p className="long-text">{st.message}</p> : st.message}</div>
        <div className="modal-foot">
          <Button variant={st.danger ? 'danger' : 'primary'} className={st.danger ? 'solid' : ''} onClick={() => done(true)} autoFocus>
            {st.confirmLabel ?? 'تأكيد'}
          </Button>
          <Button onClick={() => done(false)}>{st.cancelLabel ?? 'إلغاء'}</Button>
        </div>
      </div>
    </div>
  );
}

// ———— الرسائل العابرة ————
interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
function pushToast(kind: ToastItem['kind'], text: string) {
  const id = ++toastSeq;
  toasts = [...toasts, { id, kind, text }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, kind === 'error' ? 8000 : 4000);
}
export const toast = {
  success: (t: string) => pushToast('success', t),
  error: (t: string | unknown) => pushToast('error', typeof t === 'string' ? t : t instanceof ApiError ? t.message : (t as Error)?.message ?? 'حدث خطأ'),
  info: (t: string) => pushToast('info', t),
};
export function ToastHost() {
  const list = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'success' ? <CheckCircle2 /> : t.kind === 'error' ? <AlertCircle /> : <Info />}
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

// ———— القائمة المنسدلة ————
export function Dropdown({ trigger, children, align = 'left' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  useEffect(() => {
    if (open) (ref.current?.querySelector('.menu button') as HTMLButtonElement | null)?.focus();
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`menu ${align === 'right' ? 'right' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ———— جدول بيانات قابل للبحث والفرز ————
export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  searchValue?: (row: T) => string;
  className?: string;
}
export function DataTable<T>({ rows, columns, rowKey, onRowClick, empty = 'لا توجد سجلات', search, bounded, selectedKey, defaultSort }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode; search?: string; bounded?: boolean; selectedKey?: string | null; defaultSort?: { key: string; dir: 1 | -1 } }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(defaultSort ?? null);
  const filtered = useMemo(() => {
    if (!search?.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => columns.some((c) => String(c.searchValue?.(r) ?? c.sortValue?.(r) ?? '').toLowerCase().includes(q)));
  }, [rows, columns, search]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return filtered;
    return [...filtered].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ar')) * sort.dir;
    });
  }, [filtered, sort, columns]);
  return (
    <div className={`table-wrap ${bounded ? 'bounded' : ''}`}>
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.sortValue ? 'sortable' : ''}
                onClick={() => c.sortValue && setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
              >
                {c.header}
                {sort?.key === c.key && (sort.dir === 1 ? ' ▲' : ' ▼')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{typeof empty === 'string' ? <Empty title={empty} /> : empty}</td>
            </tr>
          ) : (
            sorted.map((r) => {
              const k = rowKey(r);
              return (
                <tr
                  key={k}
                  className={`${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render ? c.render(r) : String(c.sortValue?.(r) ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SaveState({ state, at }: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'; at?: string | null }) {
  const label =
    state === 'saving' ? 'جارٍ الحفظ…' : state === 'saved' ? `حُفظ${at ? ' الساعة ' + new Date(at).toLocaleTimeString('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }) : ''}` : state === 'error' ? 'فشل الحفظ — لم يُحفظ آخر تعديل' : state === 'dirty' ? 'تعديلات لم تُحفظ بعد' : at ? `آخر حفظ ${new Date(at).toLocaleString('ar-SA-u-nu-latn-ca-gregory', { timeZone: 'Asia/Riyadh', dateStyle: 'short', timeStyle: 'short' })}` : '';
  return (
    <span className={`save-state ${state}`} role="status" aria-live="polite">
      {state === 'saving' && <span className="spinner" style={{ width: 14, height: 14 }} />}
      {state === 'saved' && <CheckCircle2 size={14} />}
      {state === 'error' && <AlertCircle size={14} />}
      {label}
    </span>
  );
}
