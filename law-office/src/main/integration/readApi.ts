// واجهة قراءة منظمة للتكامل الاختياري (MCP). قراءة فقط، ومقيدة بنطاق رمز يصدره صاحب المكتب.
// لا تتيح SQL عامًا، ولا قراءة ملفات عشوائية، ولا كتابة، ولا أوامر نظام تشغيل.
import { createHash } from 'node:crypto';
import type { Db } from '../db/db';
import { likeEscape, searchTokens } from '../../shared/text';
import { fmtDate, fmtDateTime, todayRiyadh } from '../../shared/dates';
import { CASE_STATUSES, FOLLOW_STATUSES, HEARING_STATUSES, MEMO_STATUSES, TASK_STATUSES, JUDGMENT_FOLLOW, DOC_CATEGORIES, labelOf } from '../../shared/constants';
import { currentStageOf, lastActionOf, nextEventOf } from '../services/overview';

export interface TokenScope {
  clientIds: string[];
  caseIds: string[];
  allowDocumentText: boolean;
}

export interface TokenRow {
  id: string;
  name: string;
  scope: TokenScope;
  expiresOn: string | null;
}

export class AccessDenied extends Error {}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

function integrationEnabled(db: Db): boolean {
  const r = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'integration.enabled'");
  try {
    return r ? JSON.parse(r.value) === true : false;
  } catch {
    return false;
  }
}

/** يتحقق في كل استدعاء من تفعيل التكامل وصلاحية الرمز (غير ملغى وغير منتهٍ). */
export function resolveToken(db: Db, raw: string | undefined, now: Date): TokenRow {
  if (!integrationEnabled(db)) throw new AccessDenied('التكامل غير مفعّل في البرنامج. يفعّله صاحب المكتب من الإعدادات.');
  if (!raw || raw.length < 20) throw new AccessDenied('رمز الربط مفقود أو غير صالح.');
  const r = db.get<{ id: string; name: string; scope: string; expires_on: string | null; revoked_at: string | null }>(
    'SELECT id, name, scope, expires_on, revoked_at FROM integration_tokens WHERE token_hash = ?',
    [hashToken(raw)],
  );
  if (!r) throw new AccessDenied('رمز الربط غير معروف.');
  if (r.revoked_at) throw new AccessDenied('تم إلغاء رمز الربط.');
  if (r.expires_on && r.expires_on < todayRiyadh(now)) throw new AccessDenied('انتهت صلاحية رمز الربط.');
  let scope: TokenScope;
  try {
    scope = JSON.parse(r.scope);
  } catch {
    throw new AccessDenied('نطاق الرمز تالف.');
  }
  return { id: r.id, name: r.name, scope: { clientIds: scope.clientIds ?? [], caseIds: scope.caseIds ?? [], allowDocumentText: !!scope.allowDocumentText }, expiresOn: r.expires_on };
}

export function allowedCaseIds(db: Db, scope: TokenScope): Set<string> {
  const s = new Set(scope.caseIds.filter((id) => db.get('SELECT id FROM cases WHERE id = ?', [id])));
  for (const cid of scope.clientIds) for (const r of db.all<{ id: string }>('SELECT id FROM cases WHERE client_id = ?', [cid])) s.add(r.id);
  return s;
}

export function allowedClientIds(db: Db, scope: TokenScope): Set<string> {
  const s = new Set(scope.clientIds.filter((id) => db.get('SELECT id FROM clients WHERE id = ?', [id])));
  for (const caseId of scope.caseIds) {
    const r = db.get<{ client_id: string }>('SELECT client_id FROM cases WHERE id = ?', [caseId]);
    if (r) s.add(r.client_id);
  }
  return s;
}

function assertCase(db: Db, scope: TokenScope, caseId: string) {
  if (!allowedCaseIds(db, scope).has(caseId)) throw new AccessDenied('هذه القضية خارج نطاق الوصول الممنوح لهذا الربط (أو غير موجودة).');
}

const NO_RECORD_NOTE = 'غياب واقعة في هذه البيانات يعني أنها لم تُسجل في البرنامج، ولا يعني بالضرورة أنها لم تحدث.';

export function findClients(db: Db, scope: TokenScope, query: string) {
  const allowed = allowedClientIds(db, scope);
  const tokens = searchTokens(query);
  const rows = db.all<{ id: string; name: string; kind: string; status: string }>(
    `SELECT id, name, kind, status FROM clients WHERE ${tokens.length ? tokens.map((_, i) => `(arnorm(name) LIKE :t${i} ESCAPE '\\' OR arnorm(coalesce(short_name,'')) LIKE :t${i} ESCAPE '\\')`).join(' AND ') : '1=1'} ORDER BY name LIMIT 200`,
    Object.fromEntries(tokens.map((t, i) => [`t${i}`, `%${likeEscape(t)}%`])),
  );
  return rows.filter((r) => allowed.has(r.id)).map((r) => ({ client_id: r.id, name: r.name, kind: r.kind, status: r.status }));
}

