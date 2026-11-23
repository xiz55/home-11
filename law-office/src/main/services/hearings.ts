import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { riyadhToUtcIso, utcIsoToRiyadh, fmtDateTime } from '../../shared/dates';
import { HEARING_STATUSES, type HearingStatus, type Priority } from '../../shared/constants';
import { requireCase, requireCaseWritable, grantCase } from './access';
import { logActivity } from './activity';
import { syncHearingReminders, syncTaskReminder } from './reminders';

interface HearingInput {
  stageId: string;
  date: string;
  time: string;
  hijriText: string | null;
  hijriSource: string | null;
  location: string | null;
  attendanceLink: string | null;
  status: HearingStatus;
  confirmed: boolean;
  attendee: string | null;
  summary: string | null;
  outcome: string | null;
  officeCommitments: string | null;
  nextHearingId: string | null;
  reminderOffsets?: number[] | null;
}

function checkStage(ctx: Ctx, caseId: string, stageId: string) {
  const s = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [stageId]);
  if (!s || s.case_id !== caseId) throw new AppError('VALIDATION', 'المرحلة المختارة لا تتبع هذه القضية', { stageId: 'اختر مرحلة من مراحل القضية' });
}
function checkHearingInCase(ctx: Ctx, caseId: string, hearingId: string | null, field: string) {
  if (!hearingId) return;
  const h = ctx.db.get<{ case_id: string }>('SELECT case_id FROM hearings WHERE id = ?', [hearingId]);
  if (!h || h.case_id !== caseId) throw new AppError('VALIDATION', 'الجلسة المختارة لا تتبع هذه القضية', { [field]: 'اختيار غير صالح' });
}

function hearingParams(input: HearingInput) {
  return {
    stage_id: input.stageId,
    starts_at: riyadhToUtcIso(input.date, input.time),
    hijri_text: input.hijriText,
    hijri_source: input.hijriSource,
    location: input.location,
    attendance_link: input.attendanceLink,
    status: input.status,
    confirmed: input.confirmed,
    attendee: input.attendee,
    summary: input.summary,
    outcome: input.outcome,
    office_commitments: input.officeCommitments,
    next_hearing_id: input.nextHearingId,
    reminder_offsets: input.reminderOffsets ? JSON.stringify(input.reminderOffsets) : null,
  };
}

