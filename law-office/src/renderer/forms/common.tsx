import { useState, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import { Button, Modal, TextInput, toast, type Opt } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi, type FormState } from '../lib/hooks';
import { parseAmount, amountToInput } from '../../shared/money';
import type { Tone } from '../../shared/constants';

export function optsFrom(map: Record<string, { label: string; tone?: Tone }>, keys?: string[]): Opt[] {
  return (keys ?? Object.keys(map)).map((k) => ({ value: k, label: map[k].label }));
}
export function optsFromList(list: string[]): Opt[] {
  return list.map((l) => ({ value: l, label: l }));
}

/** نافذة نموذج موحدة: حفظ واضح، حالة حفظ، وتحذير عند إغلاق بيانات غير محفوظة. */
export function FormModal({
  title,
  onClose,
  onSubmit,
  children,
  dirty,
  submitLabel = 'حفظ',
  size,
  extraFooter,
  disabled,
}: {
  title: ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  children: ReactNode;
  dirty?: boolean;
  submitLabel?: string;
  size?: 'normal' | 'wide' | 'narrow';
  extraFooter?: ReactNode;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      dirty={dirty}
      size={size}
      footer={
        <>
          <Button variant="primary" icon={<Save />} loading={saving} onClick={() => void submit()} disabled={disabled}>
            {submitLabel}
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
          <span className="spacer" />
          {extraFooter}
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** ينفذ الحفظ ويعرض أخطاء الحقول بجانبها أو رسالة عامة. يعيد true عند النجاح. */
export async function save<T>(form: FormState<any>, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    invalidate();
    if (okMsg) toast.success(okMsg);
    return r;
  } catch (e) {
    if (e instanceof ApiError && Object.keys(e.fields).length) {
      form.setErrors(e.fields);
      toast.error(e.message);
    } else toast.error(e);
    return undefined;
  }
}

export function AmountInput({ label, value, onChange, error, required, hint }: { label: string; value: string; onChange: (v: string) => void; error?: string; required?: boolean; hint?: string }) {
  return <TextInput label={label} value={value} onChange={onChange} error={error} required={required} hint={hint ?? 'بالريال السعودي — مثال 15000.50'} ltr placeholder="0.00" />;
}

export function amountField(form: FormState<any>, key: string, required = false): number | null | 'invalid' {
  const raw = String(form.values[key] ?? '').trim();
  if (!raw) {
    if (required) {
      form.setErrors({ ...form.errors, [key]: 'أدخل المبلغ' });
      return 'invalid';
    }
    return null;
  }
  const v = parseAmount(raw);
  if (v === null || Number.isNaN(v)) {
    form.setErrors({ ...form.errors, [key]: 'مبلغ غير صالح (أرقام مع خانتين عشريتين كحد أقصى)' });
    return 'invalid';
  }
  return v;
}
export { amountToInput };

export function useClientOptions() {
  return useApi(() => api('clients.options', {}), []);
}
export function useCaseOptions(clientId?: string | null) {
  return useApi(() => api('cases.options', { clientId: clientId ?? null }), [clientId]);
}
export function useUsersOptions(users: { id: string; displayName: string }[]): Opt[] {
  return users.map((u) => ({ value: u.id, label: u.displayName }));
}

/** بيانات قضية للاختيار المتسلسل (المراحل، الجلسات، الأحكام، المذكرات، المستندات). */
export function useCaseLinks(caseId: string | null | undefined) {
  return useApi(
    async () => {
      if (!caseId) return null;
      const [c, hearings, judgments, memos] = await Promise.all([api('cases.get', { id: caseId }), api('hearings.list', { caseId }), api('judgments.list', { caseId }), api('memos.list', { caseId })]);
      return { c, hearings, judgments, memos };
    },
    [caseId],
  );
}
