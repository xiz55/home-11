// مخططات التحقق من المدخلات — تُستخدم في العملية الرئيسية (إلزاميًا) وفي الواجهة (لإظهار الأخطاء بجانب الحقل).
import { z } from 'zod';
import {
  CLIENT_KIND_KEYS,
  CLIENT_STATUS_KEYS,
  COMM_CHANNEL_KEYS,
  CONTRACT_KIND_KEYS,
  CONTRACT_STATUS_KEYS,
  DEADLINE_STATUS_KEYS,
  DOC_CATEGORY_KEYS,
  DOC_STATUS_KEYS,
  EVIDENCE_KIND_KEYS,
  EVIDENCE_RELIABILITY_KEYS,
  FEE_TYPE_KEYS,
  FOLLOW_STATUS_KEYS,
  HEARING_STATUS_KEYS,
  JUDGMENT_FOLLOW_KEYS,
  LOOKUP_LIST_KEYS,
  MEMO_TYPE_KEYS,
  PERMISSION_KEYS,
  POA_STATUS_KEYS,
  PRIORITY_KEYS,
  RELATED_WORK_KIND_KEYS,
  RELATED_WORK_STATUS_KEYS,
  STAGE_STATUS_KEYS,
  TASK_STATUS_KEYS,
  CASE_STATUS_KEYS,
} from './constants';
import { isValidDate, TIME_RE } from './dates';

z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') return { message: 'هذا الحقل مطلوب' };
      return { message: 'قيمة غير صالحة' };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: 'اختر قيمة من القائمة' };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'uuid') return { message: 'معرّف غير صالح' };
      if (issue.validation === 'email') return { message: 'البريد الإلكتروني غير صالح' };
      return { message: 'صيغة غير صالحة' };
    case z.ZodIssueCode.too_small:
      return { message: issue.type === 'string' ? 'هذا الحقل مطلوب' : 'القيمة أصغر من المسموح' };
    case z.ZodIssueCode.too_big:
      return { message: issue.type === 'string' ? 'النص أطول من المسموح' : 'القيمة أكبر من المسموح' };
    default:
      return { message: ctx.defaultError };
  }
});

export const id = z.string().uuid();
export const optId = z
  .string()
  .uuid()
  .nullish()
  .transform((v) => v ?? null);

export const reqText = (label: string, max = 300) =>
  z
    .string({ required_error: `${label} مطلوب`, invalid_type_error: `${label} مطلوب` })
    .transform((v) => v.trim())
    .pipe(z.string().min(1, `${label} مطلوب`).max(max, `${label} أطول من المسموح (${max} حرفًا)`));

export const optText = (max = 4000) =>
  z
    .string()
    .nullish()
    .transform((v) => {
      const t = (v ?? '').trim();
      return t.length ? t : null;
    })
    .pipe(z.string().max(max, `النص أطول من المسموح (${max} حرفًا)`).nullable());

export const longText = (max = 200_000) => optText(max);

export const optDate = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim() || null)
  .refine((v) => v === null || isValidDate(v), 'تاريخ غير صالح');

export const reqDate = (label: string) =>
  z
    .string({ required_error: `${label} مطلوب` })
    .trim()
    .min(1, `${label} مطلوب`)
    .refine((v) => isValidDate(v), 'تاريخ غير صالح');

export const reqTime = (label: string) =>
  z
    .string({ required_error: `${label} مطلوب` })
    .trim()
    .min(1, `${label} مطلوب`)
    .refine((v) => TIME_RE.test(v), 'وقت غير صالح (مثال 09:30)');

export const optTime = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim() || null)
  .refine((v) => v === null || TIME_RE.test(v), 'وقت غير صالح (مثال 09:30)');

export const amount = z.number().int('مبلغ غير صالح').min(0, 'المبلغ لا يكون سالبًا').max(1e13, 'المبلغ كبير جدًا');
export const optAmount = amount.nullish().transform((v) => (v === undefined ? null : v));
export const positiveAmount = z.number().int('مبلغ غير صالح').min(1, 'أدخل مبلغًا أكبر من صفر').max(1e13);

const optEmail = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim() || null)
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'البريد الإلكتروني غير صالح');

const optPhone = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim() || null)
  .refine((v) => v === null || /^[+\d\s\-()٠-٩]{5,25}$/.test(v), 'رقم غير صالح')
  .refine((v) => v === null || v.length <= 25, 'رقم غير صالح');

export const usernameSchema = z
  .string({ required_error: 'اسم المستخدم مطلوب' })
  .trim()
  .min(3, 'اسم المستخدم 3 أحرف على الأقل')
  .max(40, 'اسم المستخدم طويل')
  .regex(/^[\p{L}\p{N}._-]+$/u, 'استخدم حروفًا وأرقامًا دون مسافات');

