// ترحيلات قاعدة البيانات. كل ترحيل يُطبق داخل معاملة ويُسجل رقمه.
// لا تُعدَّل الترحيلات المنشورة؛ أي تغيير لاحق يُضاف ترحيلًا جديدًا برقم أعلى.
import type { Db } from './db';

const AUDIT = `created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL`;

export const MIGRATIONS: { version: number; name: string; sql: string; foreignKeysOff?: boolean }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','consultant')),
  password_hash TEXT NOT NULL,
  recovery_hash TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE lookups (
  id TEXT PRIMARY KEY,
  list_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (list_key, label)
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('individual','company','establishment')),
  name TEXT NOT NULL,
  short_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  id_type TEXT,
  id_number TEXT,
  rep_name TEXT,
  rep_title TEXT,
  rep_phone TEXT,
  rep_email TEXT,
  relationship_summary TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  archived_at TEXT,
  ${AUDIT}
);
CREATE INDEX idx_clients_status ON clients(status);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  file_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_type TEXT,
  subject TEXT,
  requests TEXT,
  claim_amount INTEGER,
  opened_on TEXT,
  responsible_user_id TEXT REFERENCES users(id),
  follow_status TEXT NOT NULL DEFAULT 'in_progress',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  notes TEXT,
  next_action TEXT,
  next_action_due TEXT,
  outcome TEXT,
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id),
  close_checklist TEXT,
  ${AUDIT}
);
CREATE INDEX idx_cases_client ON cases(client_id);
CREATE INDEX idx_cases_status ON cases(status, archived);

CREATE TABLE case_parties (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  is_opponent INTEGER NOT NULL DEFAULT 1,
  id_number TEXT,
  representative TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);
CREATE INDEX idx_parties_case ON case_parties(case_id);

CREATE TABLE user_case_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, case_id)
);
CREATE TABLE user_client_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  stage_type TEXT NOT NULL,
  court_type TEXT,
  court_name TEXT,
  circuit TEXT,
  official_case_no TEXT,
  started_on TEXT,
  ended_on TEXT,
  status TEXT NOT NULL DEFAULT 'ongoing',
  previous_stage_id TEXT REFERENCES stages(id),
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);
CREATE INDEX idx_stages_case ON stages(case_id);

CREATE TABLE related_works (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  authority TEXT,
  reference_no TEXT,
  opened_on TEXT,
  status TEXT NOT NULL DEFAULT 'ongoing',
  notes TEXT,
  ${AUDIT}
);

CREATE TABLE hearings (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  starts_at TEXT NOT NULL,
  hijri_text TEXT,
  hijri_source TEXT,
  location TEXT,
  attendance_link TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  confirmed INTEGER NOT NULL DEFAULT 1,
  attendee TEXT,
  summary TEXT,
  outcome TEXT,
  office_commitments TEXT,
  next_hearing_id TEXT REFERENCES hearings(id),
  reminder_offsets TEXT,
  ${AUDIT}
);
CREATE INDEX idx_hearings_case ON hearings(case_id);
CREATE INDEX idx_hearings_starts ON hearings(starts_at);

CREATE TABLE hearing_changes (
  id TEXT PRIMARY KEY,
  hearing_id TEXT NOT NULL REFERENCES hearings(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_by TEXT REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_hearing_changes ON hearing_changes(hearing_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  client_id TEXT REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  stage_id TEXT REFERENCES stages(id),
  hearing_id TEXT REFERENCES hearings(id),
  hearing_request_id TEXT REFERENCES hearing_requests(id),
  assignee_user_id TEXT REFERENCES users(id),
  due_date TEXT,
  due_time TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TEXT,
  completed_by TEXT REFERENCES users(id),
  ${AUDIT}
);
CREATE INDEX idx_tasks_case ON tasks(case_id);
CREATE INDEX idx_tasks_due ON tasks(status, due_date);

CREATE TABLE hearing_requests (
  id TEXT PRIMARY KEY,
  hearing_id TEXT NOT NULL REFERENCES hearings(id),
  case_id TEXT NOT NULL REFERENCES cases(id),
  text TEXT NOT NULL,
  requested_by TEXT,
  due_date TEXT,
  task_id TEXT REFERENCES tasks(id),
  ${AUDIT}
);
CREATE INDEX idx_hreq_hearing ON hearing_requests(hearing_id);

CREATE TABLE judgments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  hearing_id TEXT REFERENCES hearings(id),
  judgment_no TEXT,
  judgment_date TEXT,
  hijri_text TEXT,
  hijri_source TEXT,
  summary TEXT NOT NULL,
  follow_status TEXT NOT NULL DEFAULT 'recorded',
  notes TEXT,
  ${AUDIT}
);
CREATE INDEX idx_judgments_case ON judgments(case_id);

CREATE TABLE deadlines (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  judgment_id TEXT REFERENCES judgments(id),
  stage_id TEXT REFERENCES stages(id),
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  notes TEXT,
  ${AUDIT}
);
CREATE INDEX idx_deadlines_case ON deadlines(case_id);

CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  stage_id TEXT REFERENCES stages(id),
  hearing_id TEXT REFERENCES hearings(id),
  title TEXT NOT NULL,
  memo_type TEXT NOT NULL DEFAULT 'memo',
  body TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  ${AUDIT}
);
CREATE INDEX idx_memos_case ON memos(case_id);

