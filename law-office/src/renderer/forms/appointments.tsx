// نماذج الاستشارات والاجتماعات: صاحب الموعد (عميل موجود أو جهة اتصال جديدة)، التعارض، المالية، الاستشارة المكتوبة، المحضر.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { Alert, Badge, Button, Checkbox, DateInput, Select, TextArea, TextInput, TimeInput, confirmAsync, toast, Ltr } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { useSession } from '../lib/session';
import { FormModal, AmountInput, amountField, amountToInput, optsFrom, optsFromList, useClientOptions, useCaseOptions } from './common';
import { DocumentAttachForm } from './docs';
import { CaseForm } from './clientCase';
import { APPT_METHODS, CONSULT_STATUSES, MEETING_STATUSES, MEETING_ITEM_KINDS, PRIORITIES, SVC_TXN_KINDS, CLIENT_KINDS, type SvcTxnKind } from '../../shared/constants';
import { addDays, fmtDateTime, riyadhToUtcIso, todayRiyadh, utcIsoToRiyadh } from '../../shared/dates';
import { fmtAmount } from '../../shared/money';
import type { MethodOutput } from '../../main/ipc/registry';

type Consultation = MethodOutput<'consultations.get'>['consultation'];
type Meeting = MethodOutput<'meetings.get'>['meeting'];
type Conflict = { kind: string; label: string; startsAt: string; endsAt: string };

