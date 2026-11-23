// السجل الزمني للقضية: يُبنى من السجلات المدخلة فعلًا مع مصدر كل واقعة، ولا يفترض إجراءات لم تُسجَّل.
import type { Ctx } from '../context';
import { riyadhToUtcIso } from '../../shared/dates';
import { HEARING_STATUSES, JUDGMENT_FOLLOW, MEMO_STATUSES, DOC_CATEGORIES, type HearingStatus, type JudgmentFollow, type MemoStatus, type DocCategory } from '../../shared/constants';
import { requireCase } from './access';

export interface TimelineDoc {
  documentId: string;
  versionId: string | null;
  title: string;
  category: DocCategory;
  ext: string | null;
}

export interface TimelineEvent {
  key: string;
  sortKey: string;
  at: string;
  isDateOnly: boolean;
  kind: 'opened' | 'stage' | 'hearing' | 'reschedule' | 'request' | 'judgment' | 'deadline' | 'memo' | 'submission' | 'document' | 'task' | 'close' | 'reopen' | 'archive' | 'related';
  title: string;
  detail: string | null;
  status: string | null;
  stageId: string | null;
  refType: string;
  refId: string;
  source: string;
  documents: TimelineDoc[];
}

const dk = (d: string) => riyadhToUtcIso(d, '12:00');

