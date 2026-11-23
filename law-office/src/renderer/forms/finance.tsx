import { Alert, Checkbox, DateInput, Select, TextArea, TextInput, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { useSession } from '../lib/session';
import { COMM_CHANNELS, CONTRACT_KINDS, CONTRACT_STATUSES, FEE_TYPES, POA_STATUSES, PRIORITIES, TASK_STATUSES } from '../../shared/constants';
import { fmtAmount } from '../../shared/money';
import { fmtDateTime, todayRiyadh } from '../../shared/dates';
import { AmountInput, amountField, amountToInput, FormModal, optsFrom, optsFromList, save, useCaseLinks, useCaseOptions, useClientOptions, useUsersOptions } from './common';
import type { MethodOutput } from '../../main/ipc/registry';

type Contract = MethodOutput<'contracts.list'>[number];

function CaseChecklist({ clientId, value, onChange, error }: { clientId: string; value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const cases = useCaseOptions(clientId || null);
  return (
    <div className="field full">
      <span className="label">القضايا المشمولة</span>
      <div className="check-list">
        {!clientId ? (
          <div className="help">اختر العميل أولًا</div>
        ) : (cases.data ?? []).length === 0 ? (
          <div className="help">لا توجد قضايا لهذا العميل بعد</div>
        ) : (
          (cases.data ?? []).map((c) => (
            <Checkbox key={c.id} label={<span><Ltr>{c.fileNo}</Ltr> — {c.title}</span>} checked={value.includes(c.id)} onChange={(x) => onChange(x ? [...value, c.id] : value.filter((i) => i !== c.id))} />
          ))
        )}
      </div>
      <div className="hint">العقد يُحفظ مرة واحدة ويرتبط بالقضايا المختارة دون تكرار مبلغه. لا يُفترض شموله قضايا غير محددة.</div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function ContractForm({ clientId, initial, caseId, onClose }: { clientId?: string; initial?: Contract; caseId?: string; onClose: () => void }) {
  const clients = useClientOptions();
  const f = useForm({
    clientId: initial?.clientId ?? clientId ?? '',
    kind: initial?.kind ?? 'fee',
    parentContractId: initial?.parentContractId ?? '',
    title: initial?.title ?? '',
    contractNo: initial?.contractNo ?? '',
    signedOn: initial?.signedOn ?? '',
    startDate: initial?.startDate ?? '',
    endDate: initial?.endDate ?? '',
    scope: initial?.scope ?? '',
    feeType: initial?.feeType ?? 'fixed',
    fixedAmount: amountToInput(initial?.fixedAmount),
    percentage: initial?.percentage?.toString() ?? '',
    percentageBasis: initial?.percentageBasis ?? '',
    status: initial?.status ?? 'active',
    notes: initial?.notes ?? '',
    caseIds: initial?.cases.map((c) => c.id) ?? (caseId ? [caseId] : []),
  });
  const v = f.values;
  const parents = useApi(() => (v.clientId ? api('contracts.list', { clientId: v.clientId }) : Promise.resolve([])), [v.clientId]);
  const fixed = v.feeType === 'fixed' || v.feeType === 'mixed';
  const pct = v.feeType === 'percentage' || v.feeType === 'mixed';
  return (
    <FormModal
      title={initial ? 'تعديل العقد' : 'إضافة عقد'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = fixed ? amountField(f, 'fixedAmount', true) : null;
        if (amt === 'invalid') return;
        const p = pct ? Number(String(v.percentage).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))) : null;
        if (pct && (p === null || Number.isNaN(p) || p < 0 || p > 100)) {
          f.setErrors({ percentage: 'نسبة غير صالحة (0 - 100)' });
          return;
        }
        const body = {
          clientId: v.clientId,
          kind: v.kind as never,
          parentContractId: v.parentContractId || null,
          title: v.title,
          contractNo: v.contractNo || null,
          signedOn: v.signedOn || null,
          startDate: v.startDate || null,
          endDate: v.endDate || null,
          scope: v.scope,
          feeType: v.feeType as never,
          fixedAmount: amt,
          percentage: p,
          percentageBasis: v.percentageBasis || null,
          status: v.status as never,
          notes: v.notes || null,
          caseIds: v.caseIds,
        };
        const r = initial ? await save(f, () => api('contracts.update', { ...body, id: initial.id }), 'حُفظ العقد') : await save(f, () => api('contracts.create', body), 'سُجل العقد');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="العميل" required options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} {...f.bind('clientId')} onChange={(x) => f.setMany({ clientId: x, caseIds: [] })} disabled={!!initial || !!clientId} />
        <Select label="نوع العقد" options={optsFrom(CONTRACT_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as never)} placeholder="—" />
        {v.kind === 'addendum' && <Select className="full" label="العقد الأصلي" required options={(parents.data ?? []).filter((k) => k.id !== initial?.id).map((k) => ({ value: k.id, label: k.title }))} {...f.bind('parentContractId')} onChange={(x) => f.set('parentContractId', x)} />}
        <TextInput label="عنوان العقد" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <TextInput label="رقم العقد" ltr {...f.bind('contractNo')} onChange={(x) => f.set('contractNo', x)} />
        <DateInput label="تاريخ التوقيع" {...f.bind('signedOn')} onChange={(x) => f.set('signedOn', x)} />
        <Select label="الحالة" options={optsFrom(CONTRACT_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <DateInput label="بداية المدة" {...f.bind('startDate')} onChange={(x) => f.set('startDate', x)} />
        <DateInput label="نهاية المدة" {...f.bind('endDate')} onChange={(x) => f.set('endDate', x)} />
        <TextArea className="full" label="نطاق العقد" required {...f.bind('scope')} onChange={(x) => f.set('scope', x)} rows={3} hint="حدد بوضوح الأعمال والقضايا المشمولة" />
        <Select label="نوع الأتعاب" options={optsFrom(FEE_TYPES)} {...f.bind('feeType')} onChange={(x) => f.set('feeType', x as never)} placeholder="—" />
        {fixed ? <AmountInput label="الأتعاب الثابتة (إجمالي العقد)" required value={v.fixedAmount} onChange={(x) => f.set('fixedAmount', x)} error={f.errors.fixedAmount} /> : <div />}
        {pct && (
          <>
            <TextInput label="النسبة %" ltr {...f.bind('percentage')} onChange={(x) => f.set('percentage', x)} />
            <TextInput label="أساس الاحتساب" required {...f.bind('percentageBasis')} onChange={(x) => f.set('percentageBasis', x)} placeholder="مثال: من المبلغ المحكوم به والمحصل فعليًا" />
            <div className="full">
              <Alert tone="info">الأتعاب النسبية تُسجل كما يكتبها المحامي ولا تتحول آليًا إلى مستحق ثابت ولا يُضمن تحصيلها.</Alert>
            </div>
          </>
        )}
        <CaseChecklist clientId={v.clientId} value={v.caseIds} onChange={(x) => f.set('caseIds', x)} error={f.errors.caseIds} />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function FeeItemForm({ contractId, initial, onClose }: { contractId: string; initial?: { id: string; title: string; amount: number; dueDate: string | null; notes: string | null }; onClose: () => void }) {
  const f = useForm({ title: initial?.title ?? '', amount: amountToInput(initial?.amount), dueDate: initial?.dueDate ?? '', notes: initial?.notes ?? '' });
  return (
    <FormModal
      title={initial ? 'تعديل بند مالي' : 'إضافة بند مالي (دفعة مجدولة)'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = amountField(f, 'amount', true);
        if (amt === 'invalid' || amt === null) return;
        const r = await save(f, () => api('feeItems.save', { id: initial?.id ?? null, contractId, title: f.values.title, amount: amt, dueDate: f.values.dueDate || null, notes: f.values.notes || null }), 'حُفظ البند');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput label="اسم البند" required {...f.bind('title')} onChange={(x) => f.set('title', x)} placeholder="مثال: الدفعة الأولى عند التوقيع" />
        <AmountInput label="المبلغ" required value={f.values.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
        <DateInput label="تاريخ الاستحقاق" {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function PaymentForm({ clientId, contractId, onClose, onSaved }: { clientId?: string; contractId?: string; onClose: () => void; onSaved?: (id: string, clientId: string) => void }) {
  const { lookup } = useSession();
  const clients = useClientOptions();
  const f = useForm({ clientId: clientId ?? '', contractId: contractId ?? '', feeItemId: '', amount: '', paidOn: todayRiyadh(), method: '', referenceNo: '', notes: '' });
  const v = f.values;
  const contracts = useApi(() => (v.clientId ? api('contracts.list', { clientId: v.clientId }) : Promise.resolve([])), [v.clientId]);
  const detail = useApi(() => (v.contractId ? api('contracts.get', { id: v.contractId }) : Promise.resolve(null)), [v.contractId]);
  return (
    <FormModal
      title="تسجيل دفعة"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = amountField(f, 'amount', true);
        if (amt === 'invalid' || amt === null) return;
        const r = await save(f, () => api('payments.create', { contractId: v.contractId, feeItemId: v.feeItemId || null, amount: amt, paidOn: v.paidOn, method: v.method || null, referenceNo: v.referenceNo || null, notes: v.notes || null }), 'سُجلت الدفعة');
        if (r) {
          onSaved?.(r.id, v.clientId);
          onClose();
        }
      }}
    >
      <div className="form-grid">
        <Select label="العميل" required options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} {...f.bind('clientId')} onChange={(x) => f.setMany({ clientId: x, contractId: '', feeItemId: '' })} disabled={!!clientId} />
        <Select label="العقد" required options={(contracts.data ?? []).filter((k) => k.feeType !== 'none').map((k) => ({ value: k.id, label: k.title }))} {...f.bind('contractId')} onChange={(x) => f.setMany({ contractId: x, feeItemId: '' })} />
        {detail.data?.contract.totals && (
          <div className="full help">
            المتفق عليه <Ltr>{fmtAmount(detail.data.contract.totals.agreed)}</Ltr> — المدفوع <Ltr>{fmtAmount(detail.data.contract.totals.paid)}</Ltr> — المتبقي <Ltr>{fmtAmount(detail.data.contract.totals.remaining)}</Ltr>
            {detail.data.contract.sharedAcrossCases && ' (عقد شامل لعدة قضايا — الدفعة تُسجل على العقد مرة واحدة)'}
          </div>
        )}
        {(detail.data?.feeItems ?? []).length > 0 && (
          <Select className="full" label="البند المالي" options={detail.data!.feeItems.map((i) => ({ value: i.id, label: `${i.title} — ${fmtAmount(i.amount)}` }))} {...f.bind('feeItemId')} onChange={(x) => f.set('feeItemId', x)} placeholder="على العقد عمومًا" />
        )}
        <AmountInput label="المبلغ" required value={v.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
        <DateInput label="تاريخ الدفعة" required {...f.bind('paidOn')} onChange={(x) => f.set('paidOn', x)} />
        <Select label="طريقة الدفع" options={optsFromList(lookup('payment_methods'))} {...f.bind('method')} onChange={(x) => f.set('method', x)} />
        <TextInput label="رقم السند / المرجع" ltr {...f.bind('referenceNo')} onChange={(x) => f.set('referenceNo', x)} />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
        <div className="full help">يمكنك إرفاق سند الدفع بعد الحفظ من قائمة الدفعات.</div>
      </div>
    </FormModal>
  );
}

export function ExpenseForm({ clientId, caseId, initial, onClose }: { clientId?: string; caseId?: string; initial?: MethodOutput<'expenses.list'>[number]; onClose: () => void }) {
  const clients = useClientOptions();
  const f = useForm({ clientId: initial?.clientId ?? clientId ?? '', caseId: initial?.caseId ?? caseId ?? '', title: initial?.title ?? '', amount: amountToInput(initial?.amount), spentOn: initial?.spentOn ?? todayRiyadh(), recoverable: initial?.recoverable ?? true, reimbursedOn: initial?.reimbursedOn ?? '', notes: initial?.notes ?? '' });
  const v = f.values;
  const cases = useCaseOptions(v.clientId || null);
  return (
    <FormModal
      title={initial ? 'تعديل مصروف' : 'تسجيل مصروف'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const amt = amountField(f, 'amount', true);
        if (amt === 'invalid' || amt === null) return;
        const r = await save(f, () => api('expenses.save', { id: initial?.id ?? null, clientId: v.clientId, caseId: v.caseId || null, contractId: null, title: v.title, amount: amt, spentOn: v.spentOn, recoverable: v.recoverable, reimbursedOn: v.reimbursedOn || null, notes: v.notes || null }), 'حُفظ المصروف');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="العميل" required options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} {...f.bind('clientId')} onChange={(x) => f.setMany({ clientId: x, caseId: '' })} disabled={!!clientId || !!initial} />
        <Select label="القضية" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.set('caseId', x)} placeholder="عام للعميل" />
        <TextInput label="بيان المصروف" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <AmountInput label="المبلغ" required value={v.amount} onChange={(x) => f.set('amount', x)} error={f.errors.amount} />
        <DateInput label="التاريخ" required {...f.bind('spentOn')} onChange={(x) => f.set('spentOn', x)} />
        <DateInput label="تاريخ سداد العميل له" {...f.bind('reimbursedOn')} onChange={(x) => f.set('reimbursedOn', x)} />
        <div className="full">
          <Checkbox label="يُسترد من العميل" checked={v.recoverable} onChange={(x) => f.set('recoverable', x)} />
        </div>
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

type Poa = MethodOutput<'poas.list'>[number];
export function PoaForm({ clientId, initial, caseId, onClose }: { clientId: string; initial?: Poa; caseId?: string; onClose: () => void }) {
  const f = useForm({ poaNo: initial?.poaNo ?? '', issuer: initial?.issuer ?? '', issuedOn: initial?.issuedOn ?? '', expiresOn: initial?.expiresOn ?? '', hijriText: initial?.hijriText ?? '', scope: initial?.scope ?? '', agents: initial?.agents ?? '', status: initial?.status ?? 'active', notes: initial?.notes ?? '', caseIds: initial?.cases.map((c) => c.id) ?? (caseId ? [caseId] : []) });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل الوكالة' : 'تسجيل وكالة'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const body = { clientId, poaNo: v.poaNo || null, issuer: v.issuer || null, issuedOn: v.issuedOn || null, expiresOn: v.expiresOn || null, hijriText: v.hijriText || null, scope: v.scope, agents: v.agents || null, status: v.status as never, notes: v.notes || null, caseIds: v.caseIds };
        const r = initial ? await save(f, () => api('poas.update', { ...body, id: initial.id }), 'حُفظت الوكالة') : await save(f, () => api('poas.create', body), 'سُجلت الوكالة');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput label="رقم الوكالة" ltr {...f.bind('poaNo')} onChange={(x) => f.set('poaNo', x)} />
        <TextInput label="جهة الإصدار" {...f.bind('issuer')} onChange={(x) => f.set('issuer', x)} />
        <DateInput label="تاريخ الإصدار" {...f.bind('issuedOn')} onChange={(x) => f.set('issuedOn', x)} />
        <DateInput label="تاريخ الانتهاء" {...f.bind('expiresOn')} onChange={(x) => f.set('expiresOn', x)} />
        <TextInput label="التاريخ الهجري كما ورد" {...f.bind('hijriText')} onChange={(x) => f.set('hijriText', x)} />
        <Select label="الحالة" options={optsFrom(POA_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TextArea className="full" label="نطاق الوكالة (كما ورد فيها)" required {...f.bind('scope')} onChange={(x) => f.set('scope', x)} rows={3} />
        <TextInput className="full" label="الوكلاء" {...f.bind('agents')} onChange={(x) => f.set('agents', x)} />
        <CaseChecklist clientId={clientId} value={v.caseIds} onChange={(x) => f.set('caseIds', x)} error={f.errors.caseIds} />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

type Task = MethodOutput<'tasks.list'>[number];
export function TaskForm({ initial, defaults = {}, onClose }: { initial?: Task; defaults?: { clientId?: string; caseId?: string; hearingId?: string; stageId?: string }; onClose: () => void }) {
  const { users, isOwner, state } = useSession();
  const clients = useClientOptions();
  const f = useForm({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    clientId: initial?.clientId ?? defaults.clientId ?? '',
    caseId: initial?.caseId ?? defaults.caseId ?? '',
    stageId: initial?.stageId ?? defaults.stageId ?? '',
    hearingId: initial?.hearingId ?? defaults.hearingId ?? '',
    assigneeUserId: initial?.assigneeUserId ?? state?.user?.id ?? '',
    dueDate: initial?.dueDate ?? '',
    dueTime: initial?.dueTime ?? '',
    priority: initial?.priority ?? 'normal',
    status: initial?.status ?? 'pending',
  });
  const v = f.values;
  const cases = useCaseOptions(v.clientId || null);
  const links = useCaseLinks(v.caseId || null);
  const userOpts = useUsersOptions(isOwner ? users : users.filter((u) => u.id === state?.user?.id || u.role === 'owner'));
  return (
    <FormModal
      title={initial ? 'تعديل المهمة' : 'إضافة مهمة'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const body = { title: v.title, description: v.description || null, clientId: v.clientId || null, caseId: v.caseId || null, stageId: v.stageId || null, hearingId: v.hearingId || null, assigneeUserId: v.assigneeUserId || null, dueDate: v.dueDate || null, dueTime: v.dueTime || null, priority: v.priority as never, status: v.status as never };
        const r = initial ? await save(f, () => api('tasks.update', { ...body, id: initial.id }), 'حُفظت المهمة') : await save(f, () => api('tasks.create', body), 'أُضيفت المهمة');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="العنوان" required {...f.bind('title')} onChange={(x) => f.set('title', x)} autoFocus />
        <Select label="العميل" options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} {...f.bind('clientId')} onChange={(x) => f.setMany({ clientId: x, caseId: '', stageId: '', hearingId: '' })} placeholder={isOwner ? 'مهمة عامة للمكتب' : '— اختر —'} disabled={!!defaults.caseId} />
        <Select label="القضية" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.setMany({ caseId: x, stageId: '', hearingId: '' })} placeholder="غير مرتبطة بقضية" disabled={!!defaults.caseId} />
        {v.caseId && links.data && (
          <>
            <Select label="المرحلة" options={links.data.c.stages.map((s) => ({ value: s.id, label: s.stageType }))} {...f.bind('stageId')} onChange={(x) => f.set('stageId', x)} placeholder="غير محددة" />
            <Select label="الجلسة" options={links.data.hearings.map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('hearingId')} onChange={(x) => f.set('hearingId', x)} placeholder="غير مرتبطة" />
          </>
        )}
        <Select label="المسؤول" options={userOpts} {...f.bind('assigneeUserId')} onChange={(x) => f.set('assigneeUserId', x)} />
        <Select label="الأولوية" options={optsFrom(PRIORITIES)} {...f.bind('priority')} onChange={(x) => f.set('priority', x as never)} placeholder="—" />
        <DateInput label="موعد الاستحقاق" {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
        <TextInput label="الوقت (اختياري)" type="time" ltr {...f.bind('dueTime')} onChange={(x) => f.set('dueTime', x)} />
        <Select label="الحالة" options={optsFrom(TASK_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TextArea className="full" label="الوصف" {...f.bind('description')} onChange={(x) => f.set('description', x)} rows={3} />
      </div>
    </FormModal>
  );
}

export function NoteForm({ clientId, caseId, initial, onClose }: { clientId: string; caseId?: string | null; initial?: { id: string; body: string; isInternal: boolean; caseId: string | null }; onClose: () => void }) {
  const cases = useCaseOptions(clientId);
  const f = useForm({ body: initial?.body ?? '', isInternal: initial?.isInternal ?? true, caseId: initial?.caseId ?? caseId ?? '' });
  return (
    <FormModal
      title={initial ? 'تعديل ملاحظة' : 'إضافة ملاحظة'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('notes.save', { id: initial?.id ?? null, clientId, caseId: f.values.caseId || null, body: f.values.body, isInternal: f.values.isInternal }), 'حُفظت الملاحظة');
        if (r) onClose();
      }}
    >
      <div className="stack g2">
        {!caseId && <Select label="القضية" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.set('caseId', x)} placeholder="ملاحظة عامة على العميل" />}
        <TextArea label="الملاحظة" required {...f.bind('body')} onChange={(x) => f.set('body', x)} rows={5} />
        <Checkbox label="ملاحظة داخلية (تُستبعد من تقارير العميل)" checked={f.values.isInternal} onChange={(x) => f.set('isInternal', x)} />
      </div>
    </FormModal>
  );
}

export function CommForm({ clientId, caseId, onClose }: { clientId: string; caseId?: string | null; onClose: () => void }) {
  const cases = useCaseOptions(clientId);
  const f = useForm({ occurredOn: todayRiyadh(), channel: 'call', contactPerson: '', summary: '', caseId: caseId ?? '' });
  return (
    <FormModal
      title="تسجيل تواصل مع العميل"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const v = f.values;
        const r = await save(f, () => api('comms.save', { id: null, clientId, caseId: v.caseId || null, occurredOn: v.occurredOn, channel: v.channel as never, contactPerson: v.contactPerson || null, summary: v.summary }), 'حُفظ سجل التواصل');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <DateInput label="التاريخ" required {...f.bind('occurredOn')} onChange={(x) => f.set('occurredOn', x)} />
        <Select label="الوسيلة" options={optsFrom(COMM_CHANNELS)} {...f.bind('channel')} onChange={(x) => f.set('channel', x)} placeholder="—" />
        <TextInput label="الشخص" {...f.bind('contactPerson')} onChange={(x) => f.set('contactPerson', x)} />
        <Select label="القضية" options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} {...f.bind('caseId')} onChange={(x) => f.set('caseId', x)} placeholder="عام" />
        <TextArea className="full" label="الملخص" required {...f.bind('summary')} onChange={(x) => f.set('summary', x)} rows={4} />
      </div>
    </FormModal>
  );
}