export const passwordSchema = z
  .string({ required_error: 'كلمة المرور مطلوبة' })
  .min(8, 'كلمة المرور 8 أحرف على الأقل')
  .max(200, 'كلمة المرور طويلة جدًا');

// ———————— المصادقة والمستخدمون ————————
export const setupOwnerInput = z.object({
  officeName: reqText('اسم المكتب', 300),
  displayName: reqText('الاسم', 120),
  username: usernameSchema,
  password: passwordSchema,
});
export const loginInput = z.object({ username: z.string().trim().min(1, 'اسم المستخدم مطلوب').max(60), password: z.string().min(1, 'كلمة المرور مطلوبة').max(200) });
export const unlockInput = z.object({ password: z.string().min(1, 'كلمة المرور مطلوبة').max(200) });
export const recoverInput = z.object({
  username: z.string().trim().min(1, 'اسم المستخدم مطلوب').max(60),
  recoveryCode: z.string().trim().min(10, 'رمز الاستعادة غير صحيح').max(60),
  newPassword: passwordSchema,
});
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة').max(200),
  newPassword: passwordSchema,
});
export const userCreateInput = z.object({
  displayName: reqText('الاسم', 120),
  username: usernameSchema,
  password: passwordSchema,
  permissions: z.array(z.enum(PERMISSION_KEYS)).max(20).default([]),
});
export const userUpdateInput = z.object({
  id,
  displayName: reqText('الاسم', 120),
  active: z.boolean(),
  permissions: z.array(z.enum(PERMISSION_KEYS)).max(20),
});
export const userResetPasswordInput = z.object({ id, newPassword: passwordSchema });
export const userAccessInput = z.object({
  userId: id,
  caseIds: z.array(id).max(5000),
  clientIds: z.array(id).max(5000),
});

// ———————— الإعدادات ————————
export const settingsPatchInput = z
  .object({
    'office.name': reqText('اسم المكتب', 300),
    'office.phone': optText(60),
    'office.email': optText(120),
    'office.address': optText(400),
    'office.license': optText(120),
    'security.idleLockMinutes': z.number().int().min(1, 'دقيقة واحدة على الأقل').max(240, 'الحد الأقصى 240 دقيقة'),
    'reminders.hearingOffsets': z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5),
    'reminders.taskTime': reqTime('وقت تذكير المهام'),
    'reminders.enabled': z.boolean(),
    'backup.reminderDays': z.number().int().min(1).max(90),
    'reports.footer': optText(500),
  })
  .partial();