export function caseTimeline(ctx: Ctx, input: { id: string }): TimelineEvent[] {
  requireCase(ctx, input.id);
  const db = ctx.db;
  const caseId = input.id;
  const ev: TimelineEvent[] = [];
  const docsFor = (col: string, id: string): TimelineDoc[] =>
    db
      .all<{ id: string; title: string; category: DocCategory; v_id: string | null; ext: string | null }>(
        `SELECT d.id, d.title, d.category, v.id AS v_id, v.ext FROM documents d LEFT JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
         WHERE d.${col} = ? AND d.archived_at IS NULL ORDER BY d.created_at`,
        [id],
      )
      .map((d) => ({ documentId: d.id, versionId: d.v_id, title: d.title, category: d.category, ext: d.ext }));
  const by = (name: string | null, at: string) => `إدخال يدوي${name ? ' — ' + name : ''} (${at.slice(0, 10).replace(/-/g, '/')})`;

  const c = db.get<{ opened_on: string | null; created_at: string; file_no: string; creator: string | null }>(
    'SELECT c.opened_on, c.created_at, c.file_no, u.display_name AS creator FROM cases c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?',
    [caseId],
  )!;
  ev.push({
    key: 'opened',
    sortKey: c.opened_on ? dk(c.opened_on) : c.created_at,
    at: c.opened_on ?? c.created_at,
    isDateOnly: !!c.opened_on,
    kind: 'opened',
    title: `فتح ملف القضية ${c.file_no}`,
    detail: c.opened_on ? null : 'تاريخ فتح الملف غير مسجل؛ يظهر تاريخ إنشائه في البرنامج',
    status: null,
    stageId: null,
    refType: 'case',
    refId: caseId,
    source: by(c.creator, c.created_at),
    documents: [],
  });

  for (const s of db.all<Record<string, string | null>>(
    `SELECT s.*, p.stage_type AS prev_type, u.display_name AS creator FROM stages s LEFT JOIN stages p ON p.id = s.previous_stage_id LEFT JOIN users u ON u.id = s.created_by WHERE s.case_id = ?`,
    [caseId],
  )) {
    ev.push({
      key: `stage-${s.id}`,
      sortKey: s.started_on ? dk(s.started_on) : s.created_at!,
      at: s.started_on ?? s.created_at!,
      isDateOnly: !!s.started_on,
      kind: 'stage',
      title: s.prev_type ? `الانتقال إلى ${s.stage_type} (بعد ${s.prev_type})` : `بدء مرحلة ${s.stage_type}`,
      detail: [s.court_name, s.circuit ? `الدائرة: ${s.circuit}` : null, s.official_case_no ? `رقم القضية: ${s.official_case_no}` : null].filter(Boolean).join(' — ') || null,
      status: s.status,
      stageId: s.id!,
      refType: 'stage',
      refId: s.id!,
      source: s.started_on ? by(s.creator, s.created_at!) : `${by(s.creator, s.created_at!)} — تاريخ بدء المرحلة غير مسجل`,
      documents: docsFor('stage_id', s.id!).filter((d) => !['minutes', 'judgment', 'memo'].includes(d.category)).slice(0, 5),
    });
    if (s.ended_on)
      ev.push({ key: `stage-end-${s.id}`, sortKey: dk(s.ended_on), at: s.ended_on, isDateOnly: true, kind: 'stage', title: `انتهاء مرحلة ${s.stage_type}`, detail: null, status: s.status, stageId: s.id!, refType: 'stage', refId: s.id!, source: by(s.creator, s.updated_at!), documents: [] });
  }

  for (const h of db.all<Record<string, string | number | null>>(
    `SELECT h.*, u.display_name AS creator FROM hearings h LEFT JOIN users u ON u.id = h.created_by WHERE h.case_id = ?`,
    [caseId],
  )) {
    const docs = docsFor('hearing_id', String(h.id));
    const hasMinutes = docs.some((d) => d.category === 'minutes');
    ev.push({
      key: `hearing-${h.id}`,
      sortKey: String(h.starts_at),
      at: String(h.starts_at),
      isDateOnly: false,
      kind: 'hearing',
      title: `جلسة — ${HEARING_STATUSES[h.status as HearingStatus]?.label ?? h.status}${h.confirmed ? '' : ' (موعد غير مؤكد)'}`,
      detail: [h.outcome ? `النتيجة: ${h.outcome}` : null, h.summary ? String(h.summary).slice(0, 400) : null].filter(Boolean).join('\n') || null,
      status: String(h.status),
      stageId: String(h.stage_id),
      refType: 'hearing',
      refId: String(h.id),
      source: hasMinutes ? 'ضبط الجلسة المرفق' : by(h.creator as string | null, String(h.created_at)),
      documents: docs,
    });
    for (const r of db.all<Record<string, string | null>>(`SELECT r.*, u.display_name AS creator FROM hearing_requests r LEFT JOIN users u ON u.id = r.created_by WHERE r.hearing_id = ?`, [String(h.id)])) {
      ev.push({
        key: `req-${r.id}`,
        sortKey: String(h.starts_at) + '~',
        at: String(h.starts_at),
        isDateOnly: false,
        kind: 'request',
        title: `طلب في الجلسة${r.requested_by ? ' (من ' + r.requested_by + ')' : ''}`,
        detail: r.text,
        status: r.task_id ? 'حُوّل إلى مهمة' : null,
        stageId: String(h.stage_id),
        refType: 'hearing',
        refId: String(h.id),
        source: hasMinutes ? 'ضبط الجلسة المرفق' : by(r.creator, r.created_at!),
        documents: [],
      });
    }
  }

  for (const ch of db.all<Record<string, string | null>>(
    `SELECT hc.*, h.stage_id, u.display_name AS by_name FROM hearing_changes hc JOIN hearings h ON h.id = hc.hearing_id LEFT JOIN users u ON u.id = hc.changed_by
     WHERE h.case_id = ? AND hc.field = 'starts_at'`,
    [caseId],
  )) {
    ev.push({
      key: `resch-${ch.id}`,
      sortKey: ch.changed_at!,
      at: ch.changed_at!,
      isDateOnly: false,
      kind: 'reschedule',
      title: 'تعديل موعد جلسة',
      detail: `من ${ch.old_value} إلى ${ch.new_value}${ch.reason ? ' — السبب: ' + ch.reason : ''}`,
      status: null,
      stageId: ch.stage_id,
      refType: 'hearing',
      refId: ch.hearing_id!,
      source: by(ch.by_name, ch.changed_at!),
      documents: [],
    });
  }

  for (const j of db.all<Record<string, string | null>>(`SELECT j.*, u.display_name AS creator FROM judgments j LEFT JOIN users u ON u.id = j.created_by WHERE j.case_id = ?`, [caseId])) {
    const docs = docsFor('judgment_id', j.id!);
    ev.push({
      key: `judgment-${j.id}`,
      sortKey: j.judgment_date ? dk(j.judgment_date) : j.created_at!,
      at: j.judgment_date ?? j.created_at!,
      isDateOnly: !!j.judgment_date,
      kind: 'judgment',
      title: `حكم${j.judgment_no ? ' رقم ' + j.judgment_no : ''}`,
      detail: `${j.summary}\nالمتابعة: ${JUDGMENT_FOLLOW[j.follow_status as JudgmentFollow]?.label ?? j.follow_status}`,
      status: j.follow_status,
      stageId: j.stage_id,
      refType: 'judgment',
      refId: j.id!,
      source: docs.length ? 'صك/نسخة الحكم المرفقة' : by(j.creator, j.created_at!) + (j.judgment_date ? '' : ' — تاريخ الحكم غير مسجل'),
      documents: docs,
    });
  }

  for (const d of db.all<Record<string, string | null>>(`SELECT d.*, u.display_name AS creator FROM deadlines d LEFT JOIN users u ON u.id = d.created_by WHERE d.case_id = ?`, [caseId])) {
    ev.push({
      key: `deadline-${d.id}`,
      sortKey: dk(d.due_date!),
      at: d.due_date!,
      isDateOnly: true,
      kind: 'deadline',
      title: `موعد إجرائي: ${d.title}`,
      detail: d.notes,
      status: d.status,
      stageId: d.stage_id,
      refType: 'deadline',
      refId: d.id!,
      source: `المصدر المسجل: ${d.source}`,
      documents: [],
    });
  }

  for (const m of db.all<Record<string, string | null>>(`SELECT m.*, u.display_name AS creator FROM memos m LEFT JOIN users u ON u.id = m.created_by WHERE m.case_id = ?`, [caseId])) {
    ev.push({
      key: `memo-${m.id}`,
      sortKey: m.created_at!,
      at: m.created_at!,
      isDateOnly: false,
      kind: 'memo',
      title: `إعداد مذكرة: ${m.title}`,
      detail: `الحالة الحالية: ${MEMO_STATUSES[m.status as MemoStatus]?.label ?? m.status}`,
      status: m.status,
      stageId: m.stage_id,
      refType: 'memo',
      refId: m.id!,
      source: by(m.creator, m.created_at!),
      documents: docsFor('memo_id', m.id!),
    });
    for (const s of db.all<Record<string, string | null>>(
      `SELECT s.*, u.display_name AS creator, d.title AS proof_title, v.id AS v_id, v.ext FROM memo_submissions s LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN documents d ON d.id = s.proof_document_id LEFT JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version WHERE s.memo_id = ?`,
      [m.id!],
    )) {
      ev.push({
        key: `sub-${s.id}`,
        sortKey: dk(s.submitted_on!),
        at: s.submitted_on!,
        isDateOnly: true,
        kind: 'submission',
        title: `تقديم المذكرة «${m.title}»${s.authority ? ' إلى ' + s.authority : ''}`,
        detail: [s.reference_no ? `المرجع: ${s.reference_no}` : null, s.notes].filter(Boolean).join(' — ') || null,
        status: 'submitted',
        stageId: m.stage_id,
        refType: 'memo',
        refId: m.id!,
        source: s.proof_document_id ? 'إثبات التقديم المرفق' : by(s.creator, s.created_at!),
        documents: s.proof_document_id ? [{ documentId: s.proof_document_id, versionId: s.v_id, title: s.proof_title ?? 'إثبات التقديم', category: 'other', ext: s.ext }] : [],
      });
    }
  }

  for (const d of db.all<Record<string, string | null>>(
    `SELECT d.id, d.title, d.category, d.doc_date, d.created_at, d.stage_id, u.display_name AS creator, v.id AS v_id, v.ext FROM documents d
     LEFT JOIN users u ON u.id = d.created_by LEFT JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
     WHERE d.case_id = ? AND d.hearing_id IS NULL AND d.judgment_id IS NULL AND d.memo_id IS NULL AND d.archived_at IS NULL
       AND d.id NOT IN (SELECT proof_document_id FROM memo_submissions WHERE proof_document_id IS NOT NULL)`,
    [caseId],
  )) {
    ev.push({
      key: `doc-${d.id}`,
      sortKey: d.doc_date ? dk(d.doc_date) : d.created_at!,
      at: d.doc_date ?? d.created_at!,
      isDateOnly: !!d.doc_date,
      kind: 'document',
      title: `${DOC_CATEGORIES[d.category as DocCategory]?.label ?? 'مستند'}: ${d.title}`,
      detail: d.doc_date ? null : 'تاريخ المستند غير مسجل؛ يظهر تاريخ إرفاقه',
      status: null,
      stageId: d.stage_id,
      refType: 'document',
      refId: d.id!,
      source: `مرفق بواسطة ${d.creator ?? '—'}`,
      documents: [{ documentId: d.id!, versionId: d.v_id, title: d.title!, category: d.category as DocCategory, ext: d.ext }],
    });
  }

  for (const t of db.all<Record<string, string | null>>(
    `SELECT t.id, t.title, t.completed_at, t.stage_id, u.display_name AS by_name FROM tasks t LEFT JOIN users u ON u.id = t.completed_by WHERE t.case_id = ? AND t.status = 'done' AND t.completed_at IS NOT NULL`,
    [caseId],
  )) {
    ev.push({ key: `task-${t.id}`, sortKey: t.completed_at!, at: t.completed_at!, isDateOnly: false, kind: 'task', title: `إنجاز مهمة: ${t.title}`, detail: null, status: 'done', stageId: t.stage_id, refType: 'task', refId: t.id!, source: by(t.by_name, t.completed_at!), documents: [] });
  }

  for (const r of db.all<Record<string, string | null>>(`SELECT r.* FROM related_works r WHERE r.case_id = ?`, [caseId])) {
    ev.push({
      key: `rw-${r.id}`,
      sortKey: r.opened_on ? dk(r.opened_on) : r.created_at!,
      at: r.opened_on ?? r.created_at!,
      isDateOnly: !!r.opened_on,
      kind: 'related',
      title: `عمل مرتبط: ${r.title}`,
      detail: [r.authority, r.reference_no ? `المرجع: ${r.reference_no}` : null].filter(Boolean).join(' — ') || null,
      status: r.status,
      stageId: null,
      refType: 'related_work',
      refId: r.id!,
      source: 'إدخال يدوي',
      documents: [],
    });
  }

  for (const a of db.all<Record<string, string | null>>(
    "SELECT id, at, action, summary, username FROM activity_log WHERE case_id = ? AND entity_type = 'case' AND action IN ('close','reopen','archive','unarchive')",
    [caseId],
  )) {
    ev.push({
      key: `act-${a.id}`,
      sortKey: a.at!,
      at: a.at!,
      isDateOnly: false,
      kind: a.action === 'close' ? 'close' : a.action === 'reopen' ? 'reopen' : 'archive',
      title: a.summary!,
      detail: null,
      status: null,
      stageId: null,
      refType: 'case',
      refId: caseId,
      source: `سجل الأنشطة — ${a.username ?? ''}`,
      documents: [],
    });
  }

  ev.sort((x, y) => (x.sortKey < y.sortKey ? 1 : x.sortKey > y.sortKey ? -1 : 0));
  return ev;
}
