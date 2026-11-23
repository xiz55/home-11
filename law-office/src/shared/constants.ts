// ثوابت النطاق المشتركة بين العملية الرئيسية والواجهة.
// كل قائمة مغلقة تحمل تسمية عربية تُعرض بجانب الحالة دائمًا (لا يُعبَّر عن الحالة باللون وحده).

export const APP_NAME_AR = 'إدارة مكتب المحاماة';
export const DEFAULT_OFFICE_NAME =
  'مكتب المحامي محمد إبراهيم الشهراني للمحاماة والتوثيق والاستشارات القانونية';
export const OFFICE_TZ = 'Asia/Riyadh';
export const SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = 'law-office-backup';
export const BACKUP_FORMAT_VERSION = 1;

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

type LabelMap<K extends string> = Record<K, { label: string; tone: Tone }>;

function keys<K extends string>(m: LabelMap<K>): [K, ...K[]] {
  return Object.keys(m) as [K, ...K[]];
}

export const ROLES = {
  owner: { label: 'صاحب المكتب', tone: 'info' },
  consultant: { label: 'مستشار قانوني', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type Role = keyof typeof ROLES;
export const ROLE_KEYS = keys(ROLES);

// صلاحيات إضافية يمنحها صاحب المكتب للمستشار. صاحب المكتب يملكها كلها ضمنيًا.
export const PERMISSIONS = {
  'clients.create': 'إضافة عملاء جدد',
  'cases.create': 'فتح قضايا جديدة للعملاء المتاحين له',
  'cases.close': 'إقفال القضايا وإعادة فتحها',
  'cases.archive': 'أرشفة القضايا وإلغاء أرشفتها',
  'fees.view': 'الاطلاع على الأتعاب والدفعات والمصاريف',
  'fees.manage': 'تسجيل العقود المالية والدفعات والمصاريف',
  'reports.export': 'طباعة التقارير وحفظها PDF',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];
export const DEFAULT_CONSULTANT_PERMISSIONS: Permission[] = ['reports.export'];

export const CLIENT_KINDS = {
  individual: { label: 'فرد', tone: 'neutral' },
  company: { label: 'شركة', tone: 'neutral' },
  establishment: { label: 'منشأة', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type ClientKind = keyof typeof CLIENT_KINDS;
export const CLIENT_KIND_KEYS = keys(CLIENT_KINDS);

export const CLIENT_STATUSES = {
  active: { label: 'نشط', tone: 'success' },
  inactive: { label: 'غير نشط', tone: 'neutral' },
  archived: { label: 'مؤرشف', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type ClientStatus = keyof typeof CLIENT_STATUSES;
export const CLIENT_STATUS_KEYS = keys(CLIENT_STATUSES);

export const CASE_STATUSES = {
  open: { label: 'مفتوحة', tone: 'info' },
  closed: { label: 'مقفلة', tone: 'success' },
} as const satisfies LabelMap<string>;
export type CaseStatus = keyof typeof CASE_STATUSES;
export const CASE_STATUS_KEYS = keys(CASE_STATUSES);

export const FOLLOW_STATUSES = {
  in_progress: { label: 'قيد العمل', tone: 'info' },
  needs_action: { label: 'يحتاج إجراء', tone: 'warning' },
  waiting_other: { label: 'بانتظار طرف آخر', tone: 'neutral' },
  waiting_court: { label: 'بانتظار المحكمة', tone: 'neutral' },
  suspended: { label: 'موقوفة', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type FollowStatus = keyof typeof FOLLOW_STATUSES;
export const FOLLOW_STATUS_KEYS = keys(FOLLOW_STATUSES);

export const PRIORITIES = {
  low: { label: 'منخفضة', tone: 'neutral' },
  normal: { label: 'عادية', tone: 'neutral' },
  high: { label: 'عالية', tone: 'warning' },
  urgent: { label: 'عاجلة', tone: 'danger' },
} as const satisfies LabelMap<string>;
export type Priority = keyof typeof PRIORITIES;
export const PRIORITY_KEYS = keys(PRIORITIES);

export const STAGE_STATUSES = {
  ongoing: { label: 'جارية', tone: 'info' },
  ended: { label: 'منتهية', tone: 'success' },
  suspended: { label: 'موقوفة', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type StageStatus = keyof typeof STAGE_STATUSES;
export const STAGE_STATUS_KEYS = keys(STAGE_STATUSES);

export const HEARING_STATUSES = {
  scheduled: { label: 'مجدولة', tone: 'info' },
  held: { label: 'منعقدة', tone: 'success' },
  postponed: { label: 'مؤجلة', tone: 'warning' },
  cancelled: { label: 'ملغاة', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type HearingStatus = keyof typeof HEARING_STATUSES;
export const HEARING_STATUS_KEYS = keys(HEARING_STATUSES);

export const JUDGMENT_FOLLOW = {
  recorded: { label: 'مسجل — لم يُدرس', tone: 'warning' },
  under_study: { label: 'قيد الدراسة', tone: 'info' },
  objection_preparing: { label: 'جارٍ إعداد الاعتراض', tone: 'warning' },
  objection_submitted: { label: 'قُدّم الاعتراض', tone: 'info' },
  no_objection: { label: 'تقرر عدم الاعتراض', tone: 'neutral' },
  final_by_user: { label: 'قطعي (بحسب ما سجله المستخدم)', tone: 'success' },
  executing: { label: 'قيد التنفيذ', tone: 'info' },
} as const satisfies LabelMap<string>;
export type JudgmentFollow = keyof typeof JUDGMENT_FOLLOW;
export const JUDGMENT_FOLLOW_KEYS = keys(JUDGMENT_FOLLOW);

export const DEADLINE_STATUSES = {
  open: { label: 'قائم', tone: 'warning' },
  done: { label: 'أُنجز', tone: 'success' },
  cancelled: { label: 'ملغى', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type DeadlineStatus = keyof typeof DEADLINE_STATUSES;
export const DEADLINE_STATUS_KEYS = keys(DEADLINE_STATUSES);

export const MEMO_STATUSES = {
  draft: { label: 'مسودة', tone: 'neutral' },
  review: { label: 'قيد المراجعة', tone: 'warning' },
  approved: { label: 'معتمدة داخليًا', tone: 'info' },
  submitted: { label: 'مقدمة للجهة', tone: 'success' },
} as const satisfies LabelMap<string>;
export type MemoStatus = keyof typeof MEMO_STATUSES;
export const MEMO_STATUS_KEYS = keys(MEMO_STATUSES);
// الحالات التي يغيّرها المستخدم مباشرة؛ «مقدمة» لا تُسجل إلا بسجل تقديم مستقل يتضمن التاريخ.
export const MEMO_MANUAL_STATUSES = ['draft', 'review', 'approved'] as const;

export const MEMO_TYPES = {
  memo: { label: 'مذكرة', tone: 'neutral' },
  reply: { label: 'جواب', tone: 'neutral' },
  objection: { label: 'اعتراض', tone: 'neutral' },
  claim: { label: 'صحيفة دعوى', tone: 'neutral' },
  other: { label: 'أخرى', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type MemoType = keyof typeof MEMO_TYPES;
export const MEMO_TYPE_KEYS = keys(MEMO_TYPES);

export const DOC_CATEGORIES = {
  fee_contract: { label: 'عقد أتعاب', tone: 'neutral' },
  poa: { label: 'وكالة', tone: 'neutral' },
  claim: { label: 'صحيفة دعوى', tone: 'neutral' },
  memo: { label: 'مذكرة', tone: 'neutral' },
  reply: { label: 'جواب', tone: 'neutral' },
  objection: { label: 'اعتراض', tone: 'neutral' },
  minutes: { label: 'ضبط جلسة', tone: 'neutral' },
  judgment: { label: 'حكم', tone: 'neutral' },
  evidence: { label: 'دليل', tone: 'neutral' },
  correspondence: { label: 'مراسلة', tone: 'neutral' },
  receipt: { label: 'سند دفع', tone: 'neutral' },
  other: { label: 'أخرى', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type DocCategory = keyof typeof DOC_CATEGORIES;
export const DOC_CATEGORY_KEYS = keys(DOC_CATEGORIES);

export const DOC_STATUSES = {
  final: { label: 'نهائي', tone: 'success' },
  draft: { label: 'مسودة', tone: 'neutral' },
  needs_review: { label: 'يحتاج مراجعة', tone: 'warning' },
} as const satisfies LabelMap<string>;
export type DocStatus = keyof typeof DOC_STATUSES;
export const DOC_STATUS_KEYS = keys(DOC_STATUSES);

export const TASK_STATUSES = {
  pending: { label: 'بانتظار البدء', tone: 'neutral' },
  in_progress: { label: 'قيد العمل', tone: 'info' },
  waiting_other: { label: 'بانتظار طرف آخر', tone: 'warning' },
  done: { label: 'مكتملة', tone: 'success' },
} as const satisfies LabelMap<string>;
export type TaskStatus = keyof typeof TASK_STATUSES;
export const TASK_STATUS_KEYS = keys(TASK_STATUSES);

export const CONTRACT_KINDS = {
  fee: { label: 'عقد أتعاب', tone: 'neutral' },
  general: { label: 'عقد عام', tone: 'neutral' },
  addendum: { label: 'ملحق عقد', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type ContractKind = keyof typeof CONTRACT_KINDS;
export const CONTRACT_KIND_KEYS = keys(CONTRACT_KINDS);

export const FEE_TYPES = {
  none: { label: 'بدون أتعاب مالية', tone: 'neutral' },
  fixed: { label: 'أتعاب ثابتة', tone: 'neutral' },
  percentage: { label: 'أتعاب نسبية', tone: 'neutral' },
  mixed: { label: 'ثابتة ونسبية', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type FeeType = keyof typeof FEE_TYPES;
export const FEE_TYPE_KEYS = keys(FEE_TYPES);

export const CONTRACT_STATUSES = {
  active: { label: 'ساري', tone: 'success' },
  draft: { label: 'مسودة', tone: 'neutral' },
  completed: { label: 'منتهٍ', tone: 'neutral' },
  terminated: { label: 'مفسوخ', tone: 'danger' },
} as const satisfies LabelMap<string>;
export type ContractStatus = keyof typeof CONTRACT_STATUSES;
export const CONTRACT_STATUS_KEYS = keys(CONTRACT_STATUSES);

export const POA_STATUSES = {
  active: { label: 'سارية', tone: 'success' },
  expired: { label: 'منتهية', tone: 'neutral' },
  revoked: { label: 'مفسوخة', tone: 'danger' },
} as const satisfies LabelMap<string>;
export type PoaStatus = keyof typeof POA_STATUSES;
export const POA_STATUS_KEYS = keys(POA_STATUSES);

export const EVIDENCE_RELIABILITY = {
  confirmed: { label: 'مؤكدة بمستند', tone: 'success' },
  client_statement: { label: 'إفادة عميل', tone: 'info' },
  needs_verification: { label: 'تحتاج تحققًا', tone: 'warning' },
} as const satisfies LabelMap<string>;
export type EvidenceReliability = keyof typeof EVIDENCE_RELIABILITY;
export const EVIDENCE_RELIABILITY_KEYS = keys(EVIDENCE_RELIABILITY);

export const EVIDENCE_KINDS = {
  fact: { label: 'واقعة', tone: 'neutral' },
  request: { label: 'طلب', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type EvidenceKind = keyof typeof EVIDENCE_KINDS;
export const EVIDENCE_KIND_KEYS = keys(EVIDENCE_KINDS);

export const COMM_CHANNELS = {
  call: { label: 'اتصال هاتفي', tone: 'neutral' },
  meeting: { label: 'اجتماع', tone: 'neutral' },
  email: { label: 'بريد إلكتروني', tone: 'neutral' },
  message: { label: 'رسالة', tone: 'neutral' },
  other: { label: 'أخرى', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type CommChannel = keyof typeof COMM_CHANNELS;
export const COMM_CHANNEL_KEYS = keys(COMM_CHANNELS);

export const RELATED_WORK_KINDS = {
  execution: { label: 'ملف تنفيذ', tone: 'neutral' },
  other: { label: 'عمل مرتبط آخر', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type RelatedWorkKind = keyof typeof RELATED_WORK_KINDS;
export const RELATED_WORK_KIND_KEYS = keys(RELATED_WORK_KINDS);

export const RELATED_WORK_STATUSES = {
  ongoing: { label: 'جارٍ', tone: 'info' },
  ended: { label: 'منتهٍ', tone: 'success' },
  suspended: { label: 'موقوف', tone: 'neutral' },
} as const satisfies LabelMap<string>;
export type RelatedWorkStatus = keyof typeof RELATED_WORK_STATUSES;
export const RELATED_WORK_STATUS_KEYS = keys(RELATED_WORK_STATUSES);

// القوائم القابلة للتعديل من الإعدادات (القيم الأولية فقط؛ يستطيع صاحب المكتب الإضافة والإيقاف).
export const LOOKUP_LISTS = {
  case_types: {
    label: 'أنواع القضايا',
    defaults: ['عمالية', 'تجارية', 'عامة (حقوقية)', 'أحوال شخصية', 'جزائية', 'إدارية', 'تنفيذ', 'توثيق', 'استشارة'],
  },
  court_types: {
    label: 'الجهات القضائية',
    defaults: [
      'المحاكم العامة',
      'المحاكم العمالية',
      'المحاكم التجارية',
      'المحاكم الجزائية',
      'محاكم الأحوال الشخصية',
      'محاكم التنفيذ',
      'ديوان المظالم',
      'لجنة شبه قضائية',
    ],
  },
  stage_types: {
    label: 'مراحل التقاضي',
    defaults: ['الدرجة الأولى', 'الاستئناف', 'المحكمة العليا', 'التماس إعادة النظر'],
  },
  party_roles: {
    label: 'صفات الأطراف',
    defaults: ['مدعٍ', 'مدعى عليه', 'مستأنِف', 'مستأنَف ضده', 'طالب التنفيذ', 'منفَّذ ضده', 'متدخل', 'أخرى'],
  },
  id_types: {
    label: 'أنواع المعرفات الرسمية',
    defaults: ['هوية وطنية', 'إقامة', 'سجل تجاري', 'الرقم الموحد للمنشأة', 'جواز سفر', 'أخرى'],
  },
  payment_methods: {
    label: 'طرق الدفع',
    defaults: ['تحويل بنكي', 'نقدًا', 'شيك', 'نقاط بيع', 'أخرى'],
  },
} as const;
export type LookupListKey = keyof typeof LOOKUP_LISTS;
export const LOOKUP_LIST_KEYS = Object.keys(LOOKUP_LISTS) as [LookupListKey, ...LookupListKey[]];

// حدود المرفقات
export const MAX_ATTACHMENT_BYTES = 150 * 1024 * 1024; // 150 ميجابايت للملف الواحد
export const ALLOWED_EXTENSIONS = {
  pdf: { label: 'PDF', kind: 'pdf', mime: 'application/pdf' },
  docx: {
    label: 'Word (DOCX)',
    kind: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  doc: { label: 'Word (DOC)', kind: 'doc', mime: 'application/msword' },
  jpg: { label: 'صورة JPG', kind: 'image', mime: 'image/jpeg' },
  jpeg: { label: 'صورة JPEG', kind: 'image', mime: 'image/jpeg' },
  png: { label: 'صورة PNG', kind: 'image', mime: 'image/png' },
  webp: { label: 'صورة WEBP', kind: 'image', mime: 'image/webp' },
  gif: { label: 'صورة GIF', kind: 'image', mime: 'image/gif' },
  bmp: { label: 'صورة BMP', kind: 'image', mime: 'image/bmp' },
  tif: { label: 'صورة TIFF', kind: 'image-external', mime: 'image/tiff' },
  tiff: { label: 'صورة TIFF', kind: 'image-external', mime: 'image/tiff' },
  heic: { label: 'صورة HEIC', kind: 'image-external', mime: 'image/heic' },
} as const;
export type AllowedExt = keyof typeof ALLOWED_EXTENSIONS;
export const ALLOWED_EXT_KEYS = Object.keys(ALLOWED_EXTENSIONS) as AllowedExt[];

export const DEFAULT_SETTINGS = {
  'office.name': DEFAULT_OFFICE_NAME,
  'office.phone': '',
  'office.email': '',
  'office.address': '',
  'office.license': '',
  'security.idleLockMinutes': 15,
  'reminders.hearingOffsets': [1440, 30] as number[],
  'reminders.taskTime': '09:00',
  'reminders.enabled': true,
  'backup.reminderDays': 7,
  'backup.lastBackupAt': null as string | null,
  'backup.lastBackupPath': null as string | null,
  'backup.lastAutoSnapshotAt': null as string | null,
  'integration.enabled': false,
  'integration.enabledAt': null as string | null,
  'reports.footer': '',
};
export type SettingsShape = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof SettingsShape;

export function labelOf<K extends string>(map: Record<K, { label: string }>, key: string | null | undefined): string {
  if (!key) return '—';
  return (map as Record<string, { label: string }>)[key]?.label ?? key;
}