CREATE TABLE memo_revisions (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES memos(id),
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  note TEXT,
  saved_by TEXT REFERENCES users(id),
  saved_at TEXT NOT NULL
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL,
  parent_contract_id TEXT REFERENCES contracts(id),
  title TEXT NOT NULL,
  contract_no TEXT,
  signed_on TEXT,
  start_date TEXT,
  end_date TEXT,
  scope TEXT NOT NULL,
  fee_type TEXT NOT NULL DEFAULT 'fixed',
  fixed_amount INTEGER,
  percentage REAL,
  percentage_basis TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  archived_at TEXT,
  ${AUDIT}
);
CREATE INDEX idx_contracts_client ON contracts(client_id);

CREATE TABLE contract_cases (
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (contract_id, case_id)
);

CREATE TABLE fee_items (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  due_date TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  fee_item_id TEXT REFERENCES fee_items(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL,
  method TEXT,
  reference_no TEXT,
  notes TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id),
  ${AUDIT}
);
CREATE INDEX idx_payments_contract ON payments(contract_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  contract_id TEXT REFERENCES contracts(id),
  title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  spent_on TEXT NOT NULL,
  recoverable INTEGER NOT NULL DEFAULT 1,
  reimbursed_on TEXT,
  notes TEXT,
  ${AUDIT}
);
CREATE INDEX idx_expenses_client ON expenses(client_id);

CREATE TABLE poas (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  poa_no TEXT,
  issuer TEXT,
  issued_on TEXT,
  expires_on TEXT,
  hijri_text TEXT,
  scope TEXT NOT NULL,
  agents TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  archived_at TEXT,
  ${AUDIT}
);
CREATE TABLE poa_cases (
  poa_id TEXT NOT NULL REFERENCES poas(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY (poa_id, case_id)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  doc_date TEXT,
  hijri_text TEXT,
  hijri_source TEXT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  stage_id TEXT REFERENCES stages(id),
  hearing_id TEXT REFERENCES hearings(id),
  judgment_id TEXT REFERENCES judgments(id),
  memo_id TEXT REFERENCES memos(id),
  contract_id TEXT REFERENCES contracts(id),
  poa_id TEXT REFERENCES poas(id),
  payment_id TEXT REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'final',
  is_internal INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  ${AUDIT}
);
CREATE INDEX idx_documents_client ON documents(client_id);
CREATE INDEX idx_documents_case ON documents(case_id);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_no INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  ext TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  extracted_text TEXT,
  extracted_norm TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  added_by TEXT REFERENCES users(id),
  added_at TEXT NOT NULL,
  UNIQUE (document_id, version_no)
);
CREATE INDEX idx_docver_sha ON document_versions(sha256);

CREATE TABLE memo_submissions (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES memos(id),
  submitted_on TEXT NOT NULL,
  authority TEXT,
  reference_no TEXT,
  proof_document_id TEXT REFERENCES documents(id),
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE case_analysis (
  case_id TEXT PRIMARY KEY REFERENCES cases(id),
  sections TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);
CREATE TABLE analysis_revisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  section_key TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  revision INTEGER NOT NULL,
  saved_by TEXT REFERENCES users(id),
  saved_at TEXT NOT NULL
);
CREATE INDEX idx_anrev_case ON analysis_revisions(case_id);

CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  fact_date TEXT,
  reliability TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id),
  location_ref TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  body TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  ${AUDIT}
);
CREATE INDEX idx_notes_client ON notes(client_id);

CREATE TABLE communications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  occurred_on TEXT NOT NULL,
  channel TEXT NOT NULL,
  contact_person TEXT,
  summary TEXT NOT NULL,
  deleted_at TEXT,
  ${AUDIT}
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  case_id TEXT REFERENCES cases(id),
  remind_at TEXT NOT NULL,
  event_at TEXT NOT NULL,
  label TEXT NOT NULL,
  fired_at TEXT,
  missed_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(fired_at, remind_at);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  case_id TEXT,
  client_id TEXT,
  summary TEXT,
  details TEXT
);
CREATE INDEX idx_activity_at ON activity_log(at);
CREATE INDEX idx_activity_case ON activity_log(case_id);

CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_on TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'payments: advance flag',
    sql: `ALTER TABLE payments ADD COLUMN is_advance INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 3,
    name: 'consultations, meetings, service finance, contract adjustments',
    // إعادة بناء جدول المستندات (العميل اختياري لمرفقات الاجتماعات) تتطلب تعطيل فحص المفاتيح أثناء الترحيل ثم فحصها كاملة قبل الاعتماد
    foreignKeysOff: true,
    sql: `
CREATE TABLE consultations (
  id TEXT PRIMARY KEY,
  ref_no TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  title TEXT NOT NULL,
  category TEXT,
  description TEXT,
  questions TEXT,
  method TEXT NOT NULL CHECK (method IN ('phone','in_person','video')),
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  ends_at TEXT NOT NULL,
  location TEXT,
  meeting_link TEXT,
  responsible_user_id TEXT REFERENCES users(id),
  fee_mode TEXT NOT NULL DEFAULT 'unset' CHECK (fee_mode IN ('unset','paid','free')),
  fee_amount INTEGER CHECK (fee_amount IS NULL OR fee_amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT,
  written_required INTEGER NOT NULL DEFAULT 1,
  internal_notes TEXT,
  ${AUDIT}
);
CREATE INDEX idx_consult_client ON consultations(client_id);
CREATE INDEX idx_consult_starts ON consultations(starts_at);
CREATE INDEX idx_consult_case ON consultations(case_id);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  ref_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  purpose TEXT,
  client_id TEXT REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  consultation_id TEXT REFERENCES consultations(id),
  participants TEXT NOT NULL DEFAULT '[]',
  responsible_user_id TEXT REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('phone','in_person','video')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT,
  meeting_link TEXT,
  agenda TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT,
  minutes TEXT,
  fee_amount INTEGER CHECK (fee_amount IS NULL OR fee_amount > 0),
  ${AUDIT}
);
CREATE INDEX idx_meet_starts ON meetings(starts_at);
CREATE INDEX idx_meet_client ON meetings(client_id);

CREATE TABLE meeting_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  kind TEXT NOT NULL CHECK (kind IN ('decision','recommendation')),
  text TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${AUDIT}
);
CREATE INDEX idx_meet_items ON meeting_items(meeting_id);

CREATE TABLE appointment_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('consultation','meeting')),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_by TEXT REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE INDEX idx_appt_changes ON appointment_changes(entity_type, entity_id);

CREATE TABLE service_txns (
  id TEXT PRIMARY KEY,
  consultation_id TEXT REFERENCES consultations(id),
  meeting_id TEXT REFERENCES meetings(id),
  client_id TEXT REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment','refund','discount')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  txn_on TEXT NOT NULL,
  method TEXT,
  reference_no TEXT,
  reason TEXT,
  notes TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id),
  ${AUDIT},
  CHECK ((consultation_id IS NULL) <> (meeting_id IS NULL))
);
CREATE INDEX idx_svc_consult ON service_txns(consultation_id);
CREATE INDEX idx_svc_meeting ON service_txns(meeting_id);

CREATE TABLE contract_adjustments (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('discount','refund','consultation_credit')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  adjusted_on TEXT NOT NULL,
  reason TEXT NOT NULL,
  method TEXT,
  reference_no TEXT,
  consultation_id TEXT REFERENCES consultations(id),
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  voided_at TEXT,
  voided_by TEXT REFERENCES users(id),
  ${AUDIT}
);
CREATE INDEX idx_adj_contract ON contract_adjustments(contract_id);

CREATE TABLE documents_v3 (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  doc_date TEXT,
  hijri_text TEXT,
  hijri_source TEXT,
  client_id TEXT REFERENCES clients(id),
  case_id TEXT REFERENCES cases(id),
  stage_id TEXT REFERENCES stages(id),
  hearing_id TEXT REFERENCES hearings(id),
  judgment_id TEXT REFERENCES judgments(id),
  memo_id TEXT REFERENCES memos(id),
  contract_id TEXT REFERENCES contracts(id),
  poa_id TEXT REFERENCES poas(id),
  payment_id TEXT REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'final',
  is_internal INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  ${AUDIT},
  consultation_id TEXT REFERENCES consultations(id),
  meeting_id TEXT REFERENCES meetings(id),
  service_txn_id TEXT REFERENCES service_txns(id),
  CHECK (client_id IS NOT NULL OR meeting_id IS NOT NULL)
);
INSERT INTO documents_v3 (id, title, description, category, doc_date, hijri_text, hijri_source, client_id, case_id, stage_id, hearing_id, judgment_id, memo_id,
  contract_id, poa_id, payment_id, status, is_internal, current_version, archived_at, created_by, created_at, updated_by, updated_at)
