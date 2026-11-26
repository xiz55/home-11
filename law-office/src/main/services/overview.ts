// حساب «آخر إجراء مسجل» و«الإجراء التالي» لملف القضية من السجلات الفعلية فقط — دون افتراض وقائع غير مسجلة.
import type { Db } from '../db/db';
import { riyadhToUtcIso, todayRiyadh } from '../../shared/dates';

export interface LastAction {
  kind: string;
  label: string;
  at: string; // لحظة ISO أو تاريخ
  isDateOnly: boolean;
  refType: string;
  refId: string;
}

export interface NextEvent {
  kind: 'hearing' | 'task' | 'deadline' | 'manual';
  label: string;
  at: string;
  isDateOnly: boolean;
  confirmed: boolean;
  responsible: string | null;
  refType: string;
  refId: string;
  overdue: boolean;
}

function dateKey(d: string): string {
  return riyadhToUtcIso(d, '12:00');
}

export function lastActionOf(db: Db, caseId: string, now: Date): LastAction | null {
  const nowIso = now.toISOString();
  const today = todayRiyadh(now);
  const cands: (LastAction & { key: string })[] = [];
  const h = db.get<{ id: string; starts_at: string; status: string; outcome: string | null }>(
    `SELECT id, starts_at, status, outcome FROM hearings WHERE case_id = ? AND starts_at <= ? AND status != 'cancelled' ORDER BY starts_at DESC LIMIT 1`,
    [caseId, nowIso],
  );
  if (h)
    cands.push({
      kind: 'hearing',
      label: h.status === 'held' ? `جلسة منعقدة${h.outcome ? ' — ' + h.outcome.slice(0, 80) : ''}` : h.status === 'postponed' ? 'جلسة مؤجلة' : 'جلسة (لم تُحدَّث نتيجتها)',
      at: h.starts_at,
      isDateOnly: false,
      refType: 'hearing',
      refId: h.id,
      key: h.starts_at,
    });
  const j = db.get<{ id: string; judgment_date: string | null; created_at: string }>(
    `SELECT id, judgment_date, created_at FROM judgments WHERE case_id = ? ORDER BY coalesce(judgment_date, substr(created_at,1,10)) DESC LIMIT 1`,
    [caseId],
  );
  if (j) {
    const d = j.judgment_date ?? j.created_at.slice(0, 10);
    if (d <= today) cands.push({ kind: 'judgment', label: 'صدور حكم', at: j.judgment_date ?? j.created_at, isDateOnly: !!j.judgment_date, refType: 'judgment', refId: j.id, key: j.judgment_date ? dateKey(j.judgment_date) : j.created_at });
  }
  const s = db.get<{ id: string; submitted_on: string; title: string }>(
    `SELECT ms.id, ms.submitted_on, m.title FROM memo_submissions ms JOIN memos m ON m.id = ms.memo_id WHERE m.case_id = ? AND ms.submitted_on <= ? ORDER BY ms.submitted_on DESC LIMIT 1`,
    [caseId, today],
  );
  if (s) cands.push({ kind: 'memo', label: `تقديم مذكرة: ${s.title}`, at: s.submitted_on, isDateOnly: true, refType: 'memo_submission', refId: s.id, key: dateKey(s.submitted_on) });
  const st = db.get<{ id: string; started_on: string; stage_type: string }>(
    `SELECT id, started_on, stage_type FROM stages WHERE case_id = ? AND started_on IS NOT NULL AND started_on <= ? ORDER BY started_on DESC LIMIT 1`,
    [caseId, today],
  );
  if (st) cands.push({ kind: 'stage', label: `بدء مرحلة ${st.stage_type}`, at: st.started_on, isDateOnly: true, refType: 'stage', refId: st.id, key: dateKey(st.started_on) });
  const t = db.get<{ id: string; completed_at: string; title: string }>(
    `SELECT id, completed_at, title FROM tasks WHERE case_id = ? AND status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`,
    [caseId],
  );
  if (t) cands.push({ kind: 'task', label: `إنجاز مهمة: ${t.title}`, at: t.completed_at, isDateOnly: false, refType: 'task', refId: t.id, key: t.completed_at });
  if (!cands.length) return null;
  cands.sort((a, b) => (a.key < b.key ? 1 : -1));
  const { key: _k, ...rest } = cands[0];
  return rest;
}

