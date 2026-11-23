import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, Button, Checkbox, DateInput, Select, TextArea, TextInput, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { clean, useApi, useDebounced, useForm } from '../lib/hooks';
import { useSession } from '../lib/session';
import { CLIENT_KINDS, FOLLOW_STATUSES, PRIORITIES, STAGE_STATUSES } from '../../shared/constants';
import { AmountInput, amountField, amountToInput, FormModal, optsFrom, optsFromList, save, useClientOptions, useUsersOptions } from './common';
import type { MethodOutput } from '../../main/ipc/registry';

type ClientFull = MethodOutput<'clients.get'>['client'];

export function ClientForm({ initial, onClose, onSaved }: { initial?: ClientFull; onClose: () => void; onSaved?: (id: string) => void }) {
  const { lookup } = useSession();
  const f = useForm({
    kind: initial?.kind ?? 'company',
    name: initial?.name ?? '',
    shortName: initial?.shortName ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    address: initial?.address ?? '',
    idType: initial?.idType ?? '',
    idNumber: initial?.idNumber ?? '',
    repName: initial?.repName ?? '',
    repTitle: initial?.repTitle ?? '',
    repPhone: initial?.repPhone ?? '',
    repEmail: initial?.repEmail ?? '',
    relationshipSummary: initial?.relationshipSummary ?? '',
    notes: initial?.notes ?? '',
  });
  const v = f.values;
  const name = useDebounced(v.name, 400);
  const phone = useDebounced(v.phone, 400);
  const idn = useDebounced(v.idNumber, 400);
  const similar = useApi(() => api('clients.similar', { name, phone, idNumber: idn, excludeId: initial?.id ?? null }), [name, phone, idn]);
  const isOrg = v.kind !== 'individual';
  return (
    <FormModal
      title={initial ? 'تعديل بيانات العميل' : 'إضافة عميل'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const body = clean(v) as never;
        const r = initial ? await save(f, () => api('clients.update', { ...(body as object), id: initial.id } as never), 'حُفظت بيانات العميل') : await save(f, () => api('clients.create', body), 'أُضيف العميل');
        if (r !== undefined) {
          onSaved?.(initial?.id ?? (r as { id: string }).id);
          onClose();
        }
      }}
    >
      <div className="form-grid">
        <Select label="نوع العميل" required options={optsFrom(CLIENT_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as never)} />
        <TextInput label={isOrg ? 'اسم الشركة / المنشأة' : 'الاسم'} required {...f.bind('name')} onChange={(x) => f.set('name', x)} autoFocus />
        <TextInput label="الاسم المختصر" {...f.bind('shortName')} onChange={(x) => f.set('shortName', x)} />
        <TextInput label="الجوال" ltr {...f.bind('phone')} onChange={(x) => f.set('phone', x)} placeholder="05xxxxxxxx" />
        <TextInput label="البريد الإلكتروني" ltr {...f.bind('email')} onChange={(x) => f.set('email', x)} />
        <TextInput label="العنوان" {...f.bind('address')} onChange={(x) => f.set('address', x)} />
        <Select label="نوع المعرف الرسمي" options={optsFromList(lookup('id_types'))} {...f.bind('idType')} onChange={(x) => f.set('idType', x)} />
        <TextInput label="رقم المعرف الرسمي" ltr {...f.bind('idNumber')} onChange={(x) => f.set('idNumber', x)} hint="عند توفره فقط" />
        {isOrg && (
          <>
            <TextInput label="اسم الممثل" {...f.bind('repName')} onChange={(x) => f.set('repName', x)} />
            <TextInput label="صفة الممثل" {...f.bind('repTitle')} onChange={(x) => f.set('repTitle', x)} />
            <TextInput label="جوال الممثل" ltr {...f.bind('repPhone')} onChange={(x) => f.set('repPhone', x)} />
            <TextInput label="بريد الممثل" ltr {...f.bind('repEmail')} onChange={(x) => f.set('repEmail', x)} />
          </>
        )}
        <TextArea className="full" label="ملخص العلاقة التعاقدية" {...f.bind('relationshipSummary')} onChange={(x) => f.set('relationshipSummary', x)} rows={3} />
        <TextArea className="full" label="ملاحظات المكتب (داخلية)" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={3} />
        {!!similar.data?.length && (
          <div className="full">
            <Alert tone="warning">
              يوجد عملاء مشابهون (لن يُدمجوا تلقائيًا — تأكد أنه ليس العميل نفسه):
              <ul style={{ margin: '6px 0 0', paddingRight: 18 }}>
                {similar.data.map((s) => (
                  <li key={s.id}>
                    {s.name} {s.phone && <Ltr>{s.phone}</Ltr>} {s.idNumber && <Ltr>{s.idNumber}</Ltr>}
                  </li>
                ))}
              </ul>
            </Alert>
          </div>
        )}
      </div>
    </FormModal>
  );
}

