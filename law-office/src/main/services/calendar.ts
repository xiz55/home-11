import type { Ctx } from '../context';
import { addDays, riyadhToUtcIso, todayRiyadh, utcIsoToRiyadh, diffDays } from '../../shared/dates';
import { caseScope, hasPerm, requireUser } from './access';
import { officeFinanceSummary } from './finance';
import { readSetting } from './settings';
import { taskAccessSql } from './tasks';
import { apptCalendarEvents, appointmentsOverview } from './appointments';

export interface CalendarEvent {
  id: string;
  kind: 'hearing' | 'task' | 'deadline' | 'consultation' | 'meeting';
  refNo?: string | null;
  method?: string | null;
  title: string;
  date: string;
  time: string | null;
  startsAt: string | null;
  caseId: string | null;
  fileNo: string | null;
  caseTitle: string | null;
  clientId: string | null;
  clientName: string | null;
  status: string;
  confirmed: boolean;
  responsible: string | null;
  location: string | null;
  stageType: string | null;
}

export function calendarEvents(
  ctx: Ctx,
  input: { from: string; to: string; clientId?: string | null; caseId?: string | null; responsibleUserId?: string | null; includeUnconfirmed?: boolean },
): CalendarEvent[] {
  const u = requireUser(ctx);
  const scope = caseScope(ctx, 'c.id');
  const fromIso = riyadhToUtcIso(input.from, '00:00');
  const toIso = riyadhToUtcIso(addDays(input.to, 1), '00:00');
  const extra: string[] = [];
  const p: Record<string, unknown> = { ...scope.params, fromIso, toIso, from: input.from, to: input.to };
  if (input.clientId) {
    extra.push('c.client_id = :clientId');
    p.clientId = input.clientId;
  }
  if (input.caseId) {
    extra.push('c.id = :caseId');
    p.caseId = input.caseId;
  }
  const ex = extra.length ? ' AND ' + extra.join(' AND ') : '';
  const out: CalendarEvent[] = [];
  const hearingResp = input.responsibleUserId ? ' AND c.responsible_user_id = :resp' : '';
  if (input.responsibleUserId) p.resp = input.responsibleUserId;
  for (const h of ctx.db.all<Record<string, string | number | null>>(
    `SELECT h.id, h.starts_at, h.status, h.confirmed, h.location, h.attendee, c.id AS case_id, c.file_no, c.title AS case_title, cl.id AS client_id, cl.name AS client_name,
       s.stage_type, ru.display_name AS responsible
     FROM hearings h JOIN cases c ON c.id = h.case_id JOIN clients cl ON cl.id = c.client_id JOIN stages s ON s.id = h.stage_id LEFT JOIN users ru ON ru.id = c.responsible_user_id
     WHERE h.starts_at >= :fromIso AND h.starts_at < :toIso AND ${scope.sql}${ex}${hearingResp} ${input.includeUnconfirmed === false ? 'AND h.confirmed = 1' : ''}
     ORDER BY h.starts_at`,
    p,
  )) {
    const { date, time } = utcIsoToRiyadh(String(h.starts_at));
    out.push({
      id: String(h.id),
      kind: 'hearing',
      title: `جلسة: ${h.case_title}`,
      date,
      time,
      startsAt: String(h.starts_at),
      caseId: String(h.case_id),
      fileNo: String(h.file_no),
      caseTitle: String(h.case_title),
      clientId: String(h.client_id),
      clientName: String(h.client_name),
      status: String(h.status),
      confirmed: !!h.confirmed,
      responsible: (h.attendee as string) ?? (h.responsible as string),
      location: h.location as string | null,
      stageType: h.stage_type as string,
    });
  }
  const tacc = taskAccessSql(ctx);
  const tp: Record<string, unknown> = { ...tacc.params, from: input.from, to: input.to, me: u.id };
  const tex: string[] = [];
  if (input.clientId) {
    tex.push('t.client_id = :clientId');
    tp.clientId = input.clientId;
  }
  if (input.caseId) {
    tex.push('t.case_id = :caseId');
    tp.caseId = input.caseId;
  }
  if (input.responsibleUserId) {
    tex.push('t.assignee_user_id = :resp');
    tp.resp = input.responsibleUserId;
  }
  const taskAccess = tacc.sql;
  for (const t of ctx.db.all<Record<string, string | null>>(
    `SELECT t.id, t.title, t.due_date, t.due_time, t.status, t.case_id, c.file_no, c.title AS case_title, t.client_id, cl.name AS client_name, au.display_name AS assignee
     FROM tasks t LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN clients cl ON cl.id = t.client_id LEFT JOIN users au ON au.id = t.assignee_user_id
     WHERE t.due_date >= :from AND t.due_date <= :to AND ${taskAccess}${tex.length ? ' AND ' + tex.join(' AND ') : ''}
     ORDER BY t.due_date, t.due_time`,
    tp,
  )) {
    out.push({
      id: t.id!,
      kind: 'task',
      title: `مهمة: ${t.title}`,
      date: t.due_date!,
      time: t.due_time,
      startsAt: t.due_time ? riyadhToUtcIso(t.due_date!, t.due_time) : null,
      caseId: t.case_id,
      fileNo: t.file_no,
      caseTitle: t.case_title,
      clientId: t.client_id,
      clientName: t.client_name,
      status: t.status!,
      confirmed: true,
      responsible: t.assignee,
      location: null,
      stageType: null,
    });
  }
  if (!input.responsibleUserId || true) {
    for (const d of ctx.db.all<Record<string, string | null>>(
      `SELECT d.id, d.title, d.due_date, d.status, d.source, c.id AS case_id, c.file_no, c.title AS case_title, cl.id AS client_id, cl.name AS client_name, ru.display_name AS responsible
       FROM deadlines d JOIN cases c ON c.id = d.case_id JOIN clients cl ON cl.id = c.client_id LEFT JOIN users ru ON ru.id = c.responsible_user_id
       WHERE d.due_date >= :from AND d.due_date <= :to AND ${scope.sql}${ex}${hearingResp} ORDER BY d.due_date`,
      p,
    )) {
      out.push({
        id: d.id!,
        kind: 'deadline',
        title: `موعد إجرائي: ${d.title}`,
        date: d.due_date!,
        time: null,
        startsAt: null,
        caseId: d.case_id,
        fileNo: d.file_no,
        caseTitle: d.case_title,
        clientId: d.client_id,
        clientName: d.client_name,
        status: d.status!,
        confirmed: true,
        responsible: d.responsible,
        location: d.source,
        stageType: null,
      });
    }
  }
  for (const a of apptCalendarEvents(ctx, input)) {
    if (input.includeUnconfirmed === false && a.status === 'pending') continue;
    out.push({
      id: a.id,
      kind: a.kind,
      title: a.title,
      date: a.date,
      time: a.time,
      startsAt: a.startsAt,
      caseId: a.caseId,
      fileNo: null,
      caseTitle: null,
      clientId: a.clientId,
      clientName: a.clientName,
      status: a.status,
      confirmed: a.status !== 'pending',
      responsible: a.responsible,
      location: null,
      stageType: null,
      refNo: a.refNo,
      method: a.method,
    });
  }
  out.sort((a, b) => (a.date + (a.time ?? '99:99')).localeCompare(b.date + (b.time ?? '99:99')));
  return out;
}