function caseBrief(db: Db, id: string, now: Date) {
  const c = db.get<{ id: string; file_no: string; title: string; client_name: string; client_id: string; case_type: string | null; status: string; follow_status: string; archived: number; updated_at: string }>(
    `SELECT c.id, c.file_no, c.title, cl.name AS client_name, c.client_id, c.case_type, c.status, c.follow_status, c.archived, c.updated_at FROM cases c JOIN clients cl ON cl.id = c.client_id WHERE c.id = ?`,
    [id],
  )!;
  const opponents = db.all<{ name: string }>('SELECT name FROM case_parties WHERE case_id = ? AND is_opponent = 1', [id]).map((x) => x.name);
  const stage = currentStageOf(db, id);
  return {
    case_id: c.id,
    internal_file_no: c.file_no,
    title: c.title,
    client: c.client_name,
    client_id: c.client_id,
    case_type: c.case_type,
    opponents,
    current_stage: stage ? { name: stage.stageType, court: stage.courtName, official_case_no: stage.officialCaseNo } : null,
    status: labelOf(CASE_STATUSES, c.status) + (c.archived ? ' (مؤرشفة)' : ''),
    follow_status: labelOf(FOLLOW_STATUSES, c.follow_status),
    next_event: (() => {
      const n = nextEventOf(db, id, now);
      return n ? { what: n.label, when: n.isDateOnly ? fmtDate(n.at) : fmtDateTime(n.at), confirmed: n.confirmed } : null;
    })(),
  };
}

export function findCases(db: Db, scope: TokenScope, query: string, now: Date) {
  const allowed = allowedCaseIds(db, scope);
  const tokens = searchTokens(query);
  const p: Record<string, unknown> = {};
  const where = tokens.map((t, i) => {
    p[`t${i}`] = `%${likeEscape(t)}%`;
    return `(arnorm(c.title) LIKE :t${i} ESCAPE '\\' OR c.file_no LIKE :t${i} ESCAPE '\\' OR arnorm(cl.name) LIKE :t${i} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM case_parties cp WHERE cp.case_id = c.id AND arnorm(cp.name) LIKE :t${i} ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM stages s WHERE s.case_id = c.id AND arnorm(coalesce(s.official_case_no,'')) LIKE :t${i} ESCAPE '\\'))`;
  });
  const rows = db.all<{ id: string }>(`SELECT c.id FROM cases c JOIN clients cl ON cl.id = c.client_id WHERE ${where.length ? where.join(' AND ') : '1=1'} ORDER BY c.updated_at DESC LIMIT 500`, p);
  const matches = rows.filter((r) => allowed.has(r.id)).map((r) => caseBrief(db, r.id, now));
  return {
    matches,
    note:
      matches.length > 1
        ? 'تطابق الاستعلام مع أكثر من قضية. لا تختر واحدة عشوائيًا؛ اطلب من المستخدم تحديد القضية (برقم الملف أو الخصم) ثم استخدم get_case_summary بالمعرّف.'
        : matches.length === 0
          ? 'لا توجد قضية مطابقة ضمن النطاق المسموح لهذا الربط.'
          : null,
  };
}

export function listClientCases(db: Db, scope: TokenScope, clientId: string, now: Date) {
  const allowed = allowedCaseIds(db, scope);
  const rows = db.all<{ id: string }>('SELECT id FROM cases WHERE client_id = ? ORDER BY created_at', [clientId]);
  const vis = rows.filter((r) => allowed.has(r.id));
  if (!vis.length && !allowedClientIds(db, scope).has(clientId)) throw new AccessDenied('هذا العميل خارج نطاق الوصول الممنوح.');
  return vis.map((r) => caseBrief(db, r.id, now));
}

