// التنبيهات المحلية: تُحسب لحظات التذكير وتُخزن؛ ويطلقها البرنامج أثناء تشغيله فقط.
import type { Ctx } from '../context';
import { uuid } from '../context';
import { riyadhToUtcIso, addDays, fmtDateTime, fmtDate } from '../../shared/dates';
import { readSetting } from './settings';
import { caseScope, requireUser } from './access';
import { reminderVisible, syncApptReminders } from './appointments';

export function clearReminders(ctx: Ctx, entityType: string, entityId: string) {
  ctx.db.run('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ? AND fired_at IS NULL AND missed_at IS NULL', [entityType, entityId]);
}

function insertReminder(ctx: Ctx, r: { entityType: string; entityId: string; caseId: string | null; remindAt: string; eventAt: string; label: string }) {
  if (new Date(r.remindAt).getTime() <= ctx.now().getTime()) return;
  ctx.db.run(
    `INSERT INTO reminders (id, entity_type, entity_id, case_id, remind_at, event_at, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), r.entityType, r.entityId, r.caseId, r.remindAt, r.eventAt, r.label, ctx.now().toISOString()],
  );
}

export function syncHearingReminders(ctx: Ctx, hearingId: string) {
  clearReminders(ctx, 'hearing', hearingId);
  if (!readSetting(ctx.db, 'reminders.enabled')) return;
  const h = ctx.db.get<{ id: string; case_id: string; starts_at: string; status: string; confirmed: number; reminder_offsets: string | null; title: string; file_no: string; archived: number }>(
    `SELECT h.id, h.case_id, h.starts_at, h.status, h.confirmed, h.reminder_offsets, c.title, c.file_no, c.archived
     FROM hearings h JOIN cases c ON c.id = h.case_id WHERE h.id = ?`,
    [hearingId],
  );
  if (!h || h.status !== 'scheduled' || !h.confirmed || h.archived) return;
  let offsets: number[] = readSetting(ctx.db, 'reminders.hearingOffsets');
  if (h.reminder_offsets) {
    try {
      offsets = JSON.parse(h.reminder_offsets);
    } catch {
      /* الافتراضي */
    }
  }
  const t = new Date(h.starts_at).getTime();
  for (const off of [...new Set(offsets)]) {
    const label = off >= 1440 && off % 1440 === 0 ? `قبل ${off / 1440 === 1 ? 'يوم' : off / 1440 + ' أيام'}` : off >= 60 && off % 60 === 0 ? `قبل ${off / 60} ساعة` : `قبل ${off} دقيقة`;
    insertReminder(ctx, {
      entityType: 'hearing',
      entityId: h.id,
      caseId: h.case_id,
      remindAt: new Date(t - off * 60_000).toISOString(),
      eventAt: h.starts_at,
      label: `جلسة ${h.title} (${h.file_no}) — ${fmtDateTime(h.starts_at)} — تذكير ${label}`,
    });
  }
}

export function syncTaskReminder(ctx: Ctx, taskId: string) {
  clearReminders(ctx, 'task', taskId);
  if (!readSetting(ctx.db, 'reminders.enabled')) return;
  const t = ctx.db.get<{ id: string; case_id: string | null; title: string; due_date: string | null; due_time: string | null; status: string }>(
    'SELECT id, case_id, title, due_date, due_time, status FROM tasks WHERE id = ?',
    [taskId],
  );
  if (!t || t.status === 'done' || !t.due_date) return;
  const time = t.due_time ?? readSetting(ctx.db, 'reminders.taskTime');
  const at = riyadhToUtcIso(t.due_date, time);
  insertReminder(ctx, { entityType: 'task', entityId: t.id, caseId: t.case_id, remindAt: at, eventAt: at, label: `مهمة مستحقة: ${t.title} — ${fmtDate(t.due_date)}` });
}

export function syncDeadlineReminder(ctx: Ctx, deadlineId: string) {
  clearReminders(ctx, 'deadline', deadlineId);
  if (!readSetting(ctx.db, 'reminders.enabled')) return;
  const d = ctx.db.get<{ id: string; case_id: string; title: string; due_date: string; status: string }>(
    'SELECT id, case_id, title, due_date, status FROM deadlines WHERE id = ?',
    [deadlineId],
  );
  if (!d || d.status !== 'open') return;
  const time = readSetting(ctx.db, 'reminders.taskTime');
  const eventAt = riyadhToUtcIso(d.due_date, time);
  insertReminder(ctx, { entityType: 'deadline', entityId: d.id, caseId: d.case_id, remindAt: riyadhToUtcIso(addDays(d.due_date, -2), time), eventAt, label: `موعد إجرائي بعد يومين: ${d.title} — ${fmtDate(d.due_date)}` });
  insertReminder(ctx, { entityType: 'deadline', entityId: d.id, caseId: d.case_id, remindAt: eventAt, eventAt, label: `موعد إجرائي اليوم: ${d.title}` });
}

/** يعلّم التذكيرات التي فات وقتها أثناء إغلاق البرنامج بأنها فائتة. */
export function markMissed(ctx: Ctx, graceMs = 5 * 60_000): number {
  const cutoff = new Date(ctx.now().getTime() - graceMs).toISOString();
  return ctx.db.run('UPDATE reminders SET missed_at = ? WHERE fired_at IS NULL AND missed_at IS NULL AND remind_at < ?', [ctx.now().toISOString(), cutoff]).changes;
}

/** التذكيرات المستحقة الآن (تُعلَّم كمُطلقة). */
export function takeDueReminders(ctx: Ctx): { id: string; label: string; caseId: string | null; entityType: string; entityId: string }[] {
  markMissed(ctx);
  const nowIso = ctx.now().toISOString();
  const due = ctx.db.all<{ id: string; label: string; case_id: string | null; entity_type: string; entity_id: string }>(
    'SELECT id, label, case_id, entity_type, entity_id FROM reminders WHERE fired_at IS NULL AND missed_at IS NULL AND remind_at <= ? ORDER BY remind_at',
    [nowIso],
  );
  if (due.length) {
    ctx.db.tx(() => {
      for (const r of due) ctx.db.run('UPDATE reminders SET fired_at = ? WHERE id = ?', [nowIso, r.id]);
    });
  }
  return due.map((r) => ({ id: r.id, label: r.label, caseId: r.case_id, entityType: r.entity_type, entityId: r.entity_id }));
}

/** التذكيرات الفائتة غير المقروءة — تُعرض بعد الدخول. */
export function missedReminders(ctx: Ctx) {
  requireUser(ctx);
  const scope = caseScope(ctx, 'r.case_id');
  return ctx.db
    .all<{ id: string; label: string; remind_at: string; event_at: string; case_id: string | null; entity_type: string; entity_id: string }>(
      `SELECT r.id, r.label, r.remind_at, r.event_at, r.case_id, r.entity_type, r.entity_id FROM reminders r
       WHERE (r.missed_at IS NOT NULL OR r.fired_at IS NOT NULL) AND r.acknowledged_at IS NULL AND (r.case_id IS NULL OR ${scope.sql})
       ORDER BY r.remind_at DESC LIMIT 200`,
      scope.params,
    )
    .filter((r) => reminderVisible(ctx, r.entity_type, r.entity_id))
    .slice(0, 100)
    .map((r) => ({ id: r.id, label: r.label, remindAt: r.remind_at, eventAt: r.event_at, caseId: r.case_id, entityType: r.entity_type, entityId: r.entity_id }));
}

export function acknowledgeReminders(ctx: Ctx, input: { ids: string[] }) {
  requireUser(ctx);
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    for (const id of input.ids) ctx.db.run('UPDATE reminders SET acknowledged_at = ? WHERE id = ?', [now, id]);
  });
  return { ok: true };
}

/** إعادة بناء كل التذكيرات (بعد تغيير الإعدادات أو الاستعادة). */
export function rebuildAllReminders(ctx: Ctx) {
  const nowIso = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM reminders WHERE fired_at IS NULL AND missed_at IS NULL');
    for (const h of ctx.db.all<{ id: string }>("SELECT id FROM hearings WHERE status = 'scheduled' AND starts_at > ?", [nowIso])) syncHearingReminders(ctx, h.id);
    for (const t of ctx.db.all<{ id: string }>("SELECT id FROM tasks WHERE status != 'done' AND due_date IS NOT NULL")) syncTaskReminder(ctx, t.id);
    for (const d of ctx.db.all<{ id: string }>("SELECT id FROM deadlines WHERE status = 'open'")) syncDeadlineReminder(ctx, d.id);
    for (const k of ctx.db.all<{ id: string }>("SELECT id FROM consultations WHERE status IN ('pending','confirmed') AND starts_at > ?", [nowIso])) syncApptReminders(ctx, 'consultation', k.id);
    for (const m of ctx.db.all<{ id: string }>("SELECT id FROM meetings WHERE status IN ('pending','confirmed') AND starts_at > ?", [nowIso])) syncApptReminders(ctx, 'meeting', m.id);
  });
}
