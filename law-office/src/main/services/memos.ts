import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { MEMO_STATUSES, type MemoStatus, type MemoType } from '../../shared/constants';
import { requireCase, requireCaseWritable } from './access';
import { logActivity } from './activity';

interface MemoInput {
  stageId: string | null;
  hearingId: string | null;
  title: string;
  memoType: MemoType;
  body: string | null;
}

function checkLinks(ctx: Ctx, caseId: string, stageId: string | null, hearingId: string | null) {
  if (stageId) {
    const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [stageId]);
    if (!s || s.case_id !== caseId) throw new AppError('VALIDATION', 'المرحلة لا تتبع هذه القضية', { stageId: 'اختيار غير صالح' });
  }
  if (hearingId) {
    const h = ctx.db.get<{ case_id: string; stage_id: string }>('SELECT case_id, stage_id FROM hearings WHERE id = ?', [hearingId]);
    if (!h || h.case_id !== caseId) throw new AppError('VALIDATION', 'الجلسة لا تتبع هذه القضية', { hearingId: 'اختيار غير صالح' });
    if (stageId && h.stage_id !== stageId) throw new AppError('VALIDATION', 'الجلسة تتبع مرحلة مختلفة عن المرحلة المختارة', { hearingId: 'الجلسة من مرحلة مختلفة' });
  }
}

function snapshot(ctx: Ctx, memoId: string, note: string) {
  const m = ctx.db.get<{ status: string; title: string; body: string | null }>('SELECT status, title, body FROM memos WHERE id = ?', [memoId])!;
  ctx.db.run('INSERT INTO memo_revisions (id, memo_id, status, title, body, note, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    uuid(),
    memoId,
    m.status,
    m.title,
    m.body,
    note,
    ctx.user!.id,
    ctx.now().toISOString(),
  ]);
}

export function createMemo(ctx: Ctx, input: MemoInput & { caseId: string }) {
  const c = requireCaseWritable(ctx, input.caseId);
  checkLinks(ctx, input.caseId, input.stageId, input.hearingId);
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO memos (id, case_id, stage_id, hearing_id, title, memo_type, body, status, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [id, input.caseId, input.stageId, input.hearingId, input.title, input.memoType, input.body, ctx.user!.id, now, ctx.user!.id, now],
    );
    logActivity(ctx, { action: 'create', entityType: 'memo', entityId: id, caseId: input.caseId, clientId: c.client_id, summary: `إنشاء مذكرة (مسودة): ${input.title}` });
  });
  return { id, updatedAt: now };
}

export function updateMemo(ctx: Ctx, input: MemoInput & { id: string; baseUpdatedAt?: string | null }) {
  const m = ctx.db.get<{ case_id: string; status: string; updated_at: string; title: string }>('SELECT case_id, status, updated_at, title FROM memos WHERE id = ?', [input.id]);
  if (!m) throw notFound('المذكرة');
  const c = requireCaseWritable(ctx, m.case_id);
  checkLinks(ctx, m.case_id, input.stageId, input.hearingId);
  if (input.baseUpdatedAt && input.baseUpdatedAt !== m.updated_at)
    throw new AppError('CONFLICT', 'عُدّلت المذكرة من مكان آخر بعد فتحها. انسخ نصك ثم أعد فتح المذكرة.');
  if (m.status === 'submitted') {
    const cur = ctx.db.get<{ body: string | null }>('SELECT body FROM memos WHERE id = ?', [input.id])!;
    if ((cur.body ?? null) !== (input.body ?? null))
      throw new AppError('CONFLICT', 'المذكرة مسجلة كمقدمة للجهة؛ لا يُعدّل نصها حفاظًا على ما قُدّم. أنشئ نسخة مسودة جديدة منها.');
  }
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE memos SET stage_id = ?, hearing_id = ?, title = ?, memo_type = ?, body = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      input.stageId,
      input.hearingId,
      input.title,
      input.memoType,
      input.body,
      ctx.user!.id,
      now,
      input.id,
    ]);
    logActivity(ctx, { action: 'update', entityType: 'memo', entityId: input.id, caseId: m.case_id, clientId: c.client_id, summary: `حفظ المذكرة: ${input.title}` });
  });
  return { ok: true, updatedAt: now };
}