type CaseData = MethodOutput<'cases.get'>['case'];

interface PartyRow {
  name: string;
  role: string;
  isOpponent: boolean;
}

export function CaseForm({ initial, clientId, onClose, onSaved }: { initial?: CaseData; clientId?: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const { lookup, users, isOwner, state } = useSession();
  const clients = useClientOptions();
  const f = useForm({
    clientId: initial?.clientId ?? clientId ?? '',
    title: initial?.title ?? '',
    caseType: initial?.caseType ?? '',
    subject: initial?.subject ?? '',
    requests: initial?.requests ?? '',
    claimAmount: amountToInput(initial?.claimAmount),
    openedOn: initial?.openedOn ?? '',
    responsibleUserId: initial?.responsibleUserId ?? (isOwner ? '' : state?.user?.id ?? ''),
    followStatus: initial?.followStatus ?? 'in_progress',
    priority: initial?.priority ?? 'normal',
    notes: initial?.notes ?? '',
    nextAction: initial?.nextAction ?? '',
    nextActionDue: initial?.nextActionDue ?? '',
    withStage: !initial,
    stageType: 'الدرجة الأولى',
    courtType: '',
    courtName: '',
    circuit: '',
    officialCaseNo: '',
    startedOn: '',
  });
  const [parties, setParties] = useState<PartyRow[]>(initial ? [] : [{ name: '', role: '', isOpponent: true }]);
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل بيانات القضية' : 'إضافة قضية'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty || parties.some((p) => p.name)}
      onSubmit={async () => {
        const claim = amountField(f, 'claimAmount');
        if (claim === 'invalid') return;
        const base = {
          clientId: v.clientId,
          title: v.title,
          caseType: v.caseType || null,
          subject: v.subject || null,
          requests: v.requests || null,
          claimAmount: claim,
          openedOn: v.openedOn || null,
          responsibleUserId: v.responsibleUserId || null,
          followStatus: v.followStatus as never,
          priority: v.priority as never,
          notes: v.notes || null,
          nextAction: v.nextAction || null,
          nextActionDue: v.nextActionDue || null,
        };
        if (initial) {
          const r = await save(f, () => api('cases.update', { ...base, id: initial.id }), 'حُفظت بيانات القضية');
          if (r) {
            onSaved?.(initial.id);
            onClose();
          }
          return;
        }
        const r = await save(
          f,
          () =>
            api('cases.create', {
              ...base,
              parties: parties.filter((p) => p.name.trim()).map((p) => ({ name: p.name, role: p.role || null, isOpponent: p.isOpponent })),
              firstStage: v.withStage ? { stageType: v.stageType, courtType: v.courtType || null, courtName: v.courtName || null, circuit: v.circuit || null, officialCaseNo: v.officialCaseNo || null, startedOn: v.startedOn || null, status: 'ongoing' } : null,
            }),
          'فُتح ملف القضية',
        );
        if (r) {
          onSaved?.(r.id);
          onClose();
        }
      }}
    >
      <div className="form-grid">
        <Select
          label="العميل"
          required
          options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          {...f.bind('clientId')}
          onChange={(x) => f.set('clientId', x)}
          disabled={!!initial || !!clientId}
        />
        <TextInput label="عنوان القضية" required {...f.bind('title')} onChange={(x) => f.set('title', x)} autoFocus />
        <Select label="نوع القضية" options={optsFromList(lookup('case_types'))} {...f.bind('caseType')} onChange={(x) => f.set('caseType', x)} />
        <DateInput label="تاريخ فتح الملف" {...f.bind('openedOn')} onChange={(x) => f.set('openedOn', x)} hint="اتركه فارغًا إن لم يكن معلومًا" />
        <Select label="المسؤول عن الملف" options={useUsersOptions(users)} {...f.bind('responsibleUserId')} onChange={(x) => f.set('responsibleUserId', x)} disabled={!isOwner} hint={isOwner ? 'تعيين مستشار يمنحه الوصول لهذا الملف' : undefined} />
        <Select label="حالة المتابعة" options={optsFrom(FOLLOW_STATUSES)} {...f.bind('followStatus')} onChange={(x) => f.set('followStatus', x as never)} placeholder="—" />
        <Select label="الأولوية" options={optsFrom(PRIORITIES)} {...f.bind('priority')} onChange={(x) => f.set('priority', x as never)} placeholder="—" />
        <AmountInput label="مبلغ المطالبة" value={v.claimAmount} onChange={(x) => f.set('claimAmount', x)} error={f.errors.claimAmount} hint="يترك فارغًا إن لم يوجد" />
        <TextArea className="full" label="الموضوع المختصر" {...f.bind('subject')} onChange={(x) => f.set('subject', x)} rows={2} />
        <TextArea className="full" label="الطلبات" {...f.bind('requests')} onChange={(x) => f.set('requests', x)} rows={3} />
        <TextInput label="الإجراء التالي (يدوي)" {...f.bind('nextAction')} onChange={(x) => f.set('nextAction', x)} />
        <DateInput label="موعد الإجراء التالي" {...f.bind('nextActionDue')} onChange={(x) => f.set('nextActionDue', x)} />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
      {!initial && (
        <>
          <fieldset style={{ marginTop: 16 }}>
            <legend>الأطراف والخصوم</legend>
            <div className="stack">
              {parties.map((p, i) => (
                <div key={i} className="row wrap top">
                  <TextInput className="grow" label={i === 0 ? 'اسم الطرف' : undefined} value={p.name} onChange={(x) => setParties((ps) => ps.map((q, j) => (j === i ? { ...q, name: x } : q)))} />
                  <Select label={i === 0 ? 'الصفة' : undefined} options={optsFromList(lookup('party_roles'))} value={p.role} onChange={(x) => setParties((ps) => ps.map((q, j) => (j === i ? { ...q, role: x } : q)))} />
                  <div style={{ paddingTop: i === 0 ? 30 : 6 }}>
                    <Checkbox label="خصم" checked={p.isOpponent} onChange={(x) => setParties((ps) => ps.map((q, j) => (j === i ? { ...q, isOpponent: x } : q)))} />
                  </div>
                  <div style={{ paddingTop: i === 0 ? 28 : 0 }}>
                    <Button variant="ghost" iconOnly icon={<Trash2 />} aria-label="حذف الطرف" onClick={() => setParties((ps) => ps.filter((_, j) => j !== i))} />
                  </div>
                </div>
              ))}
              <div>
                <Button size="sm" icon={<Plus />} onClick={() => setParties((ps) => [...ps, { name: '', role: '', isOpponent: true }])}>
                  إضافة طرف
                </Button>
              </div>
            </div>
          </fieldset>
          <fieldset style={{ marginTop: 16 }}>
            <legend>
              <Checkbox label="تسجيل المرحلة الأولى الآن" checked={v.withStage} onChange={(x) => f.set('withStage', x)} />
            </legend>
            {v.withStage && (
              <div className="form-grid">
                <Select label="المرحلة" required options={optsFromList(lookup('stage_types'))} {...f.bind('stageType')} onChange={(x) => f.set('stageType', x)} />
                <Select label="الجهة القضائية" options={optsFromList(lookup('court_types'))} {...f.bind('courtType')} onChange={(x) => f.set('courtType', x)} />
                <TextInput label="المحكمة" {...f.bind('courtName')} onChange={(x) => f.set('courtName', x)} />
                <TextInput label="الدائرة" {...f.bind('circuit')} onChange={(x) => f.set('circuit', x)} />
                <TextInput label="رقم القضية الرسمي" ltr {...f.bind('officialCaseNo')} onChange={(x) => f.set('officialCaseNo', x)} hint="يختلف عن رقم الملف الداخلي" />
                <DateInput label="تاريخ بدء المرحلة" {...f.bind('startedOn')} onChange={(x) => f.set('startedOn', x)} />
              </div>
            )}
          </fieldset>
        </>
      )}
    </FormModal>
  );
}

