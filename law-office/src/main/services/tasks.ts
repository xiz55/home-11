import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { todayRiyadh } from '../../shared/dates';
import { likeEscape, searchTokens } from '../../shared/text';
import { TASK_STATUSES, type Priority, type TaskStatus } from '../../shared/constants';
import { grantCase, isOwner, linkedScope, requireCase, requireCaseWritable, requireClient, requireUser } from './access';
import { logActivity } from './activity';
import { syncTaskReminder } from './reminders';

interface TaskInput {
  title: string;
  description: string | null;
  clientId: string | null;
  caseId: string | null;
  stageId: string | null;
  hearingId: string | null;
  assigneeUserId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
  status: TaskStatus;
}

function normalizeTaskLinks(ctx: Ctx, input: TaskInput): TaskInput {
  const out = { ...input };
  if (out.caseId) {
    const c = requireCaseWritable(ctx, out.caseId);
    if (out.clientId && out.clientId !== c.client_id) throw new AppError('VALIDATION', 'القضية لا تتبع العميل المختار', { caseId: 'اختيار غير صالح' });
    out.clientId = c.client_id;
  } else if (out.clientId) {
    requireClient(ctx, out.clientId, 'full');
  } else if (!isOwner(ctx)) {
    // مهمة عامة للمكتب — يتيحها المالك فقط حتى تبقى مهام المستشار ضمن ملفاته
    throw new AppError('VALIDATION', 'اختر العميل أو القضية المرتبطة بالمهمة', { caseId: 'اختر القضية أو العميل' });
  }
  if (out.hearingId) {
    const h = ctx.db.get<{ case_id: string; stage_id: string }>('SELECT case_id, stage_id FROM hearings WHERE id = ?', [out.hearingId]);
    if (!h || h.case_id !== out.caseId) throw new AppError('VALIDATION', 'الجلسة لا تتبع القضية', { hearingId: 'اختيار غير صالح' });
    if (out.stageId && out.stageId !== h.stage_id) throw new AppError('VALIDATION', 'الجلسة تتبع مرحلة أخرى', { hearingId: 'اختيار غير صالح' });
    out.stageId = h.stage_id;
  }
  if (out.stageId) {
    const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [out.stageId]);
    if (!s || s.case_id !== out.caseId) throw new AppError('VALIDATION', 'المرحلة لا تتبع القضية', { stageId: 'اختيار غير صالح' });
  }
  if (out.assigneeUserId) {
    const u = ctx.db.get<{ active: number; role: string }>('SELECT active, role FROM users WHERE id = ?', [out.assigneeUserId]);
    if (!u || !u.active) throw new AppError('VALIDATION', 'المستخدم غير متاح', { assigneeUserId: 'اختر مستخدمًا نشطًا' });
    if (!isOwner(ctx) && out.assigneeUserId !== ctx.user!.id && u.role !== 'owner') throw forbidden('إسناد المهام لمستشار آخر متاح لصاحب المكتب فقط');
  }
  return out;
}

export function createTask(ctx: Ctx, input: TaskInput) {
  requireUser(ctx);
  const t = normalizeTaskLinks(ctx, input);
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO tasks (id, title, description, client_id, case_id, stage_id, hearing_id, assignee_user_id, due_date, due_time, priority, status, completed_at, completed_by,
         created_by, created_at, updated_by, updated_at)
       VALUES (:id, :title, :description, :client_id, :case_id, :stage_id, :hearing_id, :assignee, :due_date, :due_time, :priority, :status, :completed_at, :completed_by,
         :uid, :now, :uid, :now)`,
      {
        id,
        title: t.title,
        description: t.description,
        client_id: t.clientId,
        case_id: t.caseId,
        stage_id: t.stageId,
        hearing_id: t.hearingId,
        assignee: t.assigneeUserId,
        due_date: t.dueDate,
        due_time: t.dueTime,
        priority: t.priority,
        status: t.status,
        completed_at: t.status === 'done' ? now : null,
        completed_by: t.status === 'done' ? ctx.user!.id : null,
        uid: ctx.user!.id,
        now,
      },
    );
    if (t.assigneeUserId && t.caseId) grantCase(ctx, t.assigneeUserId, t.caseId);
    syncTaskReminder(ctx, id);
    logActivity(ctx, { action: 'create', entityType: 'task', entityId: id, caseId: t.caseId, clientId: t.clientId, summary: `إضافة مهمة: ${t.title}` });
  });
  return { id };
}

function requireTask(ctx: Ctx, id: string) {
  const t = ctx.db.get<{ id: string; client_id: string | null; case_id: string | null; title: string; status: string; created_by: string; assignee_user_id: string | null }>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!t) throw notFound('المهمة');
  if (t.case_id) requireCase(ctx, t.case_id);
  else if (t.client_id) requireClient(ctx, t.client_id, 'full');
  else if (!isOwner(ctx) && t.assignee_user_id !== ctx.user!.id && t.created_by !== ctx.user!.id) throw forbidden();
  return t;
}

export function updateTask(ctx: Ctx, input: TaskInput & { id: string }) {
  requireUser(ctx);
  const old = requireTask(ctx, input.id);
  const t = normalizeTaskLinks(ctx, input);
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE tasks SET title = :title, description = :description, client_id = :client_id, case_id = :case_id, stage_id = :stage_id, hearing_id = :hearing_id,
         assignee_user_id = :assignee, due_date = :due_date, due_time = :due_time, priority = :priority, status = :status,
         completed_at = CASE WHEN :status = 'done' THEN coalesce(completed_at, :now) ELSE NULL END,
         completed_by = CASE WHEN :status = 'done' THEN coalesce(completed_by, :uid) ELSE NULL END,
         updated_by = :uid, updated_at = :now WHERE id = :id`,
      {
        id: input.id,
        title: t.title,
        description: t.description,
        client_id: t.clientId,
        case_id: t.caseId,
        stage_id: t.stageId,
        hearing_id: t.hearingId,
        assignee: t.assigneeUserId,
        due_date: t.dueDate,
        due_time: t.dueTime,
        priority: t.priority,
        status: t.status,
        uid: ctx.user!.id,
        now,
      },
    );
    if (t.assigneeUserId && t.caseId) grantCase(ctx, t.assigneeUserId, t.caseId);
    syncTaskReminder(ctx, input.id);
    logActivity(ctx, {
      action: old.status !== t.status ? 'status' : 'update',
      entityType: 'task',
      entityId: input.id,
      caseId: t.caseId,
      clientId: t.clientId,
      summary: old.status !== t.status ? `حالة المهمة «${t.title}»: ${TASK_STATUSES[t.status].label}` : `تعديل مهمة: ${t.title}`,
    });
  });
  return { ok: true };
}