/** يرسل الطلب، ويتعامل مع التعارض (تأكيد صريح) والجوال المطابق (اختيار السجل الصحيح أو تأكيد شخص مختلف). */
async function submitWithChecks<T>(
  send: (flags: { confirmConflicts: boolean; confirmNewContact: boolean; clientId?: string }) => Promise<T>,
  onUseExisting: (clientId: string) => void,
): Promise<T | undefined> {
  const flags = { confirmConflicts: false, confirmNewContact: false } as { confirmConflicts: boolean; confirmNewContact: boolean; clientId?: string };
  for (let i = 0; i < 4; i++) {
    try {
      return await send(flags);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT' && Array.isArray(e.extra.conflicts)) {
        const list = e.extra.conflicts as Conflict[];
        const ok = await confirmAsync({
          title: 'تعارض في المواعيد',
          message: (
            <div className="stack g2">
              <div>{e.message}</div>
              <ul className="list-plain">
                {list.map((c, k) => (
                  <li key={k}>
                    <Badge tone={c.kind === 'hearing' ? 'info' : 'neutral'}>{c.kind === 'hearing' ? 'جلسة قضائية' : c.kind === 'consultation' ? 'استشارة' : 'اجتماع'}</Badge> {c.label} — <bdi dir="rtl">{fmtDateTime(c.startsAt)}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          ),
          confirmLabel: 'متابعة الحفظ رغم التعارض',
          cancelLabel: 'تعديل الموعد',
        });
        if (!ok) return undefined;
        flags.confirmConflicts = true;
        continue;
      }
      if (e instanceof ApiError && e.code === 'DUPLICATE' && Array.isArray(e.extra.matches)) {
        const m = e.extra.matches as { id: string; name: string; phone: string | null; selectable: boolean }[];
        const pick = m.find((x) => x.selectable);
        const useExisting = await confirmAsync({
          title: 'جوال مطابق لسجل موجود',
          message: (
            <div className="stack g2">
              <div>لا يدمج البرنامج الأشخاص تلقائيًا. السجلات المطابقة:</div>
              <ul className="list-plain">
                {m.map((x) => (
                  <li key={x.id}>
                    {x.name} — <Ltr>{x.phone ?? ''}</Ltr> {!x.selectable && <span className="help">(غير متاح لحسابك)</span>}
                  </li>
                ))}
              </ul>
              <div>{pick ? `اختر «استخدام السجل الموجود» لربط الموعد بـ «${pick.name}»، أو «شخص مختلف» لتسجيل جهة اتصال جديدة.` : 'السجل المطابق غير متاح لحسابك. اطلب من صاحب المكتب منحك الوصول، أو أكّد أنه شخص مختلف.'}</div>
            </div>
          ),
          confirmLabel: pick ? 'استخدام السجل الموجود' : 'شخص مختلف — تسجيله',
          cancelLabel: pick ? 'شخص مختلف — تسجيله' : 'إلغاء',
        });
        if (pick && useExisting) {
          onUseExisting(pick.id);
          flags.clientId = pick.id;
          continue;
        }
        if (!pick && !useExisting) return undefined;
        flags.confirmNewContact = true;
        continue;
      }
      throw e;
    }
  }
  return undefined;
}

function ContactFields({ f, locked }: { f: ReturnType<typeof useForm<any>>; locked: boolean }) {
  const clients = useClientOptions();
  const v = f.values;
  if (locked)
    return (
      <div className="full help">
        صاحب الموعد: <strong>{(clients.data ?? []).find((c) => c.id === v.clientId)?.name ?? v.lockedName ?? '—'}</strong> (ثابت بعد التسجيل)
      </div>
    );
  return (
    <>
      <div className="full seg" role="tablist" aria-label="صاحب الموعد">
        <button type="button" className={v.contactMode === 'existing' ? 'on' : ''} onClick={() => f.set('contactMode', 'existing')}>
          عميل أو جهة اتصال مسجلة
        </button>
        <button type="button" className={v.contactMode === 'new' ? 'on' : ''} onClick={() => f.set('contactMode', 'new')}>
          شخص أو شركة جديدة
        </button>
        {v.optionalContact && (
          <button type="button" className={v.contactMode === 'none' ? 'on' : ''} onClick={() => f.set('contactMode', 'none')}>
            بدون طرف مرتبط
          </button>
        )}
      </div>
      {v.contactMode === 'existing' && (
        <Select
          className="full"
          label="الاسم"
          required
          options={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.name}${c.phone ? ' — ' + c.phone : ''}` }))}
          {...f.bind('clientId')}
          onChange={(x) => f.setMany({ clientId: x, caseId: '' })}
        />
      )}
      {v.contactMode === 'new' && (
        <>
          <Select label="النوع" options={optsFrom(CLIENT_KINDS)} {...f.bind('ncKind')} onChange={(x) => f.set('ncKind', x)} placeholder="—" />
          <TextInput label="الاسم" required {...f.bind('ncName')} onChange={(x) => f.set('ncName', x)} error={f.errors['newContact.name'] ?? f.errors.ncName} />
          <TextInput label="الجوال" required ltr {...f.bind('ncPhone')} onChange={(x) => f.set('ncPhone', x)} error={f.errors['newContact.phone'] ?? f.errors.ncPhone} hint="يُنبَّه عند وجود جوال مطابق ولا يُدمج تلقائيًا" />
          <TextInput label="البريد (اختياري)" ltr {...f.bind('ncEmail')} onChange={(x) => f.set('ncEmail', x)} error={f.errors['newContact.email']} />
          <div className="full help">يُحفظ في سجل جهات الاتصال الموحد كطالب استشارة؛ ولا يلزم فتح قضية أو وكالة أو عقد.</div>
        </>
      )}
    </>
  );
}

function contactPayload(v: Record<string, any>) {
  if (v.contactMode === 'existing') return { clientId: v.clientId || null, newContact: null };
  if (v.contactMode === 'new') return { clientId: null, newContact: { kind: v.ncKind || 'individual', name: v.ncName, phone: v.ncPhone, email: v.ncEmail || null } };
  return { clientId: null, newContact: null };
}

function endTimeOf(date: string, time: string, minutes: number): string | null {
  try {
    if (!date || !time || !minutes) return null;
    const iso = new Date(new Date(riyadhToUtcIso(date, time)).getTime() + minutes * 60_000).toISOString();
    const r = utcIsoToRiyadh(iso);
    return r.date === date ? r.time : `${r.time} (${r.date})`;
  } catch {
    return null;
  }
}

export function ConsultationForm({ initial, defaults = {}, onClose, onSaved }: { initial?: Consultation; defaults?: { clientId?: string; caseId?: string }; onClose: () => void; onSaved?: (id: string) => void }) {
  const { users, lookup, can, state } = useSession();
  const canFees = can('fees.manage');
  const f = useForm({
    contactMode: initial || defaults.clientId ? 'existing' : 'new',
    optionalContact: false,
    clientId: initial?.clientId ?? defaults.clientId ?? '',
    lockedName: initial?.clientName ?? '',
    ncKind: 'individual',
    ncName: '',
    ncPhone: '',
    ncEmail: '',
    caseId: initial?.caseId ?? defaults.caseId ?? '',
    title: initial?.title ?? '',
    category: initial?.category ?? '',
    description: initial?.description ?? '',
    questions: initial?.questions ?? '',
    method: initial?.method ?? 'phone',
    date: initial?.date ?? todayRiyadh(),
    time: initial?.time ?? '10:00',
    durationMin: String(initial?.durationMin ?? 60),
    location: initial?.location ?? '',
    meetingLink: initial?.meetingLink ?? '',
    responsibleUserId: initial?.responsibleUserId ?? state?.user?.id ?? '',
    feeMode: initial?.finance?.mode ?? (initial ? 'unset' : 'paid'),
    feeAmount: initial?.finance?.mode === 'paid' ? amountToInput(initial.finance.due) : '',
    status: initial?.status ?? 'pending',
    statusReason: initial?.statusReason ?? '',
    writtenRequired: initial?.writtenRequired ?? true,
    internalNotes: initial?.internalNotes ?? '',
    changeReason: '',
  });
  const v = f.values;
  const cases = useCaseOptions(v.contactMode === 'existing' && v.clientId ? v.clientId : '__none__');
  const end = endTimeOf(v.date, v.time, Number(v.durationMin));
  const conflicts = useConflictPreview(v.responsibleUserId, v.date, v.time, null, Number(v.durationMin) || 60, initial ? { kind: 'consultation', id: initial.id } : undefined);
  return (
    <FormModal
      title={initial ? `تعديل موعد الاستشارة ${initial.refNo}` : 'إضافة استشارة'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const fee = v.feeMode === 'paid' && canFees ? amountField(f, 'feeAmount', true) : null;
        if (fee === 'invalid') return;
        const dur = Number(v.durationMin);
        if (!Number.isInteger(dur) || dur < 5) {
          f.setErrors({ durationMin: 'أدخل المدة بالدقائق (5 على الأقل)' });
          return;
        }
        const body = {
          ...contactPayload(v),
          caseId: v.caseId || null,
          title: v.title,
          category: v.category || null,
          description: v.description || null,
          questions: v.questions || null,
          method: v.method as never,
          date: v.date,
          time: v.time,
          durationMin: dur,
          location: v.location || null,
          meetingLink: v.meetingLink || null,
          responsibleUserId: v.responsibleUserId || null,
          feeMode: (canFees ? v.feeMode : initial?.finance?.mode ?? 'unset') as never,
          feeAmount: fee,
          status: v.status as never,
          statusReason: v.statusReason || null,
          writtenRequired: v.writtenRequired,
          internalNotes: v.internalNotes || null,
        };
        try {
          const r = await submitWithChecks(
            (flags) =>
              initial
                ? api('consultations.update', { ...body, ...flags, clientId: initial.clientId, newContact: null, id: initial.id, changeReason: v.changeReason || null }).then(() => ({ id: initial.id }))
                : api('consultations.create', { ...body, ...flags, ...(flags.clientId ? { clientId: flags.clientId, newContact: null } : {}) }),
            (cid) => f.setMany({ contactMode: 'existing', clientId: cid }),
          );
          if (!r) return;
          invalidate();
          toast.success(initial ? 'حُفظ تعديل الاستشارة' : 'أُضيفت الاستشارة');
          onSaved?.(r.id);
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <ContactFields f={f} locked={!!initial} />
        <TextInput className="full" label="عنوان الاستشارة" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <Select label="التصنيف القانوني" options={optsFromList(lookup('consultation_categories'))} {...f.bind('category')} onChange={(x) => f.set('category', x)} hint="القائمة قابلة للتعديل من الإعدادات" />
        <Select label="طريقة الاستشارة" required options={optsFrom(APPT_METHODS)} {...f.bind('method')} onChange={(x) => f.set('method', x as never)} placeholder="—" />
        <DateInput label="تاريخ الاستشارة" required {...f.bind('date')} onChange={(x) => f.set('date', x)} />
        <TimeInput label="وقت البداية" required {...f.bind('time')} onChange={(x) => f.set('time', x)} />
        <TextInput label="المدة بالدقائق" required ltr {...f.bind('durationMin')} onChange={(x) => f.set('durationMin', x)} />
        <Field2 label="وقت النهاية (يُحسب تلقائيًا)" value={end ?? '—'} />
        {!['cancelled', 'no_show'].includes(v.status) && <ConflictNote list={conflicts} />}
        {v.method === 'in_person' ? (
          <TextInput className="full" label="مكان الحضور" {...f.bind('location')} onChange={(x) => f.set('location', x)} />
        ) : v.method === 'video' ? (
          <TextInput className="full" label="رابط الاتصال" ltr {...f.bind('meetingLink')} onChange={(x) => f.set('meetingLink', x)} hint="يُحفظ للرجوع إليه فقط؛ لا يفتح البرنامج روابط خارجية" />
        ) : null}
        <Select label="المحامي أو المستشار المسؤول" options={users.map((u) => ({ value: u.id, label: u.displayName }))} {...f.bind('responsibleUserId')} onChange={(x) => f.set('responsibleUserId', x)} placeholder="غير محدد" />
        <Select label="حالة الموعد" options={optsFrom(CONSULT_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        {(v.status === 'cancelled' || v.status === 'no_show') && (
          <TextInput className="full" label="السبب" required {...f.bind('statusReason')} onChange={(x) => f.set('statusReason', x)} hint="إلغاء الموعد لا يلغي المبلغ تلقائيًا؛ سجّل الاسترداد أو التسوية صراحة من الأتعاب." />
        )}
        {canFees ? (
          <>
            <Select label="الأتعاب" options={[{ value: 'paid', label: 'استشارة مدفوعة' }, { value: 'free', label: 'استشارة مجانية (صفر)' }, { value: 'unset', label: 'لم يُحدد المبلغ بعد' }]} {...f.bind('feeMode')} onChange={(x) => f.set('feeMode', x as never)} placeholder="—" />
            {v.feeMode === 'paid' ? <AmountInput label="مبلغ الاستشارة" required value={v.feeAmount} onChange={(x) => f.set('feeAmount', x)} error={f.errors.feeAmount} /> : <div />}
          </>
        ) : (
          <div className="full help">تحديد مبلغ الاستشارة متاح لمن يملك صلاحية إدارة الأتعاب.</div>
        )}
        {v.contactMode === 'existing' && (cases.data ?? []).length > 0 && (
          <Select label="قضية مرتبطة (اختياري)" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.set('caseId', x)} placeholder="بدون قضية" />
        )}
        <div className="full">
          <Checkbox label="الاستشارة المكتوبة مطلوبة" checked={v.writtenRequired} onChange={(x) => f.set('writtenRequired', x)} hint="تظهر في التنبيهات الإدارية إن تمت الاستشارة دون إرفاقها" />
        </div>
        <TextArea className="full" label="وصف الموضوع" {...f.bind('description')} onChange={(x) => f.set('description', x)} rows={3} />
        <TextArea className="full" label="الأسئلة المطلوب بحثها" {...f.bind('questions')} onChange={(x) => f.set('questions', x)} rows={3} />
        <TextArea className="full" label="ملاحظات داخلية (لا تُطبع للمستفيد افتراضيًا)" {...f.bind('internalNotes')} onChange={(x) => f.set('internalNotes', x)} rows={2} />
        {initial && <TextInput className="full" label="سبب التعديل (يُحفظ في السجل)" {...f.bind('changeReason')} onChange={(x) => f.set('changeReason', x)} />}
      </div>
    </FormModal>
  );
}

function Field2({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="input" style={{ background: 'var(--surface-2, #F7F7F5)' }} aria-live="polite">
        <Ltr>{value}</Ltr>
      </div>
    </div>
  );
}

export function MeetingForm({ initial, defaults = {}, onClose, onSaved }: { initial?: Meeting; defaults?: { clientId?: string; caseId?: string; consultationId?: string }; onClose: () => void; onSaved?: (id: string) => void }) {
  const { users, can, state } = useSession();
  const canFees = can('fees.manage');
  const f = useForm({
    contactMode: initial?.clientId || defaults.clientId ? 'existing' : 'none',
    optionalContact: true,
    clientId: initial?.clientId ?? defaults.clientId ?? '',
    lockedName: initial?.clientName ?? '',
    ncKind: 'individual',
    ncName: '',
    ncPhone: '',
    ncEmail: '',
    title: initial?.title ?? '',
    purpose: initial?.purpose ?? '',
    caseId: initial?.caseId ?? defaults.caseId ?? '',
    consultationId: initial?.consultationId ?? defaults.consultationId ?? '',
    participants: initial?.participants ?? [{ name: '', role: '' }],
    responsibleUserId: initial?.responsibleUserId ?? state?.user?.id ?? '',
    method: initial?.method ?? 'in_person',
    date: initial?.date ?? todayRiyadh(),
    startTime: initial?.startTime ?? '11:00',
    endTime: initial?.endTime ?? '12:00',
    location: initial?.location ?? '',
    meetingLink: initial?.meetingLink ?? '',
    agenda: initial?.agenda ?? '',
    status: initial?.status ?? 'pending',
    statusReason: initial?.statusReason ?? '',
    minutes: initial?.minutes ?? '',
    paid: !!initial?.isPaid,
    feeAmount: amountToInput(initial?.feeAmount ?? null),
    changeReason: '',
  });
  const v = f.values;
  const effectiveClient = v.contactMode === 'existing' ? v.clientId : initial?.clientId ?? '';
  const cases = useCaseOptions(effectiveClient || null);
  const consults = useApi(() => (effectiveClient ? api('consultations.list', { clientId: effectiveClient }) : Promise.resolve([])), [effectiveClient]);
  const parts = v.participants as { name: string; role: string | null }[];
  const conflicts = useConflictPreview(v.responsibleUserId, v.date, v.startTime, v.endTime, null, initial ? { kind: 'meeting', id: initial.id } : undefined);
  const setPart = (i: number, p: Partial<{ name: string; role: string | null }>) => f.set('participants', parts.map((x, k) => (k === i ? { ...x, ...p } : x)) as never);
  return (
    <FormModal
      title={initial ? `تعديل الاجتماع ${initial.refNo}` : 'إضافة اجتماع'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const fee = v.paid && canFees ? amountField(f, 'feeAmount', true) : null;
        if (fee === 'invalid') return;
        const body = {
          ...(initial?.clientId ? { clientId: initial.clientId, newContact: null } : contactPayload(v)),
          title: v.title,
          purpose: v.purpose || null,
          caseId: v.caseId || null,
          consultationId: v.consultationId || null,
          participants: parts.filter((p) => p.name.trim()).map((p) => ({ name: p.name, role: p.role || null })),
          responsibleUserId: v.responsibleUserId || null,
          method: v.method as never,
          date: v.date,
          startTime: v.startTime,
          endTime: v.endTime,
          location: v.location || null,
          meetingLink: v.meetingLink || null,
          agenda: v.agenda || null,
          status: v.status as never,
          statusReason: v.statusReason || null,
          minutes: v.minutes || null,
          feeAmount: canFees ? fee : initial?.feeAmount ?? null,
        };
        try {
          const r = await submitWithChecks(
            (flags) =>
              initial
                ? api('meetings.update', { ...body, ...flags, ...(flags.clientId ? { clientId: flags.clientId, newContact: null } : {}), id: initial.id, changeReason: v.changeReason || null }).then(() => ({ id: initial.id }))
                : api('meetings.create', { ...body, ...flags, ...(flags.clientId ? { clientId: flags.clientId, newContact: null } : {}) }),
            (cid) => f.setMany({ contactMode: 'existing', clientId: cid }),
          );
          if (!r) return;
          invalidate();
          toast.success(initial ? 'حُفظ تعديل الاجتماع' : 'أُضيف الاجتماع');
          onSaved?.(r.id);
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="عنوان الاجتماع" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <TextArea className="full" label="غرض الاجتماع" {...f.bind('purpose')} onChange={(x) => f.set('purpose', x)} rows={2} />
        <ContactFields f={f} locked={!!initial?.clientId} />
        {effectiveClient && (cases.data ?? []).length > 0 && (
          <Select label="القضية المرتبطة (اختياري)" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.set('caseId', x)} placeholder="بدون قضية" />
        )}
        {effectiveClient && (consults.data ?? []).length > 0 && (
          <Select label="الاستشارة المرتبطة (اختياري)" options={(consults.data ?? []).map((c) => ({ value: c.id, label: `${c.refNo} — ${c.title}` }))} {...f.bind('consultationId')} onChange={(x) => f.set('consultationId', x)} placeholder="بدون استشارة" />
        )}
        <Select label="المسؤول عن الاجتماع" options={users.map((u) => ({ value: u.id, label: u.displayName }))} {...f.bind('responsibleUserId')} onChange={(x) => f.set('responsibleUserId', x)} placeholder="غير محدد" />
        <Select label="الطريقة" required options={optsFrom(APPT_METHODS)} {...f.bind('method')} onChange={(x) => f.set('method', x as never)} placeholder="—" />
        <DateInput label="التاريخ" required {...f.bind('date')} onChange={(x) => f.set('date', x)} />
        <Select label="الحالة" options={optsFrom(MEETING_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TimeInput label="وقت البداية" required {...f.bind('startTime')} onChange={(x) => f.set('startTime', x)} />
        <TimeInput label="وقت النهاية" required {...f.bind('endTime')} onChange={(x) => f.set('endTime', x)} />
        {!['cancelled', 'postponed'].includes(v.status) && <ConflictNote list={conflicts} />}
        {(v.status === 'cancelled' || v.status === 'postponed') && <TextInput className="full" label="السبب" required {...f.bind('statusReason')} onChange={(x) => f.set('statusReason', x)} />}
        <TextInput className="full" label={v.method === 'video' ? 'رابط الاتصال' : 'المكان'} ltr={v.method === 'video'} {...f.bind(v.method === 'video' ? 'meetingLink' : 'location')} onChange={(x) => f.set(v.method === 'video' ? 'meetingLink' : 'location', x)} />
        <fieldset className="full">
          <legend>المشاركون وصفاتهم</legend>
          <div className="stack g2">
            {parts.map((p, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <TextInput label={`الاسم ${i + 1}`} value={p.name} onChange={(x) => setPart(i, { name: x })} />
                <TextInput label="الصفة" value={p.role ?? ''} onChange={(x) => setPart(i, { role: x })} />
                <Button size="sm" iconOnly icon={<Trash2 />} aria-label="حذف المشارك" title="حذف المشارك" onClick={() => f.set('participants', parts.filter((_, k) => k !== i) as never)} />
              </div>
            ))}
            <div>
              <Button size="sm" icon={<Plus />} onClick={() => f.set('participants', [...parts, { name: '', role: '' }] as never)}>
                إضافة مشارك
              </Button>
            </div>
          </div>
        </fieldset>
        <TextArea className="full" label="جدول الأعمال" {...f.bind('agenda')} onChange={(x) => f.set('agenda', x)} rows={3} />
        <TextArea className="full" label="محضر الاجتماع" {...f.bind('minutes')} onChange={(x) => f.set('minutes', x)} rows={4} hint="القرارات والتوصيات تُضاف كبنود من صفحة الاجتماع ويمكن تحويل كل بند إلى مهمة" />
        {canFees && (
          <>
            <div className="full">
              <Checkbox label="اجتماع بمقابل مالي" checked={v.paid} onChange={(x) => f.set('paid', x)} hint="الاجتماعات غير مدفوعة افتراضيًا؛ المقابل بند مستقل لا يُكرر في أتعاب القضية أو الاستشارة" />
            </div>
            {v.paid && <AmountInput label="المقابل المالي" required value={v.feeAmount} onChange={(x) => f.set('feeAmount', x)} error={f.errors.feeAmount} />}
          </>
        )}
        {initial && <TextInput className="full" label="سبب التعديل (يُحفظ في السجل)" {...f.bind('changeReason')} onChange={(x) => f.set('changeReason', x)} />}
      </div>
    </FormModal>
  );
}

export function ServiceTxnForm({ consultationId, meetingId, kind = 'payment', onClose }: { consultationId?: string; meetingId?: string; kind?: SvcTxnKind; onClose: () => void }) {
  const { lookup } = useSession();
  const f = useForm({ kind, amount: '', txnOn: todayRiyadh(), method: '', referenceNo: '', reason: '', notes: '' });
  const v = f.values;
  return (
    <FormModal
      title={v.kind === 'payment' ? 'تسجيل دفعة' : v.kind === 'refund' ? 'تسجيل مبلغ مسترد' : 'تسجيل تسوية أو خصم'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = amountField(f, 'amount', true);
        if (amt === 'invalid' || amt === null) return;
        try {
          await api('serviceTxns.create', { consultationId: consultationId ?? null, meetingId: meetingId ?? null, kind: v.kind as SvcTxnKind, amount: amt, txnOn: v.txnOn, method: v.method || null, referenceNo: v.referenceNo || null, reason: v.reason || null, notes: v.notes || null });
          invalidate();
          toast.success('سُجلت الحركة المالية');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <Select label="نوع الحركة" options={optsFrom(SVC_TXN_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as SvcTxnKind)} placeholder="—" />
        <AmountInput label="المبلغ" required value={v.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
        <DateInput label="التاريخ" required {...f.bind('txnOn')} onChange={(x) => f.set('txnOn', x)} />
        {v.kind !== 'discount' && <Select label="الطريقة" options={optsFromList(lookup('payment_methods'))} {...f.bind('method')} onChange={(x) => f.set('method', x)} />}
        <TextInput label="رقم السند / المرجع" ltr {...f.bind('referenceNo')} onChange={(x) => f.set('referenceNo', x)} />
        {v.kind !== 'payment' && <TextInput className="full" label="السبب" required {...f.bind('reason')} onChange={(x) => f.set('reason', x)} />}
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
        <div className="full help">يمكن إرفاق سند الدفع بعد الحفظ من جدول الحركات.</div>
      </div>
    </FormModal>
  );
}

type ConsultDoc = MethodOutput<'documents.list'>[number];
type Opinion = MethodOutput<'consultations.get'>['opinions'][number];

export function OpinionForm({ consultationId, refNo, initial, docs, onClose }: { consultationId: string; refNo: string; initial?: Opinion; docs: ConsultDoc[]; onClose: () => void }) {
  const { state } = useSession();
  const [upload, setUpload] = useState(false);
  const f = useForm({
    title: initial?.title ?? 'الاستشارة القانونية المكتوبة',
    opinionDate: initial?.opinionDate ?? todayRiyadh(),
    authorName: initial?.authorName ?? state?.user?.displayName ?? '',
    status: initial && initial.status !== 'delivered' ? initial.status : 'draft',
    body: initial?.body ?? '',
    documentId: initial?.documentId ?? '',
    note: '',
  });
  const v = f.values;
  const fileDocs = docs.filter((d) => d.category === 'legal_opinion');
  return (
    <FormModal
      title={initial ? `نسخة معدلة: ${initial.title}` : 'إضافة الاستشارة المكتوبة'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel={initial ? 'حفظ نسخة معدلة' : 'حفظ'}
      onSubmit={async () => {
        try {
          const base = { title: v.title, opinionDate: v.opinionDate || null, authorName: v.authorName || null, body: v.body || null, documentId: v.documentId || null, status: v.status as never };
          if (initial) await api('opinions.update', { ...base, id: initial.id, note: v.note || null, baseRevision: initial.revision });
          else await api('opinions.create', { ...base, consultationId });
          invalidate();
          toast.success(initial ? 'حُفظت النسخة المعدلة — النسخ السابقة محفوظة' : 'حُفظت الاستشارة المكتوبة');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="العنوان" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <DateInput label="التاريخ" {...f.bind('opinionDate')} onChange={(x) => f.set('opinionDate', x)} />
        <TextInput label="معدّ الاستشارة" {...f.bind('authorName')} onChange={(x) => f.set('authorName', x)} />
        <Select label="الحالة" options={[{ value: 'draft', label: 'مسودة' }, { value: 'review', label: 'قيد المراجعة' }, { value: 'approved', label: 'معتمدة داخليًا' }]} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" hint="التسليم للمستفيد يُسجل منفصلًا بتاريخه وطريقته" />
        <div className="field">
          <Select label="ملف الاستشارة (PDF أو Word)" options={fileDocs.map((d) => ({ value: d.id, label: `${d.title} — ${(d.current?.ext ?? '').toUpperCase()} (نسخة ${d.currentVersion})` }))} {...f.bind('documentId')} onChange={(x) => f.set('documentId', x)} placeholder="بدون ملف — نص فقط" />
          <Button size="sm" icon={<Upload />} onClick={() => setUpload(true)}>
            رفع ملف PDF أو Word
          </Button>
        </div>
        <TextArea className="full" tall label="نص الاستشارة (محرر محلي)" {...f.bind('body')} onChange={(x) => f.set('body', x)} rows={12} hint="يمكن الاكتفاء بالملف المرفق أو بالنص أو بكليهما. لإضافة نسخة جديدة من الملف استخدم «إضافة نسخة» في المستند نفسه." />
        {initial && <TextInput className="full" label="ملاحظة على هذه النسخة" {...f.bind('note')} onChange={(x) => f.set('note', x)} />}
      </div>
      {upload && (
        <DocumentAttachForm
          defaults={{ consultationId, category: 'legal_opinion', title: v.title, lockedLabel: `الاستشارة ${refNo}` }}
          onClose={() => setUpload(false)}
          onSaved={(id) => f.set('documentId', id)}
        />
      )}
    </FormModal>
  );
}

export function DeliveryForm({ opinion, consultationId, refNo, docs, onClose }: { opinion: Opinion; consultationId: string; refNo: string; docs: ConsultDoc[]; onClose: () => void }) {
  const { lookup } = useSession();
  const [upload, setUpload] = useState(false);
  const f = useForm({ deliveredOn: todayRiyadh(), deliveryMethod: '', notes: '', proofDocumentId: '' });
  const v = f.values;
  return (
    <FormModal
      title={`تسجيل تسليم «${opinion.title}»`}
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="تسجيل التسليم"
      onSubmit={async () => {
        try {
          await api('opinions.deliver', { id: opinion.id, deliveredOn: v.deliveredOn, deliveryMethod: v.deliveryMethod, notes: v.notes || null, proofDocumentId: v.proofDocumentId || null });
          invalidate();
          toast.success('سُجل التسليم');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <DateInput label="تاريخ التسليم" required {...f.bind('deliveredOn')} onChange={(x) => f.set('deliveredOn', x)} />
        <Select label="طريقة التسليم" required options={optsFromList(lookup('delivery_methods'))} {...f.bind('deliveryMethod')} onChange={(x) => f.set('deliveryMethod', x)} />
        <div className="field full">
          <Select label="مرفق إثبات (اختياري)" options={docs.filter((d) => d.category === 'delivery_proof').map((d) => ({ value: d.id, label: d.title }))} {...f.bind('proofDocumentId')} onChange={(x) => f.set('proofDocumentId', x)} placeholder="بدون مرفق" />
          <Button size="sm" icon={<Upload />} onClick={() => setUpload(true)}>
            رفع إثبات التسليم
          </Button>
        </div>
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
        <div className="full help">يُسجل التسليم يدويًا فقط؛ البرنامج لا يرسل رسائل ولا بريدًا.</div>
      </div>
      {upload && <DocumentAttachForm defaults={{ consultationId, category: 'delivery_proof', title: 'إثبات تسليم الاستشارة', lockedLabel: `الاستشارة ${refNo}` }} onClose={() => setUpload(false)} onSaved={(id) => f.set('proofDocumentId', id)} />}
    </FormModal>
  );
}

export function MeetingItemForm({ meetingId, initial, onClose }: { meetingId: string; initial?: { id: string; kind: 'decision' | 'recommendation'; text: string }; onClose: () => void }) {
  const f = useForm({ kind: initial?.kind ?? 'decision', text: initial?.text ?? '' });
  return (
    <FormModal
      title={initial ? 'تعديل بند من المحضر' : 'إضافة قرار أو توصية'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        try {
          await api('meetingItems.save', { id: initial?.id ?? null, meetingId, kind: f.values.kind as never, text: f.values.text });
          invalidate();
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <Select label="النوع" options={optsFrom(MEETING_ITEM_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as never)} placeholder="—" />
        <TextArea className="full" label="النص" required {...f.bind('text')} onChange={(x) => f.set('text', x)} rows={3} />
      </div>
    </FormModal>
  );
}

export function ItemToTaskForm({ item, onClose }: { item: { id: string; text: string }; onClose: () => void }) {
  const { users, state } = useSession();
  const f = useForm({ title: item.text.slice(0, 200), assigneeUserId: state?.user?.id ?? '', dueDate: addDays(todayRiyadh(), 7), priority: 'normal' });
  return (
    <FormModal
      title="تحويل البند إلى مهمة"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="إنشاء المهمة"
      onSubmit={async () => {
        try {
          await api('meetingItems.toTask', { itemId: item.id, title: f.values.title, assigneeUserId: f.values.assigneeUserId || null, dueDate: f.values.dueDate || null, priority: f.values.priority as never });
          invalidate();
          toast.success('أُنشئت المهمة مرتبطة بالاجتماع');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="عنوان المهمة" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <Select label="المسؤول" options={users.map((u) => ({ value: u.id, label: u.displayName }))} {...f.bind('assigneeUserId')} onChange={(x) => f.set('assigneeUserId', x)} placeholder="غير محدد" />
        <DateInput label="الموعد" {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
        <Select label="الأولوية" options={optsFrom(PRIORITIES)} {...f.bind('priority')} onChange={(x) => f.set('priority', x)} placeholder="—" />
      </div>
    </FormModal>
  );
}

/** ربط الاستشارة بقضية للشخص نفسه، مع تسوية اختيارية واضحة تحتسب ما سُدد للاستشارة من أتعاب القضية. */
export function LinkCaseForm({ consultation, onClose }: { consultation: Consultation; onClose: () => void }) {
  const { can } = useSession();
  const cases = useCaseOptions(consultation.clientId);
  const [newCase, setNewCase] = useState(false);
  const available = consultation.finance ? Math.max(consultation.finance.netPaid - consultation.finance.credited, 0) : 0;
  const f = useForm({ caseId: consultation.caseId ?? '', credit: false, contractId: '', amount: amountToInput(available), reason: `احتساب ما دُفع للاستشارة ${consultation.refNo} من أتعاب القضية`, adjustedOn: todayRiyadh() });
  const v = f.values;
  const contracts = useApi(() => (v.caseId ? api('contracts.list', { caseId: v.caseId }) : Promise.resolve([])), [v.caseId]);
  const canCredit = can('fees.manage') && available > 0;
  return (
    <FormModal
      title={`ربط الاستشارة ${consultation.refNo} بقضية`}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        let credit = null;
        if (v.credit) {
          const amt = amountField(f, 'amount', true);
          if (amt === 'invalid' || amt === null) return;
          if (!v.contractId) {
            f.setErrors({ contractId: 'اختر عقد القضية' });
            return;
          }
          credit = { contractId: v.contractId, amount: amt, reason: v.reason, adjustedOn: v.adjustedOn };
        }
        try {
          await api('consultations.linkCase', { id: consultation.id, caseId: v.caseId || null, credit });
          invalidate();
          toast.success(v.caseId ? 'رُبطت الاستشارة بالقضية — سجل الاستشارة ومبالغها محفوظة دون تكرار' : 'أُلغي الربط');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <Select className="full" label={`قضايا ${consultation.clientName}`} options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.setMany({ caseId: x, contractId: '' })} placeholder="بدون قضية" />
        <div className="full">
          <Button size="sm" icon={<Plus />} onClick={() => setNewCase(true)}>
            فتح قضية جديدة لهذا الشخص
          </Button>
          <div className="help">تُفتح القضية لنفس السجل فلا يتكرر الشخص، ويبقى سجل استشاراته كما هو.</div>
        </div>
        {canCredit && v.caseId && (
          <>
            <div className="full">
              <Checkbox label={`احتساب المبلغ المسدد للاستشارة من أتعاب القضية (المتاح ${fmtAmount(available)})`} checked={v.credit} onChange={(x) => f.set('credit', x)} hint="يُسجل تسوية مرتبطة على عقد القضية تنقص المتبقي، دون أن يُحسب المبلغ المحصل مرتين" />
            </div>
            {v.credit && (
              <>
                <Select label="عقد القضية" required options={(contracts.data ?? []).filter((k) => k.feeType !== 'none').map((k) => ({ value: k.id, label: k.title }))} {...f.bind('contractId')} onChange={(x) => f.set('contractId', x)} hint={(contracts.data ?? []).length === 0 ? 'سجّل أتعاب القضية أولًا' : undefined} />
                <AmountInput label="المبلغ المحتسب" required value={v.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
                <DateInput label="تاريخ التسوية" required {...f.bind('adjustedOn')} onChange={(x) => f.set('adjustedOn', x)} />
                <TextInput className="full" label="سبب التسوية" required {...f.bind('reason')} onChange={(x) => f.set('reason', x)} />
              </>
            )}
          </>
        )}
      </div>
      {newCase && <CaseForm clientId={consultation.clientId} onClose={() => setNewCase(false)} onSaved={(id) => f.set('caseId', id)} />}
    </FormModal>
  );
}

export function AdjustmentForm({ contractId, title, onClose }: { contractId: string; title: string; onClose: () => void }) {
  const { lookup } = useSession();
  const f = useForm({ kind: 'discount', amount: '', adjustedOn: todayRiyadh(), reason: '', method: '', referenceNo: '' });
  const v = f.values;
  return (
    <FormModal
      title={`خصم / تسوية / استرداد — ${title}`}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = amountField(f, 'amount', true);
        if (amt === 'invalid' || amt === null) return;
        try {
          await api('adjustments.create', { contractId, kind: v.kind as never, amount: amt, adjustedOn: v.adjustedOn, reason: v.reason, method: v.method || null, referenceNo: v.referenceNo || null });
          invalidate();
          toast.success('سُجلت الحركة');
          onClose();
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="form-grid">
        <Select label="النوع" options={[{ value: 'discount', label: 'خصم / تسوية (تنقص المستحق)' }, { value: 'refund', label: 'مبلغ مسترد للعميل (ينقص المستلم)' }]} {...f.bind('kind')} onChange={(x) => f.set('kind', x)} placeholder="—" />
        <AmountInput label="المبلغ" required value={v.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
        <DateInput label="التاريخ" required {...f.bind('adjustedOn')} onChange={(x) => f.set('adjustedOn', x)} />
        {v.kind === 'refund' && <Select label="الطريقة" options={optsFromList(lookup('payment_methods'))} {...f.bind('method')} onChange={(x) => f.set('method', x)} />}
        <TextInput label="المرجع" ltr {...f.bind('referenceNo')} onChange={(x) => f.set('referenceNo', x)} />
        <TextInput className="full" label="السبب" required {...f.bind('reason')} onChange={(x) => f.set('reason', x)} />
      </div>
    </FormModal>
  );
}

export function useConflictPreview(responsibleUserId: string, date: string, start: string, end: string | null, durationMin: number | null, exclude?: { kind: 'consultation' | 'meeting'; id: string }) {
  const key = useMemo(() => [responsibleUserId, date, start, end, durationMin, exclude?.id].join('|'), [responsibleUserId, date, start, end, durationMin, exclude?.id]);
  const [data, setData] = useState<Conflict[]>([]);
  useEffect(() => {
    if (!responsibleUserId || !date || !start) return setData([]);
    let alive = true;
    api('appointments.conflicts', { responsibleUserId, date, startTime: start, endTime: end, durationMin, excludeKind: exclude?.kind ?? null, excludeId: exclude?.id ?? null }).then(
      (r) => alive && setData(r),
      () => alive && setData([]),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return data;
}

export function ConflictNote({ list }: { list: Conflict[] }) {
  if (!list.length) return null;
  return (
    <div className="full">
      <Alert tone="warning">
        يتعارض الموعد مع: {list.map((c) => `${c.label} (${fmtDateTime(c.startsAt)})`).join('، ')}. سيُطلب منك تأكيد الاستمرار عند الحفظ.
      </Alert>
    </div>
  );
}