SELECT id, title, description, category, doc_date, hijri_text, hijri_source, client_id, case_id, stage_id, hearing_id, judgment_id, memo_id,
  contract_id, poa_id, payment_id, status, is_internal, current_version, archived_at, created_by, created_at, updated_by, updated_at FROM documents;
DROP TABLE documents;
ALTER TABLE documents_v3 RENAME TO documents;
CREATE INDEX idx_documents_client ON documents(client_id);
CREATE INDEX idx_documents_case ON documents(case_id);
CREATE INDEX idx_documents_consult ON documents(consultation_id);
CREATE INDEX idx_documents_meeting ON documents(meeting_id);

CREATE TABLE consultation_opinions (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id),
  title TEXT NOT NULL,
  opinion_date TEXT,
  author_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  body TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  document_id TEXT REFERENCES documents(id),
  delivered_on TEXT,
  delivery_method TEXT,
  delivery_notes TEXT,
  delivery_proof_document_id TEXT REFERENCES documents(id),
  ${AUDIT}
);
CREATE INDEX idx_opinions_consult ON consultation_opinions(consultation_id);
CREATE TABLE opinion_revisions (
  id TEXT PRIMARY KEY,
  opinion_id TEXT NOT NULL REFERENCES consultation_opinions(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  note TEXT,
  saved_by TEXT REFERENCES users(id),
  saved_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN consultation_id TEXT REFERENCES consultations(id);
ALTER TABLE tasks ADD COLUMN meeting_id TEXT REFERENCES meetings(id);
ALTER TABLE fee_items ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'installment';
ALTER TABLE fee_items ADD COLUMN basis TEXT;

-- رقم ثابت لكل عميل/جهة اتصال بترتيب التسجيل
ALTER TABLE clients ADD COLUMN client_no TEXT;
UPDATE clients SET client_no = (SELECT printf('%05d', x.rn) FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM clients) x WHERE x.id = clients.id);
CREATE UNIQUE INDEX idx_clients_no ON clients(client_no);
INSERT INTO counters (name, value) SELECT 'client_no', count(*) FROM clients WHERE 1 ON CONFLICT(name) DO UPDATE SET value = excluded.value;
`,
  },
  {
    version: 4,
    name: 'cloud sync bookkeeping',
    // جداول المزامنة محلية فقط (لا تُرفع). المشغلات تُثبَّت عند تفعيل المزامنة السحابية.
    sql: `
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sync_flags (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0);
INSERT INTO sync_flags (id, applying) VALUES (1, 0);
CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  rid TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_outbox_key ON sync_outbox(tbl, rid);
-- دفعة أُرسلت ولم يصل ردها: تُعاد كما هي بنفس معرفات العمليات قبل أي دفعة جديدة
CREATE TABLE sync_inflight (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, max_seq INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sync_meta (tbl TEXT NOT NULL, rid TEXT NOT NULL, version INTEGER NOT NULL, base TEXT, PRIMARY KEY (tbl, rid));
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  tbl TEXT NOT NULL,
  rid TEXT NOT NULL,
  fields TEXT NOT NULL,
  server_data TEXT NOT NULL,
  client_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE TABLE sync_rejected (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, rid TEXT NOT NULL, message TEXT, at TEXT NOT NULL);
CREATE TABLE sync_blobs (
  version_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending_upload','uploading','uploaded','remote','downloading','local','failed')),
  pinned INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE number_blocks (name TEXT NOT NULL, next INTEGER NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (name, next));
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function currentSchemaVersion(db: Db): number {
  const exists = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  );
  if (!exists || exists.n === 0) return 0;
  const r = db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return r?.v ?? 0;
}

export function migrate(db: Db, now: () => string = () => new Date().toISOString()): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const current = currentSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `قاعدة البيانات أحدث من هذا الإصدار من البرنامج (بنية ${current} > ${LATEST_SCHEMA_VERSION}). حدّث البرنامج قبل فتحها.`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // تعطيل فحص المفاتيح لا يُسمح به داخل معاملة؛ يُعطَّل قبلها ويُفحص الاتساق كاملًا قبل الاعتماد ثم يُعاد تفعيله
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.tx(() => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const bad = db.all('PRAGMA foreign_key_check');
          if (bad.length) throw new Error(`فشل ترحيل البنية ${m.version}: علاقات غير متسقة (${bad.length})`);
        }
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()]);
      });
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return LATEST_SCHEMA_VERSION;
}
