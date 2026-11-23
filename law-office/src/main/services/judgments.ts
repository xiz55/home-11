import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { JUDGMENT_FOLLOW, DEADLINE_STATUSES, type JudgmentFollow, type DeadlineStatus } from '../../shared/constants';
import { requireCase, requireCaseWritable } from './access';
import { logActivity } from './activity';
import { syncDeadlineReminder } from './reminders';

interface JudgmentInput {
  stageId: string;
  hearingId: string | null;
  judgmentNo: string | null;
  judgmentDate: string | null;
  hijriText: string | null;
  hijriSource: string | null;
  summary: string;
  followStatus: JudgmentFollow;
  notes: string | null;
}

function checkLinks(ctx: Ctx, caseId: string, stageId: string, hearingId: string | null) {
  const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [stageId]);
  if (!s || s.case_id !== caseId) throw new AppError('VALIDATION', 'المرحلة لا تتبع هذه القضية', { stageId: 'اختر مرحلة من مراحل القضية' });
  if (hearingId) {
    const h = ctx.db.get<{ case_id: string; stage_id: string }>('SELECT case_id, stage_id FROM hearings WHERE id = ?', [hearingId]);
    if (!h || h.case_id !== caseId) throw new AppError('VALIDATION', 'الجلسة لا تتبع هذه القضية', { hearingId: 'اختيار غير صالح' });
    if (h.stage_id !== stageId) throw new AppError('VALIDATION', 'الجلسة المختارة تتبع مرحلة أخرى', { hearingId: 'الجلسة من مرحلة مختلفة' });
  }
}

export function createJudgment(ctx: Ctx, input: JudgmentInput & { caseId: string }) {
  const c = requireCaseWritable(ctx, input.caseId);
  checkLinks(ctx, input.caseId, input.stageId, input.hearingId);
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO judgments (id, case_id, stage_id, hearing_id, judgment_no, judgment_date, hijri_text, hijri_source, summary, follow_status, notes,
        created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.caseId, input.stageId, input.hearingId, input.judgmentNo, input.judgmentDate, input.hijriText, input.hijriSource, input.summary, input.followStatus, input.notes, ctx.user!.id, now, ctx.user!.id, now],
    );
    logActivity(ctx, { action: 'create', entityType: 'judgment', entityId: id, caseId: input.caseId, clientId: c.client_id, summary: `تسجيل حكم${input.judgmentNo ? ' رقم ' + input.judgmentNo : ''} — ${c.file_no}` });
  });
  return { id };
}

export function updateJudgment(ctx: Ctx, input: JudgmentInput & { id: string }) {
  const j = ctx.db.get<{ case_id: string; follow_status: string }>('SELECT case_id, follow_status FROM judgments WHERE id = ?', [input.id]);
  if (!j) throw notFound('الحكم');
  const c = requireCaseWritable(ctx, j.case_id);
  checkLinks(ctx, j.case_id, input.stageId, input.hearingId);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE judgments SET stage_id = ?, hearing_id = ?, judgment_no = ?, judgment_date = ?, hijri_text = ?, hijri_source = ?, summary = ?, follow_status = ?, notes = ?,
        updated_by = ?, updated_at = ? WHERE id = ?`,
      [input.stageId, input.hearingId, input.judgmentNo, input.judgmentDate, input.hijriText, input.hijriSource, input.summary, input.followStatus, input.notes, ctx.user!.id, ctx.now().toISOString(), input.id],
    );
    logActivity(ctx, {
      action: j.follow_status !== input.followStatus ? 'status' : 'update',
      entityType: 'judgment',
      entityId: input.id,
      caseId: j.case_id,
      clientId: c.client_id,
      summary: j.follow_status !== input.followStatus ? `متابعة الحكم: ${JUDGMENT_FOLLOW[input.followStatus].label}` : 'تعديل بيانات حكم',
    });
  });
  return { ok: true };
}

export function listJudgments(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, string | null>>('SELECT * FROM judgments WHERE case_id = ? ORDER BY coalesce(judgment_date, substr(created_at,1,10))', [caseId])
    .map((j) => ({
      id: j.id!,
      caseId: j.case_id!,
      stageId: j.stage_id!,
      hearingId: j.hearing_id,
      judgmentNo: j.judgment_no,
      judgmentDate: j.judgment_date,
      hijriText: j.hijri_text,
      hijriSource: j.hijri_source,
      summary: j.summary!,
      followStatus: j.follow_status as JudgmentFollow,
      notes: j.notes,
      createdAt: j.created_at!,
      updatedAt: j.updated_at!,
    }));
}

export function listDeadlines(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, string | null>>('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_date', [caseId])
    .map((d) => ({
      id: d.id!,
      caseId: d.case_id!,
      judgmentId: d.judgment_id,
      stageId: d.stage_id,
      title: d.title!,
      dueDate: d.due_date!,
      source: d.source!,
      status: d.status as DeadlineStatus,
      notes: d.notes,
    }));
}

export function saveDeadline(
  ctx: Ctx,
  input: { id: string | null; caseId: string; judgmentId: string | null; stageId: string | null; title: string; dueDate: string; source: string; status: DeadlineStatus; notes: string | null },
) {
  const c = requireCaseWritable(ctx, input.caseId);
  if (input.judgmentId) {
    const j = ctx.db.get<{ case_id: string }>('SELECT case_id FROM judgments WHERE id = ?', [input.judgmentId]);
    if (!j || j.case_id !== input.caseId) throw new AppError('VALIDATION', 'الحكم لا يتبع هذه القضية', { judgmentId: 'اختيار غير صالح' });
  }
  if (input.stageId) {
    const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [input.stageId]);
    if (!s || s.case_id !== input.caseId) throw new AppError('VALIDATION', 'المرحلة لا تتبع هذه القضية', { stageId: 'اختيار غير صالح' });
  }
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ case_id: string; status: string }>('SELECT case_id, status FROM deadlines WHERE id = ?', [id]);
      if (!ex || ex.case_id !== input.caseId) throw notFound('الموعد');
      ctx.db.run('UPDATE deadlines SET judgment_id = ?, stage_id = ?, title = ?, due_date = ?, source = ?, status = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
        input.judgmentId,
        input.stageId,
        input.title,
        input.dueDate,
        input.source,
        input.status,
        input.notes,
        ctx.user!.id,
        now,
        id,
      ]);
    } else {
      id = uuid();
      ctx.db.run(
        `INSERT INTO deadlines (id, case_id, judgment_id, stage_id, title, due_date, source, status, notes, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.caseId, input.judgmentId, input.stageId, input.title, input.dueDate, input.source, input.status, input.notes, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    syncDeadlineReminder(ctx, id!);
    logActivity(ctx, {
      action: input.id ? 'update' : 'create',
      entityType: 'deadline',
      entityId: id,
      caseId: input.caseId,
      clientId: c.client_id,
      summary: `${input.id ? 'تعديل' : 'تسجيل'} موعد إجرائي: ${input.title} (${DEADLINE_STATUSES[input.status].label}) — المصدر: ${input.source}`,
    });
  });
  return { id };
}