export const lookupAddInput = z.object({ listKey: z.enum(LOOKUP_LIST_KEYS), label: reqText('القيمة', 120) });
export const lookupUpdateInput = z.object({
  id,
  label: reqText('القيمة', 120).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

// ———————— العملاء ————————
export const clientInput = z.object({
  kind: z.enum(CLIENT_KIND_KEYS),
  name: reqText('الاسم', 250),
  shortName: optText(120),
  phone: optPhone,
  email: optEmail,
  address: optText(500),
  idType: optText(80),
  idNumber: optText(60),
  repName: optText(200),
  repTitle: optText(120),
  repPhone: optPhone,
  repEmail: optEmail,
  relationshipSummary: optText(4000),
  notes: optText(10000),
});
export const clientUpdateInput = clientInput.extend({ id });
export const clientStatusInput = z.object({ id, status: z.enum(CLIENT_STATUS_KEYS) });
export const clientListInput = z
  .object({
    q: optText(200),
    kind: z.enum(CLIENT_KIND_KEYS).nullish(),
    status: z.enum(CLIENT_STATUS_KEYS).nullish(),
  })
  .default({});
export const similarClientsInput = z.object({
  name: optText(250),
  phone: optText(40),
  idNumber: optText(60),
  excludeId: optId,
});

// ———————— القضايا ————————
export const partyInput = z.object({
  id: optId,
  name: reqText('اسم الطرف', 250),
  role: optText(120),
  isOpponent: z.boolean().default(true),
  idNumber: optText(60),
  representative: optText(250),
  notes: optText(2000),
});

export const stageInput = z.object({
  stageType: reqText('اسم المرحلة', 120),
  courtType: optText(120),
  courtName: optText(250),
  circuit: optText(120),
  officialCaseNo: optText(80),
  startedOn: optDate,
  endedOn: optDate,
  status: z.enum(STAGE_STATUS_KEYS).default('ongoing'),
  previousStageId: optId,
  notes: optText(4000),
});

export const caseInput = z.object({
  clientId: id,
  title: reqText('عنوان القضية', 250),
  caseType: optText(120),
  subject: optText(4000),
  requests: optText(10000),
  claimAmount: optAmount,
  openedOn: optDate,
  responsibleUserId: optId,
  followStatus: z.enum(FOLLOW_STATUS_KEYS).default('in_progress'),
  priority: z.enum(PRIORITY_KEYS).default('normal'),
  notes: optText(10000),
  nextAction: optText(500),
  nextActionDue: optDate,
});
export const caseCreateInput = caseInput.extend({
  parties: z.array(partyInput).max(50).default([]),
  firstStage: stageInput.nullish(),
});
export const caseUpdateInput = caseInput.extend({ id });
export const caseListInput = z
  .object({
    q: optText(200),
    clientId: optId,
    status: z.enum(CASE_STATUS_KEYS).nullish(),
    followStatus: z.enum(FOLLOW_STATUS_KEYS).nullish(),
    caseType: optText(120),
    responsibleUserId: optId,
    archived: z.enum(['active', 'archived', 'all']).default('active'),
  })
  .default({});
export const caseCloseInput = z.object({
  id,
  outcome: reqText('النتيجة المسجلة', 4000),
  remainingWork: optText(4000),
  feesNote: optText(2000),
  documentsNote: optText(2000),
  lastClientReportOn: optDate,
  confirm: z.literal(true, { errorMap: () => ({ message: 'يجب تأكيد قرار الإقفال' }) }),
});
export const caseReopenInput = z.object({ id, reason: reqText('سبب إعادة الفتح', 2000) });
export const caseArchiveInput = z.object({ id, archived: z.boolean(), reason: optText(2000) });
export const partySaveInput = partyInput.extend({ caseId: id });

export const stageCreateInput = stageInput.extend({ caseId: id });
export const stageUpdateInput = stageInput.extend({ id });

export const relatedWorkInput = z.object({
  id: optId,
  caseId: id,
  kind: z.enum(RELATED_WORK_KIND_KEYS),
  title: reqText('العنوان', 250),
  authority: optText(250),
  referenceNo: optText(80),
  openedOn: optDate,
  status: z.enum(RELATED_WORK_STATUS_KEYS).default('ongoing'),
  notes: optText(4000),
});

// ———————— الجلسات ————————
export const hearingInput = z.object({
  stageId: id,
  date: reqDate('تاريخ الجلسة'),
  time: reqTime('وقت الجلسة'),
  hijriText: optText(80),
  hijriSource: optText(200),
  location: optText(300),
  attendanceLink: optText(500),
  status: z.enum(HEARING_STATUS_KEYS).default('scheduled'),
  confirmed: z.boolean().default(true),
  attendee: optText(200),
  summary: optText(20000),
  outcome: optText(4000),
  officeCommitments: optText(4000),
  nextHearingId: optId,
  reminderOffsets: z.array(z.number().int().min(5).max(60 * 24 * 14)).max(5).nullish(),
});
export const hearingCreateInput = hearingInput.extend({ caseId: id, previousHearingId: optId });
export const hearingUpdateInput = hearingInput.extend({ id, changeReason: optText(1000) });
export const hearingRequestInput = z.object({
  id: optId,
  hearingId: id,
  text: reqText('نص الطلب', 4000),
  requestedBy: optText(120),
  dueDate: optDate,
});
export const requestToTaskInput = z.object({
  requestId: id,
  title: reqText('عنوان المهمة', 250),
  assigneeUserId: optId,
  dueDate: optDate,
  priority: z.enum(PRIORITY_KEYS).default('normal'),
});

// ———————— الأحكام والمواعيد الإجرائية ————————
export const judgmentInput = z.object({
  stageId: id,
  hearingId: optId,
  judgmentNo: optText(80),
  judgmentDate: optDate,
  hijriText: optText(80),
  hijriSource: optText(200),
  summary: reqText('خلاصة المنطوق', 20000),
  followStatus: z.enum(JUDGMENT_FOLLOW_KEYS).default('recorded'),
  notes: optText(10000),
});
export const judgmentCreateInput = judgmentInput.extend({ caseId: id });
export const judgmentUpdateInput = judgmentInput.extend({ id });
export const deadlineInput = z.object({
  id: optId,
  caseId: id,
  judgmentId: optId,
  stageId: optId,
  title: reqText('عنوان الإجراء', 250),
  dueDate: reqDate('تاريخ الموعد'),
  source: reqText('مصدر الموعد', 500),
  status: z.enum(DEADLINE_STATUS_KEYS).default('open'),
  notes: optText(2000),
});

// ———————— المذكرات ————————
export const memoInput = z.object({
  stageId: optId,
  hearingId: optId,
  title: reqText('عنوان المذكرة', 250),
  memoType: z.enum(MEMO_TYPE_KEYS).default('memo'),
  body: longText(),
});
export const memoCreateInput = memoInput.extend({ caseId: id });
export const memoUpdateInput = memoInput.extend({ id, baseUpdatedAt: z.string().max(40).nullish() });
export const memoStatusInput = z.object({ id, status: z.enum(['draft', 'review', 'approved']) });
export const memoSubmissionInput = z.object({
  memoId: id,
  submittedOn: reqDate('تاريخ التقديم'),
  authority: optText(250),
  referenceNo: optText(120),
  proofDocumentId: optId,
  notes: optText(2000),
});

// ———————— المستندات ————————
export const documentLinks = z.object({
  clientId: id,
  caseId: optId,
  stageId: optId,
  hearingId: optId,
  judgmentId: optId,
  memoId: optId,
  contractId: optId,
  poaId: optId,
  paymentId: optId,
});
export const documentMeta = z.object({
  title: reqText('عنوان المستند', 250),
  description: optText(4000),
  category: z.enum(DOC_CATEGORY_KEYS),
  docDate: optDate,
  hijriText: optText(80),
  hijriSource: optText(200),
  status: z.enum(DOC_STATUS_KEYS).default('final'),
  isInternal: z.boolean().default(false),
});
export const documentCreateInput = documentMeta.merge(documentLinks).extend({
  token: z.string().uuid(),
  allowDuplicate: z.boolean().default(false),
  versionNote: optText(500),
});
export const documentUpdateInput = documentMeta.merge(documentLinks).extend({ id });
export const documentAddVersionInput = z.object({
  documentId: id,
  token: z.string().uuid(),
  note: optText(500),
  allowDuplicate: z.boolean().default(false),
});
export const documentListInput = z
  .object({
    q: optText(200),
    clientId: optId,
    caseId: optId,
    stageId: optId,
    hearingId: optId,
    judgmentId: optId,
    memoId: optId,
    contractId: optId,
    poaId: optId,
    category: z.enum(DOC_CATEGORY_KEYS).nullish(),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    clientLevelOnly: z.boolean().default(false),
  })
  .default({});
export const stageBytesInput = z.object({
  name: z.string().min(1).max(400),
  bytes: z.instanceof(Uint8Array),
});

// ———————— التحليل ————————
export const ANALYSIS_SECTIONS = [
  { key: 'facts', label: 'الوقائع وتسلسلها' },
  { key: 'requests', label: 'الطلبات' },
  { key: 'legal_questions', label: 'الأسئلة القانونية' },
  { key: 'legal_basis', label: 'الأسانيد النظامية ومصادرها' },
  { key: 'defenses', label: 'الدفوع المحتملة' },
  { key: 'strengths', label: 'نقاط القوة' },
  { key: 'weaknesses', label: 'نقاط الضعف' },
  { key: 'contradictions', label: 'التناقضات' },
  { key: 'missing_documents', label: 'المستندات الناقصة' },
  { key: 'risk_assessment', label: 'تقدير المخاطر (يكتبه المحامي)' },
  { key: 'recommendation', label: 'التوصية' },
  { key: 'next_action', label: 'الإجراء التالي' },
] as const;
export type AnalysisSectionKey = (typeof ANALYSIS_SECTIONS)[number]['key'];
export const ANALYSIS_KEYS = ANALYSIS_SECTIONS.map((s) => s.key) as [AnalysisSectionKey, ...AnalysisSectionKey[]];

export const analysisSaveInput = z.object({
  caseId: id,
  key: z.enum(ANALYSIS_KEYS),
  text: z.string().max(200_000, 'النص أطول من المسموح'),
  baseRevision: z.number().int().min(0),
});
export const evidenceInput = z.object({
  id: optId,
  caseId: id,
  kind: z.enum(EVIDENCE_KIND_KEYS),
  statement: reqText('الواقعة أو الطلب', 4000),
  factDate: optDate,
  reliability: z.enum(EVIDENCE_RELIABILITY_KEYS),
  documentId: optId,
  locationRef: optText(200),
  notes: optText(4000),
});

// ———————— المهام ————————
export const taskInput = z.object({
  title: reqText('عنوان المهمة', 250),
  description: optText(10000),
  clientId: optId,
  caseId: optId,
  stageId: optId,
  hearingId: optId,
  assigneeUserId: optId,
  dueDate: optDate,
  dueTime: optTime,
  priority: z.enum(PRIORITY_KEYS).default('normal'),
  status: z.enum(TASK_STATUS_KEYS).default('pending'),
});
export const taskUpdateInput = taskInput.extend({ id });
export const taskStatusInput = z.object({ id, status: z.enum(TASK_STATUS_KEYS) });
export const taskListInput = z
  .object({
    caseId: optId,
    clientId: optId,
    assigneeUserId: optId,
    status: z.enum([...TASK_STATUS_KEYS, 'open', 'overdue', 'all'] as [string, ...string[]]).default('open'),
    q: optText(200),
  })
  .default({});

export const calendarInput = z.object({
  from: reqDate('من'),
  to: reqDate('إلى'),
  clientId: optId,
  caseId: optId,
  responsibleUserId: optId,
  includeUnconfirmed: z.boolean().default(true),
});

// ———————— المالية ————————
export const contractInput = z.object({
  clientId: id,
  kind: z.enum(CONTRACT_KIND_KEYS),
  parentContractId: optId,
  title: reqText('عنوان العقد', 250),
  contractNo: optText(80),
  signedOn: optDate,
  startDate: optDate,
  endDate: optDate,
  scope: reqText('نطاق العقد', 10000),
  feeType: z.enum(FEE_TYPE_KEYS).default('fixed'),
  fixedAmount: optAmount,
  percentage: z.number().min(0).max(100).nullish().transform((v) => v ?? null),
  percentageBasis: optText(2000),
  status: z.enum(CONTRACT_STATUS_KEYS).default('active'),
  notes: optText(10000),
  caseIds: z.array(id).max(500).default([]),
});
export const contractUpdateInput = contractInput.extend({ id });
export const feeItemInput = z.object({
  id: optId,
  contractId: id,
  title: reqText('اسم البند', 250),
  amount: amount,
  dueDate: optDate,
  notes: optText(2000),
});
export const paymentInput = z.object({
  contractId: id,
  feeItemId: optId,
  amount: positiveAmount,
  paidOn: reqDate('تاريخ الدفعة'),
  method: optText(80),
  referenceNo: optText(120),
  notes: optText(2000),
});
export const paymentVoidInput = z.object({ id, reason: reqText('سبب الإلغاء', 1000) });
export const expenseInput = z.object({
  id: optId,
  clientId: id,
  caseId: optId,
  contractId: optId,
  title: reqText('بيان المصروف', 250),
  amount: positiveAmount,
  spentOn: reqDate('تاريخ المصروف'),
  recoverable: z.boolean().default(true),
  reimbursedOn: optDate,
  notes: optText(2000),
});
export const poaInput = z.object({
  clientId: id,
  poaNo: optText(80),
  issuer: optText(250),
  issuedOn: optDate,
  expiresOn: optDate,
  hijriText: optText(80),
  scope: reqText('نطاق الوكالة', 10000),
  agents: optText(1000),
  status: z.enum(POA_STATUS_KEYS).default('active'),
  notes: optText(4000),
  caseIds: z.array(id).max(500).default([]),
});
export const poaUpdateInput = poaInput.extend({ id });

// ———————— الملاحظات وسجل التواصل ————————
export const noteInput = z.object({
  id: optId,
  clientId: id,
  caseId: optId,
  body: reqText('نص الملاحظة', 20000),
  isInternal: z.boolean().default(true),
});
export const commInput = z.object({
  id: optId,
  clientId: id,
  caseId: optId,
  occurredOn: reqDate('التاريخ'),
  channel: z.enum(COMM_CHANNEL_KEYS),
  contactPerson: optText(200),
  summary: reqText('الملخص', 10000),
});

// ———————— التقارير ————————
export const reportInput = z.object({
  type: z.enum(['case', 'client', 'hearings', 'tasks', 'fees']),
  caseId: optId,
  clientId: optId,
  from: optDate,
  to: optDate,
  assigneeUserId: optId,
  options: z
    .object({
      includeInternalNotes: z.boolean().default(false),
      includeAnalysis: z.boolean().default(false),
      includeFees: z.boolean().default(false),
      includeTasks: z.boolean().default(true),
      includeDocuments: z.boolean().default(true),
    })
    .default({}),
});

// ———————— التكامل ————————
export const integrationTokenInput = z.object({
  name: reqText('اسم الربط', 120),
  clientIds: z.array(id).max(2000),
  caseIds: z.array(id).max(5000),
  allowDocumentText: z.boolean().default(false),
  expiresOn: optDate,
});

export type FieldErrors = Record<string, string>;

export function zodFieldErrors(err: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
