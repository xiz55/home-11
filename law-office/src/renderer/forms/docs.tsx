import { useEffect, useState } from 'react';
import { FileUp, Paperclip } from 'lucide-react';
import { Alert, Button, Checkbox, DateInput, Select, TextArea, TextInput, confirmAsync, toast, Ltr } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { ALLOWED_EXTENSIONS, DOC_CATEGORIES, DOC_STATUSES, MAX_ATTACHMENT_BYTES, type DocCategory } from '../../shared/constants';
import { fmtDateTime } from '../../shared/dates';
import { FormModal, optsFrom, useCaseLinks, useCaseOptions, useClientOptions } from './common';
import type { MethodOutput } from '../../main/ipc/registry';

type Staged = NonNullable<MethodOutput<'documents.pickFile'>>;

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(1)} م.ب`;
}

export function FilePicker({ staged, onStaged, error }: { staged: Staged | null; onStaged: (s: Staged | null) => void; error?: string }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('documents.pickFile', {});
      if (r) {
        if (staged) void api('documents.discardStaged', { token: staged.token });
        onStaged(r);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'تعذر تجهيز الملف');
    } finally {
      setBusy(false);
    }
  };
  const drop = async (file: File) => {
    setErr(null);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setErr('حجم الملف أكبر من الحد المسموح.');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await api('documents.stageBytes', { name: file.name, bytes });
      if (staged) void api('documents.discardStaged', { token: staged.token });
      onStaged(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'تعذر تجهيز الملف');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <span className="label">
        الملف <span className="req">*</span>
      </span>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void drop(f);
        }}
      >
        {staged ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <Paperclip size={18} /> <Ltr>{staged.name}</Ltr> <span className="muted">— {staged.typeLabel}، {fmtSize(staged.size)}</span>
          </div>
        ) : (
          <div>اسحب الملف إلى هنا أو اختره من الجهاز</div>
        )}
        <div style={{ marginTop: 10 }}>
          <Button icon={<FileUp />} onClick={() => void pick()} loading={busy}>
            {staged ? 'تغيير الملف' : 'اختيار ملف'}
          </Button>
        </div>
        <div className="help" style={{ marginTop: 8 }}>
          الأنواع المسموحة: PDF، Word (DOCX / DOC)، الصور (JPG، PNG، WEBP، GIF، BMP، TIFF، HEIC). الحد الأقصى {Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} ميجابايت. يُنسخ الملف إلى مستودع البرنامج فلا يتأثر بنقل الأصل لاحقًا.
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {error && <div className="error">{error}</div>}
      {staged && staged.duplicates.length > 0 && (
        <Alert tone="warning">
          هذا الملف مرفق مسبقًا: {staged.duplicates.map((d) => `«${d.title}» (نسخة ${d.versionNo})`).join('، ')}. سيُطلب تأكيدك قبل إرفاقه مرة أخرى.
        </Alert>
      )}
    </div>
  );
}

export interface DocDefaults {
  clientId?: string;
  caseId?: string | null;
  stageId?: string | null;
  hearingId?: string | null;
  judgmentId?: string | null;
  memoId?: string | null;
  contractId?: string | null;
  poaId?: string | null;
  paymentId?: string | null;
  category?: DocCategory;
  title?: string;
}

function LinkFields({ f, lockClient, lockCase }: { f: ReturnType<typeof useForm<any>>; lockClient: boolean; lockCase: boolean }) {
  const v = f.values;
  const clients = useClientOptions();
  const cases = useCaseOptions(v.clientId || null);
  const links = useCaseLinks(v.caseId || null);
  const contracts = useApi(() => (v.clientId ? api('contracts.list', { clientId: v.clientId }) : Promise.resolve([])), [v.clientId]);
  const L = links.data;
  return (
    <>
      <Select label="العميل" required options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} {...f.bind('clientId')} onChange={(x) => f.setMany({ clientId: x, caseId: '', stageId: '', hearingId: '', judgmentId: '', memoId: '', contractId: '' })} disabled={lockClient} />
      <Select label="القضية" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.setMany({ caseId: x, stageId: '', hearingId: '', judgmentId: '', memoId: '' })} placeholder="مستند عام للعميل" disabled={lockCase} />
      {v.caseId && L && (
        <>
          <Select label="المرحلة" options={L.c.stages.map((s) => ({ value: s.id, label: s.stageType }))} {...f.bind('stageId')} onChange={(x) => f.set('stageId', x)} placeholder="غير محددة" />
          <Select label="الجلسة" options={L.hearings.filter((h) => !v.stageId || h.stageId === v.stageId).map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('hearingId')} onChange={(x) => f.set('hearingId', x)} placeholder="غير مرتبطة" />
          <Select label="الحكم" options={L.judgments.map((j) => ({ value: j.id, label: `${j.judgmentNo ?? 'حكم'} ${j.judgmentDate ?? ''}` }))} {...f.bind('judgmentId')} onChange={(x) => f.set('judgmentId', x)} placeholder="غير مرتبط" />
          <Select label="المذكرة" options={L.memos.map((m) => ({ value: m.id, label: m.title }))} {...f.bind('memoId')} onChange={(x) => f.set('memoId', x)} placeholder="غير مرتبطة" />
        </>
      )}
      {(contracts.data ?? []).length > 0 && <Select label="العقد" options={(contracts.data ?? []).map((k) => ({ value: k.id, label: k.title }))} {...f.bind('contractId')} onChange={(x) => f.set('contractId', x)} placeholder="غير مرتبط" />}
    </>
  );
}

export function DocumentAttachForm({ defaults = {}, onClose, onSaved }: { defaults?: DocDefaults; onClose: () => void; onSaved?: (id: string) => void }) {
  const [staged, setStaged] = useState<Staged | null>(null);
  const f = useForm({
    title: defaults.title ?? '',
    description: '',
    category: defaults.category ?? 'other',
    docDate: '',
    hijriText: '',
    hijriSource: '',
    status: 'final',
    isInternal: false,
    clientId: defaults.clientId ?? '',
    caseId: defaults.caseId ?? '',
    stageId: defaults.stageId ?? '',
    hearingId: defaults.hearingId ?? '',
    judgmentId: defaults.judgmentId ?? '',
    memoId: defaults.memoId ?? '',
    contractId: defaults.contractId ?? '',
    poaId: defaults.poaId ?? '',
    paymentId: defaults.paymentId ?? '',
    versionNote: '',
  });
  useEffect(() => {
    if (staged && !f.values.title) f.set('title', staged.name.replace(/\.[^.]+$/, ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged]);
  const close = () => {
    if (staged) void api('documents.discardStaged', { token: staged.token });
    onClose();
  };
  const v = f.values;
  return (
    <FormModal
      title="إرفاق مستند"
      size="wide"
      onClose={close}
      dirty={f.dirty || !!staged}
      submitLabel="حفظ المرفق"
      onSubmit={async () => {
        if (!staged) {
          f.setErrors({ file: 'اختر الملف أولًا' });
          return;
        }
        const body = {
          token: staged.token,
          title: v.title,
          description: v.description || null,
          category: v.category as DocCategory,
          docDate: v.docDate || null,
          hijriText: v.hijriText || null,
          hijriSource: v.hijriSource || null,
          status: v.status as never,
          isInternal: v.isInternal,
          clientId: v.clientId,
          caseId: v.caseId || null,
          stageId: v.stageId || null,
          hearingId: v.hearingId || null,
          judgmentId: v.judgmentId || null,
          memoId: v.memoId || null,
          contractId: v.contractId || null,
          poaId: v.poaId || null,
          paymentId: v.paymentId || null,
          versionNote: v.versionNote || null,
          allowDuplicate: false,
        };
        try {
          let r;
          try {
            r = await api('documents.create', body);
          } catch (e) {
            if (e instanceof ApiError && e.code === 'DUPLICATE') {
              if (!(await confirmAsync({ title: 'ملف مكرر', message: e.message, confirmLabel: 'إرفاقه مرة أخرى' }))) return;
              r = await api('documents.create', { ...body, allowDuplicate: true });
            } else throw e;
          }
          invalidate();
          toast.success('حُفظ المرفق في مستودع البرنامج');
          onSaved?.(r.id);
          onClose();
        } catch (e) {
          if (e instanceof ApiError && Object.keys(e.fields).length) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <div className="full">
          <FilePicker staged={staged} onStaged={setStaged} error={f.errors.file} />
        </div>
        <TextInput label="عنوان المستند" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <Select label="التصنيف" required options={optsFrom(DOC_CATEGORIES)} {...f.bind('category')} onChange={(x) => f.set('category', x as never)} placeholder="—" />
        <DateInput label="تاريخ المستند" {...f.bind('docDate')} onChange={(x) => f.set('docDate', x)} />
        <Select label="الحالة" options={optsFrom(DOC_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x)} placeholder="—" />
        <TextInput label="التاريخ الهجري كما ورد" {...f.bind('hijriText')} onChange={(x) => f.set('hijriText', x)} />
        <TextInput label="مصدر التاريخ الهجري" {...f.bind('hijriSource')} onChange={(x) => f.set('hijriSource', x)} />
        <LinkFields f={f} lockClient={!!defaults.clientId} lockCase={defaults.caseId !== undefined && defaults.caseId !== null} />
        <TextArea className="full" label="الوصف" {...f.bind('description')} onChange={(x) => f.set('description', x)} rows={2} />
        <div className="full">
          <Checkbox label="مستند داخلي (يُستبعد من تقارير العميل افتراضيًا)" checked={v.isInternal} onChange={(x) => f.set('isInternal', x)} />
        </div>
      </div>
    </FormModal>
  );
}

export function AddVersionForm({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [staged, setStaged] = useState<Staged | null>(null);
  const f = useForm({ note: '' });
  const close = () => {
    if (staged) void api('documents.discardStaged', { token: staged.token });
    onClose();
  };
  return (
    <FormModal
      title="إضافة نسخة جديدة"
      onClose={close}
      dirty={!!staged || f.dirty}
      submitLabel="حفظ النسخة"
      onSubmit={async () => {
        if (!staged) {
          f.setErrors({ file: 'اختر الملف أولًا' });
          return;
        }
        try {
          try {
            await api('documents.addVersion', { documentId, token: staged.token, note: f.values.note || null, allowDuplicate: false });
          } catch (e) {
            if (e instanceof ApiError && e.code === 'DUPLICATE') {
              if (!(await confirmAsync({ title: 'نسخة مطابقة', message: e.message, confirmLabel: 'إضافتها رغم ذلك' }))) return;
              await api('documents.addVersion', { documentId, token: staged.token, note: f.values.note || null, allowDuplicate: true });
            } else throw e;
          }
          invalidate();
          toast.success('أُضيفت النسخة الجديدة؛ النسخ السابقة محفوظة');
          onClose();
        } catch (e) {
          toast.error(e);
        }
      }}
    >
      <div className="stack g2">
        <FilePicker staged={staged} onStaged={setStaged} error={f.errors.file} />
        <TextInput label="ملاحظة على النسخة" {...f.bind('note')} onChange={(x) => f.set('note', x)} placeholder="مثال: بعد ملاحظات المراجعة" />
      </div>
    </FormModal>
  );
}

type DocFull = MethodOutput<'documents.get'>['document'];
export function DocumentEditForm({ doc, onClose }: { doc: DocFull; onClose: () => void }) {
  const f = useForm({
    title: doc.title,
    description: doc.description ?? '',
    category: doc.category,
    docDate: doc.docDate ?? '',
    hijriText: doc.hijriText ?? '',
    hijriSource: doc.hijriSource ?? '',
    status: doc.status,
    isInternal: doc.isInternal,
    clientId: doc.clientId,
    caseId: doc.caseId ?? '',
    stageId: doc.stageId ?? '',
    hearingId: doc.hearingId ?? '',
    judgmentId: doc.judgmentId ?? '',
    memoId: doc.memoId ?? '',
    contractId: doc.contractId ?? '',
    poaId: doc.poaId ?? '',
    paymentId: doc.paymentId ?? '',
  });
  const v = f.values;
  return (
    <FormModal
      title="تعديل بيانات المستند"
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        try {
          await api('documents.update', {
            id: doc.id,
            title: v.title,
            description: v.description || null,
            category: v.category,
            docDate: v.docDate || null,
            hijriText: v.hijriText || null,
            hijriSource: v.hijriSource || null,
            status: v.status,
            isInternal: v.isInternal,
            clientId: v.clientId,
            caseId: v.caseId || null,
            stageId: v.stageId || null,
            hearingId: v.hearingId || null,
            judgmentId: v.judgmentId || null,
            memoId: v.memoId || null,
            contractId: v.contractId || null,
            poaId: v.poaId || null,
            paymentId: v.paymentId || null,
          });
          invalidate();
          toast.success('حُفظت بيانات المستند');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <TextInput label="العنوان" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <Select label="التصنيف" options={optsFrom(DOC_CATEGORIES)} {...f.bind('category')} onChange={(x) => f.set('category', x as never)} placeholder="—" />
        <DateInput label="تاريخ المستند" {...f.bind('docDate')} onChange={(x) => f.set('docDate', x)} />
        <Select label="الحالة" options={optsFrom(DOC_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TextInput label="التاريخ الهجري كما ورد" {...f.bind('hijriText')} onChange={(x) => f.set('hijriText', x)} />
        <TextInput label="مصدره" {...f.bind('hijriSource')} onChange={(x) => f.set('hijriSource', x)} />
        <LinkFields f={f} lockClient lockCase={false} />
        <TextArea className="full" label="الوصف" {...f.bind('description')} onChange={(x) => f.set('description', x)} rows={2} />
        <div className="full">
          <Checkbox label="مستند داخلي" checked={v.isInternal} onChange={(x) => f.set('isInternal', x)} />
        </div>
      </div>
    </FormModal>
  );
}

export function extLabel(ext: string): string {
  return (ALLOWED_EXTENSIONS as Record<string, { label: string }>)[ext]?.label ?? ext.toUpperCase();
}