export function caseSummary(db: Db, scope: TokenScope, caseId: string, now: Date) {
  assertCase(db, scope, caseId);
  const brief = caseBrief(db, caseId, now);
  const stages = db
    .all<{ id: string; stage_type: string; court_name: string | null; circuit: string | null; official_case_no: string | null; started_on: string | null; status: string }>(
      'SELECT id, stage_type, court_name, circuit, official_case_no, started_on, status FROM stages WHERE case_id = ? ORDER BY coalesce(started_on, created_at)',
      [caseId],
    )
    .map((s) => ({ stage: s.stage_type, court: s.court_name, circuit: s.circuit, official_case_no: s.official_case_no, started_on: s.started_on, status: s.status, source: `lawoffice://case/${caseId}/stage/${s.id}` }));
  const nowIso = now.toISOString();
  const recentHearings = db
    .all<{ id: string; starts_at: string; status: string; outcome: string | null; summary: string | null; minutes: number }>(
      `SELECT h.id, h.starts_at, h.status, h.outcome, h.summary, (SELECT count(*) FROM documents d WHERE d.hearing_id = h.id AND d.category = 'minutes') AS minutes
       FROM hearings h WHERE h.case_id = ? AND h.starts_at <= ? ORDER BY h.starts_at DESC LIMIT 5`,
      [caseId, nowIso],
    )
    .map((h) => ({
      when: fmtDateTime(h.starts_at),
      status: labelOf(HEARING_STATUSES, h.status),
      outcome: h.outcome,
      summary: h.summary ? h.summary.slice(0, 600) : null,
      source: h.minutes ? 'ضبط الجلسة مرفق في البرنامج' : 'إدخال يدوي',
      ref: `lawoffice://case/${caseId}/hearing/${h.id}`,
    }));
  const judgments = db
    .all<{ id: string; judgment_no: string | null; judgment_date: string | null; summary: string; follow_status: string }>('SELECT id, judgment_no, judgment_date, summary, follow_status FROM judgments WHERE case_id = ? ORDER BY coalesce(judgment_date, created_at)', [caseId])
    .map((j) => ({ number: j.judgment_no, date: j.judgment_date, operative_summary_as_recorded: j.summary, follow_up: labelOf(JUDGMENT_FOLLOW, j.follow_status), ref: `lawoffice://case/${caseId}/judgment/${j.id}` }));
  const memos = db
    .all<{ id: string; title: string; status: string; last_sub: string | null }>('SELECT m.id, m.title, m.status, (SELECT max(submitted_on) FROM memo_submissions s WHERE s.memo_id = m.id) AS last_sub FROM memos m WHERE m.case_id = ?', [caseId])
    .map((m) => ({ title: m.title, status: labelOf(MEMO_STATUSES, m.status), submitted_on: m.last_sub, ref: `lawoffice://case/${caseId}/memo/${m.id}` }));
  const upcomingHearings = db
    .all<{ id: string; starts_at: string; confirmed: number; location: string | null }>("SELECT id, starts_at, confirmed, location FROM hearings WHERE case_id = ? AND status = 'scheduled' AND starts_at >= ? ORDER BY starts_at LIMIT 3", [caseId, nowIso])
    .map((h) => ({ when: fmtDateTime(h.starts_at), confirmed: !!h.confirmed, location: h.location, ref: `lawoffice://case/${caseId}/hearing/${h.id}` }));
  const tasks = db
    .all<{ id: string; title: string; due_date: string | null; status: string; assignee: string | null }>(
      "SELECT t.id, t.title, t.due_date, t.status, u.display_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.case_id = ? AND t.status != 'done' ORDER BY t.due_date",
      [caseId],
    )
    .map((t) => ({ title: t.title, due: t.due_date, status: labelOf(TASK_STATUSES, t.status), assignee: t.assignee, ref: `lawoffice://case/${caseId}/task/${t.id}` }));
  const last = lastActionOf(db, caseId, now);
  const lastUpdate = [
    db.get<{ m: string }>('SELECT updated_at AS m FROM cases WHERE id = ?', [caseId])?.m,
    ...['hearings', 'judgments', 'memos', 'documents', 'tasks', 'stages'].map((t) => db.get<{ m: string | null }>(`SELECT max(updated_at) AS m FROM ${t} WHERE case_id = ?`, [caseId])?.m),
  ]
    .filter(Boolean)
    .sort()
    .pop();
  return {
    ...brief,
    stages,
    last_recorded_action: last ? { what: last.label, when: last.isDateOnly ? fmtDate(last.at) : fmtDateTime(last.at), ref: `lawoffice://case/${caseId}/${last.refType}/${last.refId}` } : null,
    recent_hearings: recentHearings,
    judgments,
    memos,
    upcoming_hearings: upcomingHearings,
    open_tasks: tasks,
    last_updated_in_app: lastUpdate ? fmtDateTime(lastUpdate) : null,
    data_note: NO_RECORD_NOTE,
  };
}

