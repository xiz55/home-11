// جداول التطبيق المشمولة بالمزامنة ومفاتيحها، والحقول التي لا تغادر الجهاز، والحقول المالية المفصولة.
// يُستخدم في سطح المكتب والآيفون معًا (منطق واحد).

/** جداول تُزامن، بترتيب يراعي الآباء قبل الأبناء عند الرفع الأول. */
export const SYNC_TABLES = [
  'users',
  'settings',
  'lookups',
  'clients',
  'cases',
  'case_parties',
  'user_case_access',
  'user_client_access',
  'stages',
  'related_works',
  'hearings',
  'hearing_changes',
  'hearing_requests',
  'tasks',
  'judgments',
  'deadlines',
  'memos',
  'memo_revisions',
  'contracts',
  'contract_cases',
  'fee_items',
  'payments',
  'expenses',
  'poas',
  'poa_cases',
  'consultations',
  'meetings',
  'meeting_items',
  'appointment_changes',
  'service_txns',
  'contract_adjustments',
  'documents',
  'document_versions',
  'consultation_opinions',
  'opinion_revisions',
  'memo_submissions',
  'case_analysis',
  'analysis_revisions',
  'evidence_items',
  'notes',
  'communications',
  'activity_log',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** لا تُزامن: إعدادات الجهاز وما يُحسب محليًا. */
export const LOCAL_ONLY_TABLES = ['schema_migrations', 'counters', 'reminders', 'integration_tokens'] as const;

export const TABLE_KEYS: Partial<Record<SyncTable, string[]>> = {
  settings: ['key'],
  contract_cases: ['contract_id', 'case_id'],
  poa_cases: ['poa_id', 'case_id'],
  user_case_access: ['user_id', 'case_id'],
  user_client_access: ['user_id', 'client_id'],
  case_analysis: ['case_id'],
};
export const keyCols = (t: string): string[] => TABLE_KEYS[t as SyncTable] ?? ['id'];

/** حقول لا تُرفع (أسرار أو حالة جهاز). */
export const LOCAL_FIELDS: Partial<Record<SyncTable, string[]>> = {
  users: ['password_hash', 'recovery_hash', 'failed_attempts', 'locked_until', 'last_login_at'],
  settings: [],
};
/** إعدادات خاصة بالجهاز لا تُزامن (التنبيهات والنسخ المحلية). */
export const LOCAL_SETTING_KEYS = new Set(['backup.lastBackupAt', 'backup.lastBackupPath', 'backup.lastAutoSnapshotAt', 'integration.enabled', 'integration.enabledAt']);

/** حقول مالية تُفصل في سجل مستقل `tbl$fin` لا يقرؤه إلا من يملك صلاحية الأتعاب. */
export const FIN_FIELDS: Partial<Record<SyncTable, string[]>> = {
  consultations: ['fee_mode', 'fee_amount'],
  meetings: ['fee_amount'],
  contracts: ['fixed_amount', 'percentage', 'percentage_basis'],
};

/** جداول الربط: الحذف ثم الإضافة من جديد مسموح (ليس «إعادة إحياء» سجل محذوف). */
export const LINK_TABLES = new Set(['contract_cases', 'poa_cases', 'user_case_access', 'user_client_access']);

/** قيم افتراضية لأعمدة إلزامية محلية لا تُرفع. */
export const LOCAL_DEFAULTS: Partial<Record<SyncTable, Record<string, unknown>>> = {
  users: { password_hash: '!cloud-account', failed_attempts: 0 },
};

export const ridOf = (t: string, row: Record<string, unknown>): string => keyCols(t).map((k) => String(row[k])).join('|');

export interface RecordPart {
  tbl: string;
  rid: string;
  data: Record<string, unknown>;
}

/** يحوّل صف SQLite إلى سجل أو سجلين (أساسي + مالي). */
export function rowToRecords(t: SyncTable, row: Record<string, unknown>): RecordPart[] {
  const rid = ridOf(t, row);
  const drop = new Set(LOCAL_FIELDS[t] ?? []);
  const fin = new Set(FIN_FIELDS[t] ?? []);
  const main: Record<string, unknown> = {};
  const finData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (drop.has(k)) continue;
    const val = typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? null : v;
    if (fin.has(k)) finData[k] = val;
    else main[k] = val;
  }
  const out: RecordPart[] = [{ tbl: t, rid, data: main }];
  if (fin.size) out.push({ tbl: `${t}$fin`, rid, data: finData });
  return out;
}

export const baseTable = (tbl: string): SyncTable => tbl.split('$')[0] as SyncTable;
