import { Alert, Checkbox, DateInput, Loading, Select, TextArea, TextInput, TimeInput, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { useSession } from '../lib/session';
import {
  DEADLINE_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_RELIABILITY,
  HEARING_STATUSES,
  JUDGMENT_FOLLOW,
  MEMO_TYPES,
  PRIORITIES,
  RELATED_WORK_KINDS,
  RELATED_WORK_STATUSES,
} from '../../shared/constants';
import { fmtDate, fmtDateTime, todayRiyadh } from '../../shared/dates';
import { fmtAmount } from '../../shared/money';
import { FormModal, optsFrom, save, useCaseLinks, useUsersOptions } from './common';
import type { MethodOutput } from '../../main/ipc/registry';

type Hearing = MethodOutput<'hearings.list'>[number];
type Stage = MethodOutput<'cases.get'>['stages'][number];

export function HearingForm({ caseId, stages, hearings, initial, defaultStageId, previousHearingId, onClose, onSaved }: { caseId: string; stages: Stage[]; hearings?: Hearing[]; initial?: Hearing; defaultStageId?: string; previousHearingId?: string; onClose: () => void; onSaved?: (id: string) => void }) {
  const { state } = useSession();
  const ongoing = stages.find((s) => s.status === 'ongoing') ?? stages[stages.length - 1];
  const f = useForm({
    stageId: initial?.stageId ?? defaultStageId ?? ongoing?.id ?? '',
    date: initial?.date ?? '',
    time: initial?.time ?? '09:00',
    status: initial?.status ?? 'scheduled',
    confirmed: initial?.confirmed ?? true,
    location: initial?.location ?? '',
    attendanceLink: initial?.attendanceLink ?? '',
    attendee: initial?.attendee ?? state?.user?.displayName ?? '',
    hijriText: initial?.hijriText ?? '',
    hijriSource: initial?.hijriSource ?? '',
    summary: initial?.summary ?? '',
    outcome: initial?.outcome ?? '',
    officeCommitments: initial?.officeCommitments ?? '',
    nextHearingId: initial?.nextHearingId ?? '',
    previousHearingId: previousHearingId ?? '',
    r24: initial?.reminderOffsets ? initial.reminderOffsets.includes(1440) : true,
    r30: initial?.reminderOffsets ? initial.reminderOffsets.includes(30) : true,
    changeReason: '',
  });
  const v = f.values;
  const moved = initial && (initial.date !== v.date || initial.time !== v.time);
  if (!stages.length) {
    return (
      <FormModal title="إضافة جلسة" onClose={onClose} onSubmit={async () => onClose()} submitLabel="حسنًا">
        <Alert tone="warning">سجّل مرحلة التقاضي أولًا (مثل الدرجة الأولى)، ثم أضف جلساتها تحتها.</Alert>
      </FormModal>
    );
  }
  return (
    <FormModal
      title={initial ? 'تعديل الجلسة' : 'إضافة جلسة'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const offsets = [...(v.r24 ? [1440] : []), ...(v.r30 ? [30] : [])];
        const body = {
          stageId: v.stageId,
          date: v.date,
          time: v.time,
          status: v.status as never,
          confirmed: v.confirmed,
          location: v.location || null,
          attendanceLink: v.attendanceLink || null,
          attendee: v.attendee || null,
          hijriText: v.hijriText || null,
          hijriSource: v.hijriSource || null,
          summary: v.summary || null,
          outcome: v.outcome || null,
          officeCommitments: v.officeCommitments || null,
          nextHearingId: v.nextHearingId || null,
          reminderOffsets: offsets,
        };
        const r = initial
          ? await save(f, () => api('hearings.update', { ...body, id: initial.id, changeReason: v.changeReason || null }), 'حُفظت الجلسة')
          : await save(f, () => api('hearings.create', { ...body, caseId, previousHearingId: v.previousHearingId || null }), 'أُضيفت الجلسة');
        if (r) {
          onSaved?.(initial?.id ?? (r as { id: string }).id);
          onClose();
        }
      }}
    >
      <div className="form-grid">
        <Select label="المرحلة" required options={stages.map((s) => ({ value: s.id, label: `${s.stageType}${s.officialCaseNo ? ' — ' + s.officialCaseNo : ''}` }))} {...f.bind('stageId')} onChange={(x) => f.set('stageId', x)} />
        <Select label="حالة الجلسة" options={optsFrom(HEARING_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" hint="الحالة تختلف عن النتيجة؛ سجّل النتيجة في حقلها" />
        <DateInput label="التاريخ" required {...f.bind('date')} onChange={(x) => f.set('date', x)} hint="بتوقيت الرياض" />
        <TimeInput label="الوقت" required {...f.bind('time')} onChange={(x) => f.set('time', x)} />
        <div className="full">
          <Checkbox label="موعد مؤكد" checked={v.confirmed} onChange={(x) => f.set('confirmed', x)} hint="الموعد غير المؤكد يظهر مميزًا ولا تُضبط له تنبيهات" />
        </div>
        {moved && <TextInput className="full" label="سبب تعديل الموعد" {...f.bind('changeReason')} onChange={(x) => f.set('changeReason', x)} hint={`الموعد السابق: ${fmtDateTime(initial!.startsAt)} — سيُحفظ أثر التعديل`} />}
        <TextInput label="المكان" {...f.bind('location')} onChange={(x) => f.set('location', x)} />
        <TextInput label="رابط الحضور (إن وجد)" ltr {...f.bind('attendanceLink')} onChange={(x) => f.set('attendanceLink', x)} hint="يُحفظ نصًا فقط ولا يفتحه البرنامج تلقائيًا" />
        <TextInput label="الحاضر عن المكتب" {...f.bind('attendee')} onChange={(x) => f.set('attendee', x)} />
        <div className="row wrap" style={{ paddingTop: 26 }}>
          <span className="label">التنبيهات:</span>
          <Checkbox label="قبل 24 ساعة" checked={v.r24} onChange={(x) => f.set('r24', x)} />
          <Checkbox label="قبل 30 دقيقة" checked={v.r30} onChange={(x) => f.set('r30', x)} />
        </div>
        <TextInput label="التاريخ الهجري كما ورد في المستند" {...f.bind('hijriText')} onChange={(x) => f.set('hijriText', x)} hint="نص مستقل — لا تحويل آلي" />
        <TextInput label="مصدر التاريخ الهجري" {...f.bind('hijriSource')} onChange={(x) => f.set('hijriSource', x)} />
        {!initial && hearings && hearings.length > 0 && (
          <Select className="full" label="الجلسة السابقة (عند التأجيل)" options={hearings.map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('previousHearingId')} onChange={(x) => f.set('previousHearingId', x)} placeholder="لا يوجد" />
        )}
        <TextArea className="full" label="ملخص ما جرى في الجلسة" {...f.bind('summary')} onChange={(x) => f.set('summary', x)} rows={4} />
        <TextInput className="full" label="النتيجة" {...f.bind('outcome')} onChange={(x) => f.set('outcome', x)} />
        <TextArea className="full" label="ما التزم به المكتب" {...f.bind('officeCommitments')} onChange={(x) => f.set('officeCommitments', x)} rows={2} />
        {initial && hearings && (
          <Select className="full" label="الجلسة اللاحقة المسجلة" options={hearings.filter((h) => h.id !== initial.id).map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('nextHearingId')} onChange={(x) => f.set('nextHearingId', x)} placeholder="لم تُسجل" />
        )}
      </div>
    </FormModal>
  );
}

type Judgment = MethodOutput<'judgments.list'>[number];
export function JudgmentForm({ caseId, stages, hearings, initial, onClose }: { caseId: string; stages: Stage[]; hearings: Hearing[]; initial?: Judgment; onClose: () => void }) {
  const f = useForm({
    stageId: initial?.stageId ?? (stages.find((s) => s.status === 'ongoing') ?? stages[stages.length - 1])?.id ?? '',
    hearingId: initial?.hearingId ?? '',
    judgmentNo: initial?.judgmentNo ?? '',
    judgmentDate: initial?.judgmentDate ?? '',
    hijriText: initial?.hijriText ?? '',
    hijriSource: initial?.hijriSource ?? '',
    summary: initial?.summary ?? '',
    followStatus: initial?.followStatus ?? 'recorded',
    notes: initial?.notes ?? '',
  });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل الحكم' : 'إضافة حكم أو قرار'}
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const body = { stageId: v.stageId, hearingId: v.hearingId || null, judgmentNo: v.judgmentNo || null, judgmentDate: v.judgmentDate || null, hijriText: v.hijriText || null, hijriSource: v.hijriSource || null, summary: v.summary, followStatus: v.followStatus as never, notes: v.notes || null };
        const r = initial ? await save(f, () => api('judgments.update', { ...body, id: initial.id }), 'حُفظ الحكم') : await save(f, () => api('judgments.create', { ...body, caseId }), 'سُجل الحكم');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="المرحلة" required options={stages.map((s) => ({ value: s.id, label: s.stageType }))} {...f.bind('stageId')} onChange={(x) => f.set('stageId', x)} />
        <Select label="الجلسة التي صدر فيها" options={hearings.filter((h) => h.stageId === v.stageId).map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('hearingId')} onChange={(x) => f.set('hearingId', x)} placeholder="غير محدد" />
        <TextInput label="رقم الحكم / الصك" ltr {...f.bind('judgmentNo')} onChange={(x) => f.set('judgmentNo', x)} />
        <DateInput label="تاريخ الحكم" {...f.bind('judgmentDate')} onChange={(x) => f.set('judgmentDate', x)} />
        <TextInput label="التاريخ الهجري كما ورد" {...f.bind('hijriText')} onChange={(x) => f.set('hijriText', x)} />
        <TextInput label="مصدره" {...f.bind('hijriSource')} onChange={(x) => f.set('hijriSource', x)} />
        <TextArea className="full" label="خلاصة المنطوق (يكتبها المستخدم)" required {...f.bind('summary')} onChange={(x) => f.set('summary', x)} rows={4} />
        <Select label="حالة المتابعة" options={optsFrom(JUDGMENT_FOLLOW)} {...f.bind('followStatus')} onChange={(x) => f.set('followStatus', x as never)} placeholder="—" hint="لا يُعتبر الحكم نهائيًا تلقائيًا" />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
        <div className="full">
          <Alert tone="info">لا يحسب البرنامج مواعيد الاعتراض. سجّل الموعد الإجرائي يدويًا مع مصدره من «إضافة موعد إجرائي».</Alert>
        </div>
      </div>
    </FormModal>
  );
}

type Deadline = MethodOutput<'deadlines.list'>[number];
export function DeadlineForm({ caseId, judgments, initial, judgmentId, onClose }: { caseId: string; judgments: Judgment[]; initial?: Deadline; judgmentId?: string; onClose: () => void }) {
  const f = useForm({ title: initial?.title ?? '', dueDate: initial?.dueDate ?? '', source: initial?.source ?? '', status: initial?.status ?? 'open', judgmentId: initial?.judgmentId ?? judgmentId ?? '', notes: initial?.notes ?? '' });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل موعد إجرائي' : 'إضافة موعد إجرائي'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('deadlines.save', { id: initial?.id ?? null, caseId, judgmentId: v.judgmentId || null, stageId: null, title: v.title, dueDate: v.dueDate, source: v.source, status: v.status as never, notes: v.notes || null }), 'حُفظ الموعد');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="الإجراء" required {...f.bind('title')} onChange={(x) => f.set('title', x)} placeholder="مثال: تقديم لائحة الاعتراض" />
        <DateInput label="الموعد" required {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
        <Select label="الحالة" options={optsFrom(DEADLINE_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TextInput className="full" label="مصدر الموعد" required {...f.bind('source')} onChange={(x) => f.set('source', x)} hint="مثال: كما ورد في صك الحكم المرفق، أو في إشعار المحكمة" />
        <Select className="full" label="الحكم المرتبط" options={judgments.map((j) => ({ value: j.id, label: `${j.judgmentNo ?? 'حكم'} — ${fmtDate(j.judgmentDate)}` }))} {...f.bind('judgmentId')} onChange={(x) => f.set('judgmentId', x)} placeholder="غير مرتبط" />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function HearingRequestForm({ hearingId, initial, onClose }: { hearingId: string; initial?: { id: string; text: string; requestedBy: string | null; dueDate: string | null }; onClose: () => void }) {
  const f = useForm({ text: initial?.text ?? '', requestedBy: initial?.requestedBy ?? '', dueDate: initial?.dueDate ?? '' });
  return (
    <FormModal
      title={initial ? 'تعديل طلب ورد في الجلسة' : 'تسجيل طلب ورد في الجلسة'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('hearings.saveRequest', { id: initial?.id ?? null, hearingId, text: f.values.text, requestedBy: f.values.requestedBy || null, dueDate: f.values.dueDate || null }), 'حُفظ الطلب');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextArea className="full" label="نص الطلب" required {...f.bind('text')} onChange={(x) => f.set('text', x)} rows={3} />
        <TextInput label="صاحب الطلب" {...f.bind('requestedBy')} onChange={(x) => f.set('requestedBy', x)} placeholder="المحكمة / الخصم / المكتب" />
        <DateInput label="المهلة المحددة (إن وجدت)" {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
      </div>
    </FormModal>
  );
}

export function RequestToTaskForm({ request, onClose }: { request: { id: string; text: string; dueDate: string | null }; onClose: () => void }) {
  const { users } = useSession();
  const f = useForm({ title: request.text.slice(0, 120), assigneeUserId: '', dueDate: request.dueDate ?? '', priority: 'normal' });
  return (
    <FormModal
      title="تحويل الطلب إلى مهمة"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="إنشاء المهمة"
      onSubmit={async () => {
        const r = await save(f, () => api('hearings.requestToTask', { requestId: request.id, title: f.values.title, assigneeUserId: f.values.assigneeUserId || null, dueDate: f.values.dueDate || null, priority: f.values.priority as never }), 'أُنشئت المهمة وبقي رابطها بالجلسة');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="عنوان المهمة" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <Select label="المسؤول" options={useUsersOptions(users)} {...f.bind('assigneeUserId')} onChange={(x) => f.set('assigneeUserId', x)} />
        <DateInput label="موعد الاستحقاق" {...f.bind('dueDate')} onChange={(x) => f.set('dueDate', x)} />
        <Select label="الأولوية" options={optsFrom(PRIORITIES)} {...f.bind('priority')} onChange={(x) => f.set('priority', x)} placeholder="—" />
      </div>
    </FormModal>
  );
}

export function MemoCreateForm({ caseId, stages, hearings, onClose, onCreated }: { caseId: string; stages: Stage[]; hearings: Hearing[]; onClose: () => void; onCreated: (id: string) => void }) {
  const f = useForm({ title: '', memoType: 'memo', stageId: (stages.find((s) => s.status === 'ongoing') ?? stages[stages.length - 1])?.id ?? '', hearingId: '' });
  const v = f.values;
  return (
    <FormModal
      title="مذكرة جديدة"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="إنشاء وفتح المحرر"
      onSubmit={async () => {
        const r = await save(f, () => api('memos.create', { caseId, title: v.title, memoType: v.memoType as never, stageId: v.stageId || null, hearingId: v.hearingId || null, body: '' }), 'أُنشئت المذكرة كمسودة');
        if (r) onCreated(r.id);
      }}
    >
      <div className="form-grid">
        <TextInput className="full" label="عنوان المذكرة" required {...f.bind('title')} onChange={(x) => f.set('title', x)} autoFocus />
        <Select label="النوع" options={optsFrom(MEMO_TYPES)} {...f.bind('memoType')} onChange={(x) => f.set('memoType', x)} placeholder="—" />
        <Select label="المرحلة" options={stages.map((s) => ({ value: s.id, label: s.stageType }))} {...f.bind('stageId')} onChange={(x) => f.set('stageId', x)} placeholder="غير محددة" />
        <Select className="full" label="الجلسة المرتبطة" options={hearings.filter((h) => !v.stageId || h.stageId === v.stageId).map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} {...f.bind('hearingId')} onChange={(x) => f.set('hearingId', x)} placeholder="غير مرتبطة" />
        <div className="full help">يمكنك كتابة النص في المحرر المحلي، أو إرفاق نسخة Word/PDF من تبويب المستندات وربطها بالمذكرة.</div>
      </div>
    </FormModal>
  );
}

export function SubmissionForm({ memoId, caseId, onClose }: { memoId: string; caseId: string; onClose: () => void }) {
  const docs = useApi(() => api('documents.list', { caseId }), [caseId]);
  const f = useForm({ submittedOn: todayRiyadh(), authority: '', referenceNo: '', proofDocumentId: '', notes: '' });
  return (
    <FormModal
      title="تسجيل تقديم المذكرة للجهة"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="تسجيل التقديم"
      onSubmit={async () => {
        const v = f.values;
        const r = await save(f, () => api('memos.recordSubmission', { memoId, submittedOn: v.submittedOn, authority: v.authority || null, referenceNo: v.referenceNo || null, proofDocumentId: v.proofDocumentId || null, notes: v.notes || null }), 'سُجّل تقديم المذكرة');
        if (r) onClose();
      }}
    >
      <Alert tone="info">حفظ المذكرة أو اعتمادها داخليًا لا يعني تقديمها. هذا السجل المستقل يثبت تاريخ التقديم الفعلي.</Alert>
      <div className="form-grid" style={{ marginTop: 16 }}>
        <DateInput label="تاريخ التقديم" required {...f.bind('submittedOn')} onChange={(x) => f.set('submittedOn', x)} />
        <TextInput label="الجهة المقدَّم إليها" {...f.bind('authority')} onChange={(x) => f.set('authority', x)} />
        <TextInput label="رقم المرجع / الطلب" ltr {...f.bind('referenceNo')} onChange={(x) => f.set('referenceNo', x)} />
        <Select label="ما يثبت التقديم (مستند مرفق)" options={(docs.data ?? []).map((d) => ({ value: d.id, label: d.title }))} {...f.bind('proofDocumentId')} onChange={(x) => f.set('proofDocumentId', x)} placeholder="لا يوجد" hint="أرفق الإثبات أولًا من تبويب المستندات إن وجد" />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

type Evidence = MethodOutput<'analysis.get'>['evidence'][number];
export function EvidenceForm({ caseId, initial, onClose }: { caseId: string; initial?: Evidence; onClose: () => void }) {
  const docs = useApi(() => api('documents.list', { caseId }), [caseId]);
  const f = useForm({ kind: initial?.kind ?? 'fact', statement: initial?.statement ?? '', factDate: initial?.factDate ?? '', reliability: initial?.reliability ?? 'needs_verification', documentId: initial?.documentId ?? '', locationRef: initial?.locationRef ?? '', notes: initial?.notes ?? '' });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل بند في جدول الأدلة' : 'ربط واقعة أو طلب بدليل'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('evidence.save', { id: initial?.id ?? null, caseId, kind: v.kind as never, statement: v.statement, factDate: v.factDate || null, reliability: v.reliability as never, documentId: v.documentId || null, locationRef: v.locationRef || null, notes: v.notes || null }), 'حُفظ البند');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="النوع" options={optsFrom(EVIDENCE_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as never)} placeholder="—" />
        <DateInput label="تاريخ الواقعة (إن عُرف)" {...f.bind('factDate')} onChange={(x) => f.set('factDate', x)} />
        <TextArea className="full" label="الواقعة أو الطلب" required {...f.bind('statement')} onChange={(x) => f.set('statement', x)} rows={3} />
        <Select label="درجة الثبوت" options={optsFrom(EVIDENCE_RELIABILITY)} {...f.bind('reliability')} onChange={(x) => f.set('reliability', x as never)} placeholder="—" />
        <Select label="المستند المؤيد" options={(docs.data ?? []).map((d) => ({ value: d.id, label: d.title }))} {...f.bind('documentId')} onChange={(x) => f.set('documentId', x)} placeholder="لا يوجد" />
        <TextInput label="الموضع في المستند" {...f.bind('locationRef')} onChange={(x) => f.set('locationRef', x)} placeholder="مثال: ص 3، البند 5" />
        <TextArea className="full" label="ملاحظاتك على الدليل" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export function CloseCaseForm({ caseId, canFees, onClose }: { caseId: string; canFees: boolean; onClose: () => void }) {
  const cl = useApi(() => api('cases.closeChecklist', { id: caseId }), [caseId]);
  const f = useForm({ outcome: '', remainingWork: '', feesNote: '', documentsNote: '', lastClientReportOn: '', confirm: false });
  const v = f.values;
  return (
    <FormModal
      title="إقفال ملف القضية"
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="تأكيد الإقفال"
      onSubmit={async () => {
        if (!v.confirm) {
          f.setErrors({ confirm: 'يجب تأكيد قرار الإقفال' });
          return;
        }
        const r = await save(f, () => api('cases.close', { id: caseId, outcome: v.outcome, remainingWork: v.remainingWork || null, feesNote: v.feesNote || null, documentsNote: v.documentsNote || null, lastClientReportOn: v.lastClientReportOn || null, confirm: true }), 'أُقفل الملف');
        if (r) onClose();
      }}
    >
      {cl.loading && !cl.data ? (
        <Loading />
      ) : (
        cl.data && (
          <div className="stack g2">
            <h3>قائمة التحقق قبل الإقفال</h3>
            <ul className="list-plain">
              <li>
                <strong>الأعمال المتبقية:</strong> {cl.data.openTasks.length} مهمة مفتوحة، {cl.data.upcomingHearings.length} جلسة قادمة، {cl.data.openDeadlines.length} موعد إجرائي قائم
                {cl.data.openTasks.slice(0, 5).map((t) => (
                  <div key={t.id} className="help">• {t.title} {t.due_date && <Ltr>{fmtDate(t.due_date)}</Ltr>}</div>
                ))}
              </li>
              <li>
                <strong>المذكرات غير المقدمة:</strong> {cl.data.draftMemos.length}
              </li>
              <li>
                <strong>المستندات:</strong> {cl.data.docCount} مستند محفوظ{cl.data.pendingReviewDocs ? `، ${cl.data.pendingReviewDocs} يحتاج مراجعة` : ''}
              </li>
              {canFees && cl.data.fees && (
                <li>
                  <strong>المستحقات:</strong> المتبقي على العقود المرتبطة <Ltr>{fmtAmount(cl.data.fees.remaining)}</Ltr>
                  {cl.data.fees.sharedContracts > 0 && <div className="help">بعض العقود شاملة لقضايا أخرى؛ المتبقي يخص العقد كاملًا.</div>}
                </li>
              )}
            </ul>
            <div className="form-grid">
              <TextArea className="full" label="النتيجة المسجلة" required {...f.bind('outcome')} onChange={(x) => f.set('outcome', x)} rows={3} />
              <TextArea className="full" label="ملاحظة على الأعمال المتبقية" {...f.bind('remainingWork')} onChange={(x) => f.set('remainingWork', x)} rows={2} />
              {canFees && <TextInput className="full" label="ملاحظة على المستحقات" {...f.bind('feesNote')} onChange={(x) => f.set('feesNote', x)} />}
              <TextInput className="full" label="ملاحظة على المستندات" {...f.bind('documentsNote')} onChange={(x) => f.set('documentsNote', x)} />
              <DateInput label="تاريخ آخر تقرير للعميل" {...f.bind('lastClientReportOn')} onChange={(x) => f.set('lastClientReportOn', x)} />
              <div className="full">
                <Checkbox label="أؤكد قرار إقفال الملف (يمكن إعادة فتحه لاحقًا بصلاحية مناسبة مع حفظ الأثر)" checked={v.confirm} onChange={(x) => f.set('confirm', x)} />
                {f.errors.confirm && <div className="field"><div className="error">{f.errors.confirm}</div></div>}
              </div>
            </div>
          </div>
        )
      )}
    </FormModal>
  );
}

export function ReasonForm({ title, label, required, submitLabel, onSubmit, onClose }: { title: string; label: string; required?: boolean; submitLabel: string; onSubmit: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const f = useForm({ reason: '' });
  return (
    <FormModal
      title={title}
      size="narrow"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel={submitLabel}
      onSubmit={async () => {
        if (required && !f.values.reason.trim()) {
          f.setErrors({ reason: 'هذا الحقل مطلوب' });
          return;
        }
        const r = await save(f, () => onSubmit(f.values.reason.trim()));
        if (r !== undefined) onClose();
      }}
    >
      <TextArea label={label} required={required} {...f.bind('reason')} onChange={(x) => f.set('reason', x)} rows={3} />
    </FormModal>
  );
}

export function RelatedWorkForm({ caseId, initial, onClose }: { caseId: string; initial?: MethodOutput<'cases.get'>['relatedWorks'][number]; onClose: () => void }) {
  const f = useForm({ kind: initial?.kind ?? 'execution', title: initial?.title ?? '', authority: initial?.authority ?? '', referenceNo: initial?.referenceNo ?? '', openedOn: initial?.openedOn ?? '', status: initial?.status ?? 'ongoing', notes: initial?.notes ?? '' });
  const v = f.values;
  return (
    <FormModal
      title={initial ? 'تعديل عمل مرتبط' : 'تسجيل عمل مرتبط (مثل ملف تنفيذ)'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('relatedWorks.save', { id: initial?.id ?? null, caseId, kind: v.kind as never, title: v.title, authority: v.authority || null, referenceNo: v.referenceNo || null, openedOn: v.openedOn || null, status: v.status as never, notes: v.notes || null }), 'حُفظ العمل المرتبط');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <Select label="النوع" options={optsFrom(RELATED_WORK_KINDS)} {...f.bind('kind')} onChange={(x) => f.set('kind', x as never)} placeholder="—" />
        <TextInput label="العنوان" required {...f.bind('title')} onChange={(x) => f.set('title', x)} />
        <TextInput label="الجهة" {...f.bind('authority')} onChange={(x) => f.set('authority', x)} />
        <TextInput label="رقم الطلب / الملف" ltr {...f.bind('referenceNo')} onChange={(x) => f.set('referenceNo', x)} />
        <DateInput label="تاريخ الفتح" {...f.bind('openedOn')} onChange={(x) => f.set('openedOn', x)} />
        <Select label="الحالة" options={optsFrom(RELATED_WORK_STATUSES)} {...f.bind('status')} onChange={(x) => f.set('status', x as never)} placeholder="—" />
        <TextArea className="full" label="ملاحظات" {...f.bind('notes')} onChange={(x) => f.set('notes', x)} rows={2} />
      </div>
    </FormModal>
  );
}

export { useCaseLinks };