export function upcomingForCases(ctx: Ctx, caseIds: string[], limit: number) {
  if (!caseIds.length) return [];
  const today = todayRiyadh(ctx.now());
  const nowIso = ctx.now().toISOString();
  const evs = calendarEvents(ctx, { from: today, to: addDays(today, 365) }).filter(
    (e) =>
      e.caseId &&
      e.kind !== 'consultation' &&
      e.kind !== 'meeting' &&
      caseIds.includes(e.caseId) &&
      ((e.kind === 'hearing' && e.status === 'scheduled' && (e.startsAt ?? '') >= nowIso) || (e.kind === 'task' && e.status !== 'done') || (e.kind === 'deadline' && e.status === 'open')),
  );
  return evs.slice(0, limit);
}

export function dashboard(ctx: Ctx) {
  const u = requireUser(ctx);
  const scope = caseScope(ctx, 'c.id');
  const today = todayRiyadh(ctx.now());
  const nowIso = ctx.now().toISOString();
  const activeCases = ctx.db.get<{ n: number }>(`SELECT count(*) AS n FROM cases c WHERE c.status = 'open' AND c.archived = 0 AND ${scope.sql}`, scope.params)!.n;
  const week = calendarEvents(ctx, { from: today, to: addDays(today, 14) });
  const todayHearings = week.filter((e) => e.kind === 'hearing' && e.date === today && e.status !== 'cancelled');
  const todayAppointments = week.filter((e) => (e.kind === 'consultation' || e.kind === 'meeting') && e.date === today && e.status !== 'cancelled');
  const upcoming = week.filter(
    (e) =>
      (e.kind === 'hearing' && e.status === 'scheduled' && (e.startsAt ?? '') >= nowIso) ||
      (e.kind === 'deadline' && e.status === 'open') ||
      (e.kind === 'task' && e.status !== 'done') ||
      ((e.kind === 'consultation' || e.kind === 'meeting') && (e.status === 'pending' || e.status === 'confirmed') && (e.startsAt ?? '') >= nowIso),
  );
  const tscope = taskAccessSql(ctx);
  const taskAccess = tscope.sql;
  const overdueTasks = ctx.db
    .all<Record<string, string | null>>(
      `SELECT t.id, t.title, t.due_date, t.priority, t.status, t.case_id, c.file_no, c.title AS case_title, au.display_name AS assignee FROM tasks t
       LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN users au ON au.id = t.assignee_user_id
       WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < :today AND ${taskAccess} ORDER BY t.due_date LIMIT 50`,
      { ...tscope.params, today, me: u.id },
    )
    .map((t) => ({ id: t.id!, title: t.title!, dueDate: t.due_date!, priority: t.priority!, status: t.status!, caseId: t.case_id, fileNo: t.file_no, caseTitle: t.case_title, assignee: t.assignee }));
  const openTasks = ctx.db
    .all<Record<string, string | null>>(
      `SELECT t.id, t.title, t.due_date, t.priority, t.status, t.case_id, c.file_no, c.title AS case_title, au.display_name AS assignee FROM tasks t
       LEFT JOIN cases c ON c.id = t.case_id LEFT JOIN users au ON au.id = t.assignee_user_id
       WHERE t.status != 'done' AND (t.due_date IS NULL OR t.due_date >= :today) AND ${taskAccess} ORDER BY t.due_date IS NULL, t.due_date LIMIT 15`,
      { ...tscope.params, today, me: u.id },
    )
    .map((t) => ({ id: t.id!, title: t.title!, dueDate: t.due_date, priority: t.priority!, status: t.status!, caseId: t.case_id, fileNo: t.file_no, caseTitle: t.case_title, assignee: t.assignee }));
  const needsUpdate = ctx.db
    .all<Record<string, string>>(
      `SELECT h.id, h.starts_at, c.id AS case_id, c.file_no, c.title FROM hearings h JOIN cases c ON c.id = h.case_id
       WHERE h.status = 'scheduled' AND h.starts_at < :now AND c.archived = 0 AND ${scope.sql} ORDER BY h.starts_at DESC LIMIT 20`,
      { ...scope.params, now: nowIso },
    )
    .map((h) => ({ id: h.id, startsAt: h.starts_at, caseId: h.case_id, fileNo: h.file_no, caseTitle: h.title }));
  const canFees = hasPerm(ctx, 'fees.view');
  const lastBackupAt = readSetting(ctx.db, 'backup.lastBackupAt');
  const reminderDays = readSetting(ctx.db, 'backup.reminderDays');
  const backupDue = u.role === 'owner' && (!lastBackupAt || diffDays(today, todayRiyadh(new Date(lastBackupAt))) >= reminderDays);
  return {
    today,
    counts: { activeCases, todayHearings: todayHearings.length, overdueTasks: overdueTasks.length, todayAppointments: todayAppointments.length },
    todayAppointments,
    appointments: appointmentsOverview(ctx).counts,
    finance: canFees ? officeFinanceSummary(ctx) : null,
    todayHearings,
    upcoming,
    overdueTasks,
    openTasks,
    needsUpdate,
    backup: u.role === 'owner' ? { lastBackupAt, reminderDays, due: backupDue } : null,
  };
}