export function caseSchedule(db: Db, scope: TokenScope, caseId: string, now: Date) {
  assertCase(db, scope, caseId);
  const hearings = db
    .all<{ id: string; starts_at: string; status: string; confirmed: number; location: string | null; outcome: string | null }>('SELECT id, starts_at, status, confirmed, location, outcome FROM hearings WHERE case_id = ? ORDER BY starts_at', [caseId])
    .map((h) => ({ when: fmtDateTime(h.starts_at), status: labelOf(HEARING_STATUSES, h.status), confirmed: !!h.confirmed, location: h.location, outcome: h.outcome, ref: `lawoffice://case/${caseId}/hearing/${h.id}` }));
  const tasks = db
    .all<{ id: string; title: string; due_date: string | null; status: string }>('SELECT id, title, due_date, status FROM tasks WHERE case_id = ? ORDER BY due_date', [caseId])
    .map((t) => ({ title: t.title, due: t.due_date, status: labelOf(TASK_STATUSES, t.status), ref: `lawoffice://case/${caseId}/task/${t.id}` }));
  const deadlines = db
    .all<{ id: string; title: string; due_date: string; status: string; source: string }>('SELECT id, title, due_date, status, source FROM deadlines WHERE case_id = ? ORDER BY due_date', [caseId])
    .map((d) => ({ title: d.title, due: d.due_date, status: d.status, recorded_source: d.source }));
  return { today_riyadh: todayRiyadh(now), hearings, tasks, deadlines, data_note: NO_RECORD_NOTE };
}

export function upcoming(db: Db, scope: TokenScope, days: number, now: Date) {
  const allowed = [...allowedCaseIds(db, scope)];
  if (!allowed.length) return { items: [] };
  const until = new Date(now.getTime() + days * 86400_000).toISOString();
  const items = db
    .all<{ id: string; case_id: string; starts_at: string; confirmed: number; file_no: string; title: string; client: string }>(
      `SELECT h.id, h.case_id, h.starts_at, h.confirmed, c.file_no, c.title, cl.name AS client FROM hearings h JOIN cases c ON c.id = h.case_id JOIN clients cl ON cl.id = c.client_id
       WHERE h.status = 'scheduled' AND h.starts_at >= ? AND h.starts_at <= ? ORDER BY h.starts_at`,
      [now.toISOString(), until],
    )
    .filter((h) => allowed.includes(h.case_id))
    .map((h) => ({ kind: 'جلسة', when: fmtDateTime(h.starts_at), confirmed: !!h.confirmed, case: `${h.title} (${h.file_no})`, client: h.client, case_id: h.case_id }));
  return { items, data_note: NO_RECORD_NOTE };
}

export function caseDocuments(db: Db, scope: TokenScope, caseId: string) {
  assertCase(db, scope, caseId);
  return db
    .all<{ id: string; title: string; category: string; doc_date: string | null; ext: string; extraction_status: string }>(
      `SELECT d.id, d.title, d.category, d.doc_date, v.ext, v.extraction_status FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
       WHERE d.case_id = ? AND d.archived_at IS NULL ORDER BY coalesce(d.doc_date, d.created_at)`,
      [caseId],
    )
    .map((d) => ({ document_id: d.id, title: d.title, category: labelOf(DOC_CATEGORIES, d.category), date: d.doc_date, file_type: d.ext, text_available: d.extraction_status === 'done' }));
}

export function documentText(db: Db, scope: TokenScope, documentId: string, maxChars = 60000) {
  if (!scope.allowDocumentText) throw new AccessDenied('قراءة نصوص المستندات غير مسموحة لهذا الربط.');
  const d = db.get<{ case_id: string | null; title: string; current_version: number; memo_id: string | null }>('SELECT case_id, title, current_version, memo_id FROM documents WHERE id = ?', [documentId]);
  if (d) {
    if (!d.case_id) throw new AccessDenied('مستندات العميل العامة غير متاحة عبر الربط.');
    assertCase(db, scope, d.case_id);
    const v = db.get<{ extracted_text: string | null; extraction_status: string }>('SELECT extracted_text, extraction_status FROM document_versions WHERE document_id = ? AND version_no = ?', [documentId, d.current_version]);
    if (!v || v.extraction_status !== 'done' || !v.extracted_text)
      return { title: d.title, text: null, note: 'لا يوجد نص مستخرج محليًا لهذا المستند (قد يكون صورة ممسوحة ضوئيًا أو نوعًا غير مدعوم للاستخراج).' };
    return { title: d.title, text: v.extracted_text.slice(0, maxChars), truncated: v.extracted_text.length > maxChars };
  }
  const m = db.get<{ case_id: string; title: string; body: string | null; status: string }>('SELECT case_id, title, body, status FROM memos WHERE id = ?', [documentId]);
  if (!m) throw new AccessDenied('المستند غير موجود أو خارج النطاق.');
  assertCase(db, scope, m.case_id);
  return { title: m.title, memo_status: labelOf(MEMO_STATUSES, m.status), text: (m.body ?? '').slice(0, maxChars), truncated: (m.body ?? '').length > maxChars };
}