export function PartyForm({ caseId, initial, onClose }: { caseId: string; initial?: MethodOutput<'cases.get'>['parties'][number]; onClose: () => void }) {
  const { lookup } = useSession();
  const f = useForm({ name: initial?.name ?? '', role: initial?.role ?? '', isOpponent: initial?.isOpponent ?? true, idNumber: initial?.idNumber ?? '', representative: initial?.representative ?? '', notes: initial?.notes ?? '' });
  return (
    <FormModal
      title={initial ? 'تعديل طرف' : 'إضافة طرف'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('parties.save', { ...(clean(f.values) as Record<string, unknown>), isOpponent: f.values.isOpponent, caseId, id: initial?.id ?? null } as never), 'حُفظ الطرف');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput label="الاسم" required {...f.bind('name')} onChange={(x) => f.set('name', x)} autoFocus />
        <Select label="الصفة" options={optsFromList(lookup('party_roles'))} {...f.bind('role')} onChange={(x) => f.set('role', x)} />
        <TextInput label="رقم الهوية / السجل" ltr {...f.bind('idNumber')} onChange={(x) => f.set('idNumber', x)} />
        <TextInput label="ممثله / وكيله" {...f.bind('representative')} onChange={(x) => f.set('representative', x)} />
        <div className="full">
          <Checkbox label="طرف خصم" checked={f.values.isOpponent} onChange={(x) => f.set('isOpponent', x)} />
        </div>
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function StageForm({ caseId, initial, stages, onClose }: { caseId: string; initial?: MethodOutput<'cases.get'>['stages'][number]; stages: MethodOutput<'cases.get'>['stages']; onClose: () => void }) {
  const { lookup } = useSession();
  const last = stages[stages.length - 1];
  const f = useForm({
    stageType: initial?.stageType ?? (stages.length ? 'الاستئناف' : 'الدرجة الأولى'),
    courtType: initial?.courtType ?? last?.courtType ?? '',
    courtName: initial?.courtName ?? '',
    circuit: initial?.circuit ?? '',
    officialCaseNo: initial?.officialCaseNo ?? '',
    startedOn: initial?.startedOn ?? '',
    endedOn: initial?.endedOn ?? '',
    status: initial?.status ?? 'ongoing',
    previousStageId: initial ? initial.previousStageId ?? '' : last?.id ?? '',
    notes: initial?.notes ?? '',
    endPrevious: !initial && !!last && last.status === 'ongoing',
  });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل المرحلة' : 'إضافة مرحلة'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const body = {
          stageType: v.stageType,
          courtType: v.courtType || null,
          courtName: v.courtName || null,
          circuit: v.circuit || null,
          officialCaseNo: v.officialCaseNo || null,
          startedOn: v.startedOn || null,
          endedOn: v.endedOn || null,
          status: v.status as never,
          previousStageId: v.previousStageId || null,
          notes: v.notes || null,
        };
        const r = initial ? await save(f, () => api('stages.update', { ...body, id: initial.id }), 'حُفظت المرحلة') : await save(f, () => api('stages.create', { ...body, caseId }), 'أُضيفت المرحلة');
        if (r && !initial && v.endPrevious && last) {
          await save(f, () => api('stages.update', { ...last, status: 'ended', endedOn: last.endedOn ?? (v.startedOn || null) } as never));
        }
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="المرحلة" required options={optsFromList(lookup('stage_types'))} {...f.bind('stageType')} onChange={(x) => f.set('stageType', x)} />
        <Select label="الجهة القضائية" options={optsFromList(lookup('court_types'))} {...f.bind('courtType')} onChange={(x) => f.set('courtType', x)} />
        <TextInput label="المحكمة" {...f.bind('courtName')} onChange={(x) => f.set('courtName', x)} />
        <TextInput label="الدائرة" {...f.bind('circuit')} onChange={(x) => f.set('circuit', x)} />
        <TextInput label="رقم القضية الرسمي في هذه المرحلة" ltr {...f.bind('officialCaseNo')} onChange={(x) => f.set('officialCaseNo', x)} />
        <Select label="الحالة" options={optsFrom(STAGE_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <DateInput label="تاريخ البدء" {...f.bind('startedOn')} onChange={(x) => f.set('startedOn', x)} />
        <DateInput label="تاريخ الانتهاء" {...f.bind('endedOn')} onChange={(x) => f.set('endedOn', x)} />
        <Select
          label="المرحلة السابقة المرتبطة"
          options={stages.filter((s) => s.id !== initial?.id).map((s) => ({ value: s.id, label: `${s.stageType}${s.officialCaseNo ? ' — ' + s.officialCaseNo : ''}` }))}
          {...f.bind('previousStageId')}
          onChange={(x) => f.set('previousStageId', x)}
          placeholder="لا يوجد"
          hint="الانتقال للاستئناف يحفظ تاريخ المرحلة السابقة ولا يستبدله"
        />
        {!initial && last && last.status === 'ongoing' && (
          <div style={{ paddingTop: 30 }}>
            <Checkbox label={`تعليم «${last.stageType}» كمنتهية`} checked={v.endPrevious} onChange={(x) => f.set('endPrevious', x)} />
          </div>
        )}
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function useEffectOnce(fn: () => void) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, []);
}