export function setMemoStatus(ctx: Ctx, input: { id: string; status: 'draft' | 'review' | 'approved' }) {
  const m = ctx.db.get<{ case_id: string; status: string; title: string }>('SELECT case_id, status, title FROM memos WHERE id = ?', [input.id]);
  if (!m) throw notFound('المذكرة');
  const c = requireCaseWritable(ctx, m.case_id);
  if (m.status === 'submitted') throw new AppError('CONFLICT', 'المذكرة مسجلة كمقدمة؛ لا تعود لحالة سابقة. أنشئ نسخة جديدة عند الحاجة.');
  if (m.status === input.status) return { ok: true };
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE memos SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.status, ctx.user!.id, now, input.id]);
    snapshot(ctx, input.id, `تغيير الحالة إلى ${MEMO_STATUSES[input.status].label}`);
    logActivity(ctx, { action: 'status', entityType: 'memo', entityId: input.id, caseId: m.case_id, clientId: c.client_id, summary: `حالة المذكرة «${m.title}»: ${MEMO_STATUSES[input.status].label}` });
  });
  return { ok: true };
}

/** تسجيل تقديم المذكرة للجهة — سجل مستقل يتطلب تاريخ التقديم؛ الحفظ أو الاعتماد الداخلي لا يكفي. */
export function recordSubmission(
  ctx: Ctx,
  input: { memoId: string; submittedOn: string; authority: string | null; referenceNo: string | null; proofDocumentId: string | null; notes: string | null },
) {
  const m = ctx.db.get<{ case_id: string; status: string; title: string }>('SELECT case_id, status, title FROM memos WHERE id = ?', [input.memoId]);
  if (!m) throw notFound('المذكرة');
  const c = requireCaseWritable(ctx, m.case_id);
  if (input.proofDocumentId) {
    const d = ctx.db.get<{ case_id: string | null }>('SELECT case_id FROM documents WHERE id = ?', [input.proofDocumentId]);
    if (!d || d.case_id !== m.case_id) throw new AppError('VALIDATION', 'مستند الإثبات لا يتبع هذه القضية', { proofDocumentId: 'اختيار غير صالح' });
  }
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO memo_submissions (id, memo_id, submitted_on, authority, reference_no, proof_document_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, input.memoId, input.submittedOn, input.authority, input.referenceNo, input.proofDocumentId, input.notes, ctx.user!.id, now],
    );
    ctx.db.run("UPDATE memos SET status = 'submitted', updated_by = ?, updated_at = ? WHERE id = ?", [ctx.user!.id, now, input.memoId]);
    snapshot(ctx, input.memoId, `تسجيل تقديم بتاريخ ${input.submittedOn}`);
    logActivity(ctx, {
      action: 'submission',
      entityType: 'memo',
      entityId: input.memoId,
      caseId: m.case_id,
      clientId: c.client_id,
      summary: `تسجيل تقديم المذكرة «${m.title}» بتاريخ ${input.submittedOn}${input.authority ? ' إلى ' + input.authority : ''}`,
    });
  });
  return { id };
}

export function duplicateMemo(ctx: Ctx, input: { id: string }) {
  const m = ctx.db.get<{ case_id: string; stage_id: string | null; hearing_id: string | null; title: string; memo_type: MemoType; body: string | null }>('SELECT * FROM memos WHERE id = ?', [input.id]);
  if (!m) throw notFound('المذكرة');
  return createMemo(ctx, { caseId: m.case_id, stageId: m.stage_id, hearingId: m.hearing_id, title: `${m.title} (نسخة جديدة)`, memoType: m.memo_type, body: m.body });
}