export function createHearing(ctx: Ctx, input: HearingInput & { caseId: string; previousHearingId: string | null }) {
  const c = requireCaseWritable(ctx, input.caseId);
  checkStage(ctx, input.caseId, input.stageId);
  checkHearingInCase(ctx, input.caseId, input.nextHearingId, 'nextHearingId');
  checkHearingInCase(ctx, input.caseId, input.previousHearingId, 'previousHearingId');
  const id = uuid();
  const now = ctx.now().toISOString();
  const p = hearingParams(input);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO hearings (id, case_id, stage_id, starts_at, hijri_text, hijri_source, location, attendance_link, status, confirmed, attendee, summary, outcome,
        office_commitments, next_hearing_id, reminder_offsets, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :case_id, :stage_id, :starts_at, :hijri_text, :hijri_source, :location, :attendance_link, :status, :confirmed, :attendee, :summary, :outcome,
        :office_commitments, :next_hearing_id, :reminder_offsets, :uid, :now, :uid, :now)`,
      { id, case_id: input.caseId, ...p, uid: ctx.user!.id, now },
    );
    if (input.previousHearingId) {
      ctx.db.run('UPDATE hearings SET next_hearing_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', [id, ctx.user!.id, now, input.previousHearingId]);
    }
    syncHearingReminders(ctx, id);
    logActivity(ctx, {
      action: 'create',
      entityType: 'hearing',
      entityId: id,
      caseId: input.caseId,
      clientId: c.client_id,
      summary: `إضافة جلسة ${fmtDateTime(p.starts_at)}${input.confirmed ? '' : ' (غير مؤكدة)'} — ${c.file_no}`,
    });
  });
  return { id };
}

export function updateHearing(ctx: Ctx, input: HearingInput & { id: string; changeReason: string | null }) {
  const old = ctx.db.get<Record<string, string | number | null> & { case_id: string; starts_at: string; status: string; confirmed: number }>('SELECT * FROM hearings WHERE id = ?', [input.id]);
  if (!old) throw notFound('الجلسة');
  const c = requireCaseWritable(ctx, old.case_id);
  checkStage(ctx, old.case_id, input.stageId);
  checkHearingInCase(ctx, old.case_id, input.nextHearingId, 'nextHearingId');
  if (input.nextHearingId === input.id) throw new AppError('VALIDATION', 'لا يمكن ربط الجلسة بنفسها', { nextHearingId: 'اختيار غير صالح' });
  const p = hearingParams(input);
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE hearings SET stage_id = :stage_id, starts_at = :starts_at, hijri_text = :hijri_text, hijri_source = :hijri_source, location = :location,
        attendance_link = :attendance_link, status = :status, confirmed = :confirmed, attendee = :attendee, summary = :summary, outcome = :outcome,
        office_commitments = :office_commitments, next_hearing_id = :next_hearing_id, reminder_offsets = :reminder_offsets, updated_by = :uid, updated_at = :now
       WHERE id = :id`,
      { id: input.id, ...p, uid: ctx.user!.id, now },
    );
    const changes: [string, string | null, string | null][] = [];
    if (old.starts_at !== p.starts_at) changes.push(['starts_at', old.starts_at, p.starts_at]);
    if (old.status !== p.status) changes.push(['status', old.status, p.status]);
    if (!!old.confirmed !== !!p.confirmed) changes.push(['confirmed', old.confirmed ? 'مؤكد' : 'غير مؤكد', p.confirmed ? 'مؤكد' : 'غير مؤكد']);
    if ((old.location ?? null) !== p.location) changes.push(['location', (old.location as string) ?? null, p.location]);
    for (const [field, ov, nv] of changes) {
      ctx.db.run('INSERT INTO hearing_changes (id, hearing_id, field, old_value, new_value, reason, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        uuid(),
        input.id,
        field,
        ov,
        nv,
        input.changeReason,
        ctx.user!.id,
        now,
      ]);
    }
    syncHearingReminders(ctx, input.id);
    const rescheduled = old.starts_at !== p.starts_at;
    logActivity(ctx, {
      action: rescheduled ? 'reschedule' : old.status !== p.status ? 'status' : 'update',
      entityType: 'hearing',
      entityId: input.id,
      caseId: old.case_id,
      clientId: c.client_id,
      summary: rescheduled
        ? `تعديل موعد جلسة من ${fmtDateTime(old.starts_at)} إلى ${fmtDateTime(p.starts_at)}${input.changeReason ? ' — ' + input.changeReason : ''}`
        : old.status !== p.status
          ? `حالة الجلسة: ${HEARING_STATUSES[p.status as HearingStatus].label}`
          : `تعديل بيانات جلسة ${fmtDateTime(p.starts_at)}`,
    });
  });
  return { ok: true };
}

export function mapHearing(h: Record<string, unknown>) {
  const { date, time } = utcIsoToRiyadh(String(h.starts_at));
  let offsets: number[] | null = null;
  try {
    offsets = h.reminder_offsets ? JSON.parse(String(h.reminder_offsets)) : null;
  } catch {
    offsets = null;
  }
  return {
    id: String(h.id),
    caseId: String(h.case_id),
    stageId: String(h.stage_id),
    startsAt: String(h.starts_at),
    date,
    time,
    hijriText: (h.hijri_text as string) ?? null,
    hijriSource: (h.hijri_source as string) ?? null,
    location: (h.location as string) ?? null,
    attendanceLink: (h.attendance_link as string) ?? null,
    status: h.status as HearingStatus,
    confirmed: !!h.confirmed,
    attendee: (h.attendee as string) ?? null,
    summary: (h.summary as string) ?? null,
    outcome: (h.outcome as string) ?? null,
    officeCommitments: (h.office_commitments as string) ?? null,
    nextHearingId: (h.next_hearing_id as string) ?? null,
    reminderOffsets: offsets,
    updatedAt: String(h.updated_at),
  };
}