export function nextEventOf(db: Db, caseId: string, now: Date): NextEvent | null {
  const nowIso = now.toISOString();
  const today = todayRiyadh(now);
  const cands: (NextEvent & { key: string })[] = [];
  const h = db.get<{ id: string; starts_at: string; confirmed: number; attendee: string | null; stage_type: string }>(
    `SELECT h.id, h.starts_at, h.confirmed, h.attendee, s.stage_type FROM hearings h JOIN stages s ON s.id = h.stage_id
     WHERE h.case_id = ? AND h.status = 'scheduled' AND h.starts_at >= ? ORDER BY h.starts_at ASC LIMIT 1`,
    [caseId, nowIso],
  );
  if (h)
    cands.push({
      kind: 'hearing',
      label: `جلسة — ${h.stage_type}`,
      at: h.starts_at,
      isDateOnly: false,
      confirmed: !!h.confirmed,
      responsible: h.attendee,
      refType: 'hearing',
      refId: h.id,
      overdue: false,
      key: h.starts_at,
    });
  const t = db.get<{ id: string; title: string; due_date: string; due_time: string | null; assignee: string | null }>(
    `SELECT t.id, t.title, t.due_date, t.due_time, u.display_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
     WHERE t.case_id = ? AND t.status != 'done' AND t.due_date IS NOT NULL ORDER BY t.due_date ASC, t.due_time ASC LIMIT 1`,
    [caseId],
  );
  if (t)
    cands.push({
      kind: 'task',
      label: `مهمة: ${t.title}`,
      at: t.due_date,
      isDateOnly: true,
      confirmed: true,
      responsible: t.assignee,
      refType: 'task',
      refId: t.id,
      overdue: t.due_date < today,
      key: t.due_time ? riyadhToUtcIso(t.due_date, t.due_time) : dateKey(t.due_date),
    });
  const d = db.get<{ id: string; title: string; due_date: string }>(
    `SELECT id, title, due_date FROM deadlines WHERE case_id = ? AND status = 'open' ORDER BY due_date ASC LIMIT 1`,
    [caseId],
  );
  if (d)
    cands.push({
      kind: 'deadline',
      label: `موعد إجرائي: ${d.title}`,
      at: d.due_date,
      isDateOnly: true,
      confirmed: true,
      responsible: null,
      refType: 'deadline',
      refId: d.id,
      overdue: d.due_date < today,
      key: dateKey(d.due_date),
    });
  const m = db.get<{ next_action: string | null; next_action_due: string | null; responsible: string | null }>(
    `SELECT c.next_action, c.next_action_due, u.display_name AS responsible FROM cases c LEFT JOIN users u ON u.id = c.responsible_user_id WHERE c.id = ?`,
    [caseId],
  );
  if (m?.next_action && m.next_action_due)
    cands.push({
      kind: 'manual',
      label: m.next_action,
      at: m.next_action_due,
      isDateOnly: true,
      confirmed: true,
      responsible: m.responsible,
      refType: 'case',
      refId: caseId,
      overdue: m.next_action_due < today,
      key: dateKey(m.next_action_due),
    });
  if (!cands.length) return null;
  cands.sort((a, b) => (a.key < b.key ? -1 : 1));
  const { key: _k, ...rest } = cands[0];
  return rest;
}

export function currentStageOf(db: Db, caseId: string) {
  const s = db.get<{ id: string; stage_type: string; official_case_no: string | null; court_name: string | null; court_type: string | null; status: string }>(
    `SELECT id, stage_type, official_case_no, court_name, court_type, status FROM stages WHERE case_id = ?
     ORDER BY CASE status WHEN 'ongoing' THEN 0 ELSE 1 END, coalesce(started_on, substr(created_at,1,10)) DESC, sort_order DESC LIMIT 1`,
    [caseId],
  );
  return s ? { id: s.id, stageType: s.stage_type, officialCaseNo: s.official_case_no, courtName: s.court_name, courtType: s.court_type, status: s.status } : null;
}