export function listMemos(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, string | null> & { submission_count: number }>(
      `SELECT m.id, m.case_id, m.stage_id, m.hearing_id, m.title, m.memo_type, m.status, m.created_at, m.updated_at, u.display_name AS updated_by_name,
         (SELECT count(*) FROM memo_submissions s WHERE s.memo_id = m.id) AS submission_count,
         (SELECT max(submitted_on) FROM memo_submissions s WHERE s.memo_id = m.id) AS last_submitted_on,
         length(coalesce(m.body,'')) AS body_length
       FROM memos m LEFT JOIN users u ON u.id = m.updated_by WHERE m.case_id = ? ORDER BY m.created_at`,
      [caseId],
    )
    .map((m) => ({
      id: m.id!,
      caseId: m.case_id!,
      stageId: m.stage_id,
      hearingId: m.hearing_id,
      title: m.title!,
      memoType: m.memo_type as MemoType,
      status: m.status as MemoStatus,
      createdAt: m.created_at!,
      updatedAt: m.updated_at!,
      updatedByName: m.updated_by_name,
      submissionCount: Number(m.submission_count),
      lastSubmittedOn: m.last_submitted_on,
      bodyLength: Number(m.body_length),
    }));
}

export function getMemo(ctx: Ctx, input: { id: string }) {
  const m = ctx.db.get<Record<string, string | null>>(
    `SELECT m.*, u.display_name AS updated_by_name, cu.display_name AS created_by_name FROM memos m
     LEFT JOIN users u ON u.id = m.updated_by LEFT JOIN users cu ON cu.id = m.created_by WHERE m.id = ?`,
    [input.id],
  );
  if (!m) throw notFound('المذكرة');
  requireCase(ctx, m.case_id!);
  const submissions = ctx.db
    .all<Record<string, string | null>>(
      `SELECT s.*, u.display_name AS by_name, d.title AS proof_title FROM memo_submissions s LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN documents d ON d.id = s.proof_document_id WHERE s.memo_id = ? ORDER BY s.submitted_on`,
      [input.id],
    )
    .map((s) => ({ id: s.id!, submittedOn: s.submitted_on!, authority: s.authority, referenceNo: s.reference_no, proofDocumentId: s.proof_document_id, proofTitle: s.proof_title, notes: s.notes, byName: s.by_name, createdAt: s.created_at! }));
  const revisions = ctx.db
    .all<Record<string, string | null>>(
      'SELECT r.id, r.status, r.title, r.note, r.saved_at, u.display_name AS by_name, length(coalesce(r.body,\'\')) AS len FROM memo_revisions r LEFT JOIN users u ON u.id = r.saved_by WHERE r.memo_id = ? ORDER BY r.saved_at DESC',
      [input.id],
    )
    .map((r) => ({ id: r.id!, status: r.status as MemoStatus, title: r.title!, note: r.note, savedAt: r.saved_at!, byName: r.by_name, length: Number(r.len) }));
  return {
    memo: {
      id: m.id!,
      caseId: m.case_id!,
      stageId: m.stage_id,
      hearingId: m.hearing_id,
      title: m.title!,
      memoType: m.memo_type as MemoType,
      body: m.body,
      status: m.status as MemoStatus,
      createdAt: m.created_at!,
      createdByName: m.created_by_name,
      updatedAt: m.updated_at!,
      updatedByName: m.updated_by_name,
    },
    submissions,
    revisions,
  };
}

export function getMemoRevision(ctx: Ctx, input: { id: string }) {
  const r = ctx.db.get<{ memo_id: string; body: string | null; title: string; status: string; saved_at: string }>('SELECT memo_id, body, title, status, saved_at FROM memo_revisions WHERE id = ?', [input.id]);
  if (!r) throw notFound('النسخة');
  const m = ctx.db.get<{ case_id: string }>('SELECT case_id FROM memos WHERE id = ?', [r.memo_id])!;
  requireCase(ctx, m.case_id);
  return { title: r.title, body: r.body, status: r.status, savedAt: r.saved_at };
}