export function listHearingsForCase(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, unknown>>(
      `SELECT h.*, (SELECT count(*) FROM documents d WHERE d.hearing_id = h.id AND d.category = 'minutes' AND d.archived_at IS NULL) AS minutes_count,
              (SELECT count(*) FROM hearing_requests r WHERE r.hearing_id = h.id) AS request_count
       FROM hearings h WHERE h.case_id = ? ORDER BY h.starts_at`,
      [caseId],
    )
    .map((h) => ({ ...mapHearing(h), minutesCount: Number(h.minutes_count), requestCount: Number(h.request_count) }));
}

export function getHearing(ctx: Ctx, input: { id: string }) {
  const h = ctx.db.get<Record<string, unknown> & { case_id: string }>('SELECT * FROM hearings WHERE id = ?', [input.id]);
  if (!h) throw notFound('الجلسة');
  requireCase(ctx, h.case_id);
  const requests = ctx.db
    .all<{ id: string; text: string; requested_by: string | null; due_date: string | null; task_id: string | null; task_status: string | null; task_title: string | null }>(
      `SELECT r.id, r.text, r.requested_by, r.due_date, r.task_id, t.status AS task_status, t.title AS task_title
       FROM hearing_requests r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.hearing_id = ? ORDER BY r.created_at`,
      [input.id],
    )
    .map((r) => ({ id: r.id, text: r.text, requestedBy: r.requested_by, dueDate: r.due_date, taskId: r.task_id, taskStatus: r.task_status, taskTitle: r.task_title }));
  const changes = ctx.db
    .all<{ id: string; field: string; old_value: string | null; new_value: string | null; reason: string | null; changed_at: string; by: string | null }>(
      `SELECT hc.id, hc.field, hc.old_value, hc.new_value, hc.reason, hc.changed_at, u.display_name AS by FROM hearing_changes hc
       LEFT JOIN users u ON u.id = hc.changed_by WHERE hc.hearing_id = ? ORDER BY hc.changed_at DESC`,
      [input.id],
    )
    .map((c) => ({ id: c.id, field: c.field, oldValue: c.old_value, newValue: c.new_value, reason: c.reason, changedAt: c.changed_at, by: c.by }));
  const stage = ctx.db.get<{ stage_type: string; court_name: string | null; official_case_no: string | null }>('SELECT stage_type, court_name, official_case_no FROM stages WHERE id = ?', [h.stage_id as string]);
  const previous = ctx.db.get<{ id: string; starts_at: string }>('SELECT id, starts_at FROM hearings WHERE next_hearing_id = ?', [input.id]);
  const next = h.next_hearing_id ? ctx.db.get<{ id: string; starts_at: string; status: string }>('SELECT id, starts_at, status FROM hearings WHERE id = ?', [h.next_hearing_id as string]) : null;
  return {
    hearing: mapHearing(h),
    stage: stage ? { stageType: stage.stage_type, courtName: stage.court_name, officialCaseNo: stage.official_case_no } : null,
    requests,
    changes,
    previous: previous ? { id: previous.id, startsAt: previous.starts_at } : null,
    next: next ? { id: next.id, startsAt: next.starts_at, status: next.status } : null,
  };
}