export function setTaskStatus(ctx: Ctx, input: { id: string; status: TaskStatus }) {
  requireUser(ctx);
  const t = requireTask(ctx, input.id);
  if (t.case_id) requireCaseWritable(ctx, t.case_id);
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE tasks SET status = :status, completed_at = CASE WHEN :status = 'done' THEN :now ELSE NULL END, completed_by = CASE WHEN :status = 'done' THEN :uid ELSE NULL END,
        updated_by = :uid, updated_at = :now WHERE id = :id`,
      { id: input.id, status: input.status, uid: ctx.user!.id, now },
    );
    syncTaskReminder(ctx, input.id);
    logActivity(ctx, { action: 'status', entityType: 'task', entityId: input.id, caseId: t.case_id, clientId: t.client_id, summary: `حالة المهمة «${t.title}»: ${TASK_STATUSES[input.status].label}` });
  });
  return { ok: true };
}

export function listTasks(
  ctx: Ctx,
  input: { caseId?: string | null; clientId?: string | null; assigneeUserId?: string | null; status?: string; q?: string | null },
) {
  const u = requireUser(ctx);
  const scope = linkedScope(ctx, 't.client_id', 't.case_id');
  const where = [
    u.role === 'owner' ? '1=1' : `((t.client_id IS NULL AND t.case_id IS NULL AND (t.assignee_user_id = :me OR t.created_by = :me)) OR ${scope.sql})`,
  ];
  const p: Record<string, unknown> = { ...scope.params, me: u.id, today: todayRiyadh(ctx.now()) };
  if (input.caseId) {
    where.push('t.case_id = :caseId');
    p.caseId = input.caseId;
  }
  if (input.clientId) {
    where.push('t.client_id = :clientId');
    p.clientId = input.clientId;
  }
  if (input.assigneeUserId) {
    where.push('t.assignee_user_id = :assignee');
    p.assignee = input.assigneeUserId;
  }
  const st = input.status ?? 'open';
  if (st === 'open') where.push("t.status != 'done'");
  else if (st === 'overdue') where.push("t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < :today");
  else if (st !== 'all') {
    where.push('t.status = :status');
    p.status = st;
  }
  searchTokens(input.q ?? '').forEach((tok, i) => {
    where.push(`(arnorm(t.title) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(t.description,'')) LIKE :q${i} ESCAPE '\\')`);
    p[`q${i}`] = `%${likeEscape(tok)}%`;
  });
  return ctx.db
    .all<Record<string, string | null>>(
      `SELECT t.*, u.display_name AS assignee_name, c.file_no, c.title AS case_title, cl.name AS client_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = t.client_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.due_date IS NULL, t.due_date, t.due_time, t.created_at DESC LIMIT 3000`,
      p,
    )
    .map((t) => ({
      id: t.id!,
      title: t.title!,
      description: t.description,
      clientId: t.client_id,
      clientName: t.client_name,
      caseId: t.case_id,
      caseFileNo: t.file_no,
      caseTitle: t.case_title,
      stageId: t.stage_id,
      hearingId: t.hearing_id,
      hearingRequestId: t.hearing_request_id,
      assigneeUserId: t.assignee_user_id,
      assigneeName: t.assignee_name,
      dueDate: t.due_date,
      dueTime: t.due_time,
      priority: t.priority as Priority,
      status: t.status as TaskStatus,
      overdue: t.status !== 'done' && !!t.due_date && t.due_date < String(p.today),
      completedAt: t.completed_at,
      createdAt: t.created_at!,
    }));
}