export function saveHearingRequest(ctx: Ctx, input: { id: string | null; hearingId: string; text: string; requestedBy: string | null; dueDate: string | null }) {
  const h = ctx.db.get<{ case_id: string }>('SELECT case_id FROM hearings WHERE id = ?', [input.hearingId]);
  if (!h) throw notFound('الجلسة');
  const c = requireCaseWritable(ctx, h.case_id);
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ hearing_id: string }>('SELECT hearing_id FROM hearing_requests WHERE id = ?', [id]);
      if (!ex || ex.hearing_id !== input.hearingId) throw notFound('الطلب');
      ctx.db.run('UPDATE hearing_requests SET text = ?, requested_by = ?, due_date = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.text, input.requestedBy, input.dueDate, ctx.user!.id, now, id]);
    } else {
      id = uuid();
      ctx.db.run(
        `INSERT INTO hearing_requests (id, hearing_id, case_id, text, requested_by, due_date, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.hearingId, h.case_id, input.text, input.requestedBy, input.dueDate, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'hearing_request', entityId: id, caseId: h.case_id, clientId: c.client_id, summary: `طلب في جلسة: ${input.text.slice(0, 120)}` });
  });
  return { id };
}

export function removeHearingRequest(ctx: Ctx, input: { id: string }) {
  const r = ctx.db.get<{ case_id: string; task_id: string | null; text: string }>('SELECT case_id, task_id, text FROM hearing_requests WHERE id = ?', [input.id]);
  if (!r) throw notFound('الطلب');
  const c = requireCaseWritable(ctx, r.case_id);
  if (r.task_id) throw new AppError('CONFLICT', 'هذا الطلب مرتبط بمهمة. لا يُحذف حفاظًا على الأثر.');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM hearing_requests WHERE id = ?', [input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'hearing_request', entityId: input.id, caseId: r.case_id, clientId: c.client_id, summary: `حذف طلب جلسة: ${r.text.slice(0, 120)}` });
  });
  return { ok: true };
}

/** تحويل طلب ورد في جلسة إلى مهمة مع بقاء الرابط بالجلسة. */
export function requestToTask(ctx: Ctx, input: { requestId: string; title: string; assigneeUserId: string | null; dueDate: string | null; priority: Priority }) {
  const r = ctx.db.get<{ id: string; hearing_id: string; case_id: string; text: string; task_id: string | null; due_date: string | null }>('SELECT * FROM hearing_requests WHERE id = ?', [input.requestId]);
  if (!r) throw notFound('الطلب');
  const c = requireCaseWritable(ctx, r.case_id);
  if (r.task_id) throw new AppError('CONFLICT', 'تم تحويل هذا الطلب إلى مهمة مسبقًا');
  if (input.assigneeUserId) {
    const u = ctx.db.get<{ active: number }>('SELECT active FROM users WHERE id = ?', [input.assigneeUserId]);
    if (!u || !u.active) throw new AppError('VALIDATION', 'المستخدم غير متاح', { assigneeUserId: 'اختر مستخدمًا نشطًا' });
    if (ctx.user!.role !== 'owner' && input.assigneeUserId !== ctx.user!.id) {
      // المستشار يسند لنفسه أو لصاحب المكتب فقط
      const role = ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', [input.assigneeUserId]);
      if (role?.role !== 'owner') throw new AppError('FORBIDDEN', 'إسناد المهام لمستشار آخر متاح لصاحب المكتب فقط');
    }
  }
  const h = ctx.db.get<{ stage_id: string }>('SELECT stage_id FROM hearings WHERE id = ?', [r.hearing_id])!;
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO tasks (id, title, description, client_id, case_id, stage_id, hearing_id, hearing_request_id, assignee_user_id, due_date, priority, status,
        created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, input.title, `طلب ورد في الجلسة: ${r.text}`, c.client_id, r.case_id, h.stage_id, r.hearing_id, r.id, input.assigneeUserId, input.dueDate ?? r.due_date, input.priority, ctx.user!.id, now, ctx.user!.id, now],
    );
    ctx.db.run('UPDATE hearing_requests SET task_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', [id, ctx.user!.id, now, r.id]);
    if (input.assigneeUserId) grantCase(ctx, input.assigneeUserId, r.case_id);
    syncTaskReminder(ctx, id);
    logActivity(ctx, { action: 'create', entityType: 'task', entityId: id, caseId: r.case_id, clientId: c.client_id, summary: `تحويل طلب جلسة إلى مهمة: ${input.title}` });
  });
  return { id };
}
