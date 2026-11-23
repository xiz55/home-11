import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { likeEscape, searchTokens } from '../../shared/text';
import { todayRiyadh } from '../../shared/dates';
import { FOLLOW_STATUSES, STAGE_STATUSES, type FollowStatus, type Priority, type StageStatus, type RelatedWorkKind, type RelatedWorkStatus } from '../../shared/constants';
import {
  canAccessCase,
  caseScope,
  clientAccess,
  grantCase,
  hasPerm,
  isOwner,
  requireCase,
  requireCaseWritable,
  requirePerm,
  requireUser,
} from './access';
import { logActivity } from './activity';
import { currentStageOf, lastActionOf, nextEventOf } from './overview';

interface CaseInput {
  clientId: string;
  title: string;
  caseType: string | null;
  subject: string | null;
  requests: string | null;
  claimAmount: number | null;
  openedOn: string | null;
  responsibleUserId: string | null;
  followStatus: FollowStatus;
  priority: Priority;
  notes: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
}
interface PartyInput {
  id: string | null;
  name: string;
  role: string | null;
  isOpponent: boolean;
  idNumber: string | null;
  representative: string | null;
  notes: string | null;
}
interface StageInput {
  stageType: string;
  courtType: string | null;
  courtName: string | null;
  circuit: string | null;
  officialCaseNo: string | null;
  startedOn: string | null;
  endedOn: string | null;
  status: StageStatus;
  previousStageId: string | null;
  notes: string | null;
}

function nextFileNo(ctx: Ctx): string {
  const year = todayRiyadh(ctx.now()).slice(0, 4);
  const key = `case_no_${year}`;
  ctx.db.run('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [key]);
  ctx.db.run('UPDATE counters SET value = value + 1 WHERE name = ?', [key]);
  let n = ctx.db.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [key])!.value;
  let fileNo = `${year}-${String(n).padStart(4, '0')}`;
  while (ctx.db.get('SELECT id FROM cases WHERE file_no = ?', [fileNo])) {
    ctx.db.run('UPDATE counters SET value = value + 1 WHERE name = ?', [key]);
    n++;
    fileNo = `${year}-${String(n).padStart(4, '0')}`;
  }
  return fileNo;
}

function validateResponsible(ctx: Ctx, userId: string | null) {
  if (!userId) return;
  const u = ctx.db.get<{ active: number }>('SELECT active FROM users WHERE id = ?', [userId]);
  if (!u || !u.active) throw new AppError('VALIDATION', 'المسؤول المختار غير موجود أو موقوف', { responsibleUserId: 'اختر مستخدمًا نشطًا' });
}

function caseParams(input: CaseInput) {
  return {
    title: input.title,
    case_type: input.caseType,
    subject: input.subject,
    requests: input.requests,
    claim_amount: input.claimAmount,
    opened_on: input.openedOn,
    responsible_user_id: input.responsibleUserId,
    follow_status: input.followStatus,
    priority: input.priority,
    notes: input.notes,
    next_action: input.nextAction,
    next_action_due: input.nextActionDue,
  };
}

function insertParty(ctx: Ctx, caseId: string, p: PartyInput, order: number) {
  const now = ctx.now().toISOString();
  const id = uuid();
  ctx.db.run(
    `INSERT INTO case_parties (id, case_id, name, role, is_opponent, id_number, representative, notes, sort_order, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, caseId, p.name, p.role, p.isOpponent, p.idNumber, p.representative, p.notes, order, ctx.user!.id, now, ctx.user!.id, now],
  );
  return id;
}

function insertStage(ctx: Ctx, caseId: string, s: StageInput): string {
  const now = ctx.now().toISOString();
  if (s.previousStageId) {
    const prev = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [s.previousStageId]);
    if (!prev || prev.case_id !== caseId) throw new AppError('VALIDATION', 'المرحلة السابقة لا تتبع هذه القضية', { previousStageId: 'اختيار غير صالح' });
  }
  const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM stages WHERE case_id = ?', [caseId]);
  const id = uuid();
  ctx.db.run(
    `INSERT INTO stages (id, case_id, stage_type, court_type, court_name, circuit, official_case_no, started_on, ended_on, status, previous_stage_id, notes, sort_order,
       created_by, created_at, updated_by, updated_at)
     VALUES (:id, :case_id, :stage_type, :court_type, :court_name, :circuit, :official_case_no, :started_on, :ended_on, :status, :prev, :notes, :ord, :uid, :now, :uid, :now)`,
    {
      id,
      case_id: caseId,
      stage_type: s.stageType,
      court_type: s.courtType,
      court_name: s.courtName,
      circuit: s.circuit,
      official_case_no: s.officialCaseNo,
      started_on: s.startedOn,
      ended_on: s.endedOn,
      status: s.status,
      prev: s.previousStageId,
      notes: s.notes,
      ord: (max?.m ?? 0) + 10,
      uid: ctx.user!.id,
      now,
    },
  );
  return id;
}

export function createCase(ctx: Ctx, input: CaseInput & { parties: PartyInput[]; firstStage?: StageInput | null }) {
  const u = requireUser(ctx);
  requirePerm(ctx, 'cases.create', 'لا تملك صلاحية فتح قضايا جديدة');
  const client = ctx.db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM clients WHERE id = ?', [input.clientId]);
  if (!client) throw new AppError('VALIDATION', 'العميل غير موجود', { clientId: 'اختر العميل' });
  if (clientAccess(ctx, input.clientId) === 'none') throw forbidden('لا تملك صلاحية الوصول إلى هذا العميل');
  if (client.status === 'archived') throw new AppError('CONFLICT', 'العميل مؤرشف. ألغِ أرشفته أولًا.');
  validateResponsible(ctx, input.responsibleUserId);
  if (!isOwner(ctx) && input.responsibleUserId && input.responsibleUserId !== u.id)
    throw forbidden('تعيين مسؤول آخر عن الملف متاح لصاحب المكتب فقط');
  const id = uuid();
  const now = ctx.now().toISOString();
  let fileNo = '';
  ctx.db.tx(() => {
    fileNo = nextFileNo(ctx);
    ctx.db.run(
      `INSERT INTO cases (id, file_no, title, client_id, case_type, subject, requests, claim_amount, opened_on, responsible_user_id, follow_status, priority,
         notes, next_action, next_action_due, status, archived, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :file_no, :title, :client_id, :case_type, :subject, :requests, :claim_amount, :opened_on, :responsible_user_id, :follow_status, :priority,
         :notes, :next_action, :next_action_due, 'open', 0, :uid, :now, :uid, :now)`,
      { id, file_no: fileNo, client_id: input.clientId, ...caseParams(input), uid: u.id, now },
    );
    input.parties.forEach((p, i) => insertParty(ctx, id, p, i * 10));
    if (input.firstStage) insertStage(ctx, id, { ...input.firstStage, previousStageId: null });
    if (u.role !== 'owner') grantCase(ctx, u.id, id);
    if (input.responsibleUserId) grantCase(ctx, input.responsibleUserId, id);
    logActivity(ctx, { action: 'create', entityType: 'case', entityId: id, caseId: id, clientId: input.clientId, summary: `فتح ملف قضية ${fileNo}: ${input.title}` });
  });
  return { id, fileNo };
}

export function updateCase(ctx: Ctx, input: CaseInput & { id: string }) {
  const u = requireUser(ctx);
  const c = requireCaseWritable(ctx, input.id);
  if (input.clientId !== c.client_id) throw new AppError('VALIDATION', 'لا يمكن نقل ملف القضية إلى عميل آخر', { clientId: 'العميل ثابت لملف القضية' });
  validateResponsible(ctx, input.responsibleUserId);
  if (!isOwner(ctx) && input.responsibleUserId !== c.responsible_user_id) throw forbidden('تغيير المسؤول عن الملف متاح لصاحب المكتب فقط');
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE cases SET title = :title, case_type = :case_type, subject = :subject, requests = :requests, claim_amount = :claim_amount, opened_on = :opened_on,
         responsible_user_id = :responsible_user_id, follow_status = :follow_status, priority = :priority, notes = :notes, next_action = :next_action,
         next_action_due = :next_action_due, updated_by = :uid, updated_at = :now WHERE id = :id`,
      { id: input.id, ...caseParams(input), uid: u.id, now: ctx.now().toISOString() },
    );
    if (input.responsibleUserId) grantCase(ctx, input.responsibleUserId, input.id);
    logActivity(ctx, { action: 'update', entityType: 'case', entityId: input.id, caseId: input.id, clientId: c.client_id, summary: `تعديل بيانات ملف ${c.file_no}` });
  });
  return { ok: true };
}

export function listCases(
  ctx: Ctx,
  input: {
    q?: string | null;
    clientId?: string | null;
    status?: string | null;
    followStatus?: string | null;
    caseType?: string | null;
    responsibleUserId?: string | null;
    archived?: 'active' | 'archived' | 'all';
  },
) {
  requireUser(ctx);
  const scope = caseScope(ctx, 'c.id');
  const where = [scope.sql];
  const p: Record<string, unknown> = { ...scope.params };
  if (input.clientId) {
    where.push('c.client_id = :clientId');
    p.clientId = input.clientId;
  }
  if (input.status) {
    where.push('c.status = :status');
    p.status = input.status;
  }
  if (input.followStatus) {
    where.push('c.follow_status = :fs');
    p.fs = input.followStatus;
  }
  if (input.caseType) {
    where.push('c.case_type = :ct');
    p.ct = input.caseType;
  }
  if (input.responsibleUserId) {
    where.push('c.responsible_user_id = :ru');
    p.ru = input.responsibleUserId;
  }
  if ((input.archived ?? 'active') === 'active') where.push('c.archived = 0');
  else if (input.archived === 'archived') where.push('c.archived = 1');
  searchTokens(input.q ?? '').forEach((t, i) => {
    const k = `t${i}`;
    where.push(`(arnorm(c.title) LIKE :${k} ESCAPE '\\' OR c.file_no LIKE :${k} ESCAPE '\\' OR arnorm(cl.name) LIKE :${k} ESCAPE '\\'
      OR arnorm(coalesce(c.subject,'')) LIKE :${k} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM case_parties cp WHERE cp.case_id = c.id AND arnorm(cp.name) LIKE :${k} ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM stages s WHERE s.case_id = c.id AND arnorm(coalesce(s.official_case_no,'')) LIKE :${k} ESCAPE '\\'))`);
    p[k] = `%${likeEscape(t)}%`;
  });
  const rows = ctx.db.all<{
    id: string;
    file_no: string;
    title: string;
    client_id: string;
    client_name: string;
    case_type: string | null;
    status: string;
    follow_status: string;
    archived: number;
    priority: string;
    responsible: string | null;
    opened_on: string | null;
    updated_at: string;
  }>(
    `SELECT c.id, c.file_no, c.title, c.client_id, cl.name AS client_name, c.case_type, c.status, c.follow_status, c.archived, c.priority,
       u.display_name AS responsible, c.opened_on, c.updated_at
     FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.responsible_user_id
     WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 3000`,
    p,
  );
  const now = ctx.now();
  return rows.map((r) => ({
    id: r.id,
    fileNo: r.file_no,
    title: r.title,
    clientId: r.client_id,
    clientName: r.client_name,
    caseType: r.case_type,
    status: r.status,
    followStatus: r.follow_status,
    archived: !!r.archived,
    priority: r.priority,
    responsible: r.responsible,
    openedOn: r.opened_on,
    updatedAt: r.updated_at,
    opponents: ctx.db
      .all<{ name: string }>('SELECT name FROM case_parties WHERE case_id = ? AND is_opponent = 1 ORDER BY sort_order', [r.id])
      .map((x) => x.name),
    stage: currentStageOf(ctx.db, r.id),
    lastAction: lastActionOf(ctx.db, r.id, now),
    nextEvent: nextEventOf(ctx.db, r.id, now),
  }));
}

export function caseOptions(ctx: Ctx, input: { clientId?: string | null }) {
  requireUser(ctx);
  const scope = caseScope(ctx, 'c.id');
  const p: Record<string, unknown> = { ...scope.params };
  let extra = '';
  if (input.clientId) {
    extra = ' AND c.client_id = :cid';
    p.cid = input.clientId;
  }
  return ctx.db
    .all<{ id: string; file_no: string; title: string; client_id: string; client_name: string; archived: number; status: string }>(
      `SELECT c.id, c.file_no, c.title, c.client_id, cl.name AS client_name, c.archived, c.status FROM cases c JOIN clients cl ON cl.id = c.client_id
       WHERE ${scope.sql}${extra} ORDER BY c.archived, c.created_at DESC`,
      p,
    )
    .map((r) => ({ id: r.id, fileNo: r.file_no, title: r.title, clientId: r.client_id, clientName: r.client_name, archived: !!r.archived, status: r.status }));
}

export function getCase(ctx: Ctx, input: { id: string }) {
  requireCase(ctx, input.id);
  const c = ctx.db.get<Record<string, unknown> & { client_id: string; responsible_user_id: string | null; closed_by: string | null }>(
    `SELECT c.*, u.display_name AS responsible_name, cb.display_name AS closed_by_name FROM cases c
     LEFT JOIN users u ON u.id = c.responsible_user_id LEFT JOIN users cb ON cb.id = c.closed_by WHERE c.id = ?`,
    [input.id],
  )!;
  const client = ctx.db.get<{ id: string; name: string; kind: string; phone: string | null }>('SELECT id, name, kind, phone FROM clients WHERE id = ?', [c.client_id])!;
  const parties = ctx.db
    .all<{ id: string; name: string; role: string | null; is_opponent: number; id_number: string | null; representative: string | null; notes: string | null }>(
      'SELECT * FROM case_parties WHERE case_id = ? ORDER BY sort_order, created_at',
      [input.id],
    )
    .map((p) => ({ id: p.id, name: p.name, role: p.role, isOpponent: !!p.is_opponent, idNumber: p.id_number, representative: p.representative, notes: p.notes }));
  const stages = listStages(ctx, input.id);
  const now = ctx.now();
  const relatedWorks = ctx.db
    .all<Record<string, string | null>>('SELECT * FROM related_works WHERE case_id = ? ORDER BY coalesce(opened_on, created_at)', [input.id])
    .map((r) => ({ id: r.id!, kind: r.kind as RelatedWorkKind, title: r.title!, authority: r.authority, referenceNo: r.reference_no, openedOn: r.opened_on, status: r.status as RelatedWorkStatus, notes: r.notes }));
  let closeChecklist: unknown = null;
  try {
    closeChecklist = c.close_checklist ? JSON.parse(String(c.close_checklist)) : null;
  } catch {
    closeChecklist = null;
  }
  const counts = ctx.db.get<{ docs: number; memos: number; tasks_open: number; hearings: number; judgments: number }>(
    `SELECT (SELECT count(*) FROM documents WHERE case_id = :id AND archived_at IS NULL) AS docs,
            (SELECT count(*) FROM memos WHERE case_id = :id) AS memos,
            (SELECT count(*) FROM tasks WHERE case_id = :id AND status != 'done') AS tasks_open,
            (SELECT count(*) FROM hearings WHERE case_id = :id) AS hearings,
            (SELECT count(*) FROM judgments WHERE case_id = :id) AS judgments`,
    { id: input.id },
  )!;
  return {
    case: {
      id: String(c.id),
      fileNo: String(c.file_no),
      title: String(c.title),
      clientId: c.client_id,
      caseType: c.case_type as string | null,
      subject: c.subject as string | null,
      requests: c.requests as string | null,
      claimAmount: c.claim_amount as number | null,
      openedOn: c.opened_on as string | null,
      responsibleUserId: c.responsible_user_id,
      responsibleName: c.responsible_name as string | null,
      followStatus: c.follow_status as FollowStatus,
      status: c.status as 'open' | 'closed',
      archived: !!c.archived,
      archivedAt: c.archived_at as string | null,
      priority: c.priority as Priority,
      notes: c.notes as string | null,
      nextAction: c.next_action as string | null,
      nextActionDue: c.next_action_due as string | null,
      outcome: c.outcome as string | null,
      closedAt: c.closed_at as string | null,
      closedByName: c.closed_by_name as string | null,
      closeChecklist,
      createdAt: String(c.created_at),
      updatedAt: String(c.updated_at),
    },
    client,
    parties,
    stages,
    relatedWorks,
    header: {
      stage: currentStageOf(ctx.db, input.id),
      lastAction: lastActionOf(ctx.db, input.id, now),
      nextEvent: nextEventOf(ctx.db, input.id, now),
    },
    counts,
    permissions: {
      canClose: hasPerm(ctx, 'cases.close'),
      canArchive: hasPerm(ctx, 'cases.archive'),
      canFees: hasPerm(ctx, 'fees.view'),
      canManageFees: hasPerm(ctx, 'fees.manage'),
      canReport: hasPerm(ctx, 'reports.export'),
      isOwner: isOwner(ctx),
    },
  };
}

export function listStages(ctx: Ctx, caseId: string) {
  requireCase(ctx, caseId);
  return ctx.db
    .all<Record<string, string | null> & { sort_order: number }>(
      `SELECT s.*, (SELECT count(*) FROM hearings h WHERE h.stage_id = s.id) AS hearing_count,
              (SELECT count(*) FROM judgments j WHERE j.stage_id = s.id) AS judgment_count
       FROM stages s WHERE s.case_id = ? ORDER BY coalesce(s.started_on, substr(s.created_at,1,10)), s.sort_order`,
      [caseId],
    )
    .map((s) => ({
      id: s.id!,
      stageType: s.stage_type!,
      courtType: s.court_type,
      courtName: s.court_name,
      circuit: s.circuit,
      officialCaseNo: s.official_case_no,
      startedOn: s.started_on,
      endedOn: s.ended_on,
      status: s.status as StageStatus,
      previousStageId: s.previous_stage_id,
      notes: s.notes,
      hearingCount: Number(s.hearing_count),
      judgmentCount: Number(s.judgment_count),
    }));
}

export function saveParty(ctx: Ctx, input: PartyInput & { caseId: string }) {
  const c = requireCaseWritable(ctx, input.caseId);
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const existing = ctx.db.get<{ case_id: string }>('SELECT case_id FROM case_parties WHERE id = ?', [id]);
      if (!existing || existing.case_id !== input.caseId) throw notFound('الطرف');
      ctx.db.run(
        'UPDATE case_parties SET name = ?, role = ?, is_opponent = ?, id_number = ?, representative = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [input.name, input.role, input.isOpponent, input.idNumber, input.representative, input.notes, ctx.user!.id, ctx.now().toISOString(), id],
      );
    } else {
      const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM case_parties WHERE case_id = ?', [input.caseId]);
      id = insertParty(ctx, input.caseId, input, (max?.m ?? 0) + 10);
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'party', entityId: id, caseId: input.caseId, clientId: c.client_id, summary: `${input.id ? 'تعديل' : 'إضافة'} طرف: ${input.name}` });
  });
  return { id };
}

export function removeParty(ctx: Ctx, input: { id: string }) {
  const p = ctx.db.get<{ case_id: string; name: string }>('SELECT case_id, name FROM case_parties WHERE id = ?', [input.id]);
  if (!p) throw notFound('الطرف');
  const c = requireCaseWritable(ctx, p.case_id);
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM case_parties WHERE id = ?', [input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'party', entityId: input.id, caseId: p.case_id, clientId: c.client_id, summary: `حذف طرف: ${p.name}` });
  });
  return { ok: true };
}

export function createStage(ctx: Ctx, input: StageInput & { caseId: string }) {
  const c = requireCaseWritable(ctx, input.caseId);
  let id = '';
  ctx.db.tx(() => {
    id = insertStage(ctx, input.caseId, input);
    // الانتقال لمرحلة لاحقة لا يمحو المرحلة السابقة؛ يُسجل فقط تاريخها إن طلب المستخدم إنهاءها
    logActivity(ctx, {
      action: 'create',
      entityType: 'stage',
      entityId: id,
      caseId: input.caseId,
      clientId: c.client_id,
      summary: `إضافة مرحلة «${input.stageType}»${input.previousStageId ? ' مرتبطة بالمرحلة السابقة' : ''}`,
    });
  });
  return { id };
}

export function updateStage(ctx: Ctx, input: StageInput & { id: string }) {
  const s = ctx.db.get<{ case_id: string; status: string; stage_type: string }>('SELECT case_id, status, stage_type FROM stages WHERE id = ?', [input.id]);
  if (!s) throw notFound('المرحلة');
  const c = requireCaseWritable(ctx, s.case_id);
  if (input.previousStageId === input.id) throw new AppError('VALIDATION', 'لا يمكن ربط المرحلة بنفسها', { previousStageId: 'اختيار غير صالح' });
  if (input.previousStageId) {
    const prev = ctx.db.get<{ case_id: string }>('SELECT case_id FROM stages WHERE id = ?', [input.previousStageId]);
    if (!prev || prev.case_id !== s.case_id) throw new AppError('VALIDATION', 'المرحلة السابقة لا تتبع هذه القضية', { previousStageId: 'اختيار غير صالح' });
  }
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE stages SET stage_type = :stage_type, court_type = :court_type, court_name = :court_name, circuit = :circuit, official_case_no = :official_case_no,
         started_on = :started_on, ended_on = :ended_on, status = :status, previous_stage_id = :prev, notes = :notes, updated_by = :uid, updated_at = :now WHERE id = :id`,
      {
        id: input.id,
        stage_type: input.stageType,
        court_type: input.courtType,
        court_name: input.courtName,
        circuit: input.circuit,
        official_case_no: input.officialCaseNo,
        started_on: input.startedOn,
        ended_on: input.endedOn,
        status: input.status,
        prev: input.previousStageId,
        notes: input.notes,
        uid: ctx.user!.id,
        now: ctx.now().toISOString(),
      },
    );
    logActivity(ctx, {
      action: s.status !== input.status ? 'status' : 'update',
      entityType: 'stage',
      entityId: input.id,
      caseId: s.case_id,
      clientId: c.client_id,
      summary: `تعديل مرحلة «${input.stageType}»${s.status !== input.status ? ` — الحالة: ${STAGE_STATUSES[input.status].label}` : ''}`,
    });
  });
  return { ok: true };
}

export function removeStage(ctx: Ctx, input: { id: string }) {
  const s = ctx.db.get<{ case_id: string; stage_type: string }>('SELECT case_id, stage_type FROM stages WHERE id = ?', [input.id]);
  if (!s) throw notFound('المرحلة');
  const c = requireCaseWritable(ctx, s.case_id);
  const used = ctx.db.get<{ n: number }>(
    `SELECT (SELECT count(*) FROM hearings WHERE stage_id = :id) + (SELECT count(*) FROM judgments WHERE stage_id = :id)
      + (SELECT count(*) FROM documents WHERE stage_id = :id) + (SELECT count(*) FROM memos WHERE stage_id = :id)
      + (SELECT count(*) FROM stages WHERE previous_stage_id = :id) + (SELECT count(*) FROM tasks WHERE stage_id = :id)
      + (SELECT count(*) FROM deadlines WHERE stage_id = :id) AS n`,
    { id: input.id },
  )!;
  if (used.n > 0) throw new AppError('CONFLICT', 'لا يمكن حذف مرحلة مرتبط بها جلسات أو أحكام أو مستندات أو مراحل لاحقة. غيّر حالتها بدلًا من ذلك.');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM stages WHERE id = ?', [input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'stage', entityId: input.id, caseId: s.case_id, clientId: c.client_id, summary: `حذف مرحلة فارغة «${s.stage_type}»` });
  });
  return { ok: true };
}

export function saveRelatedWork(
  ctx: Ctx,
  input: { id: string | null; caseId: string; kind: RelatedWorkKind; title: string; authority: string | null; referenceNo: string | null; openedOn: string | null; status: RelatedWorkStatus; notes: string | null },
) {
  const c = requireCaseWritable(ctx, input.caseId);
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ case_id: string }>('SELECT case_id FROM related_works WHERE id = ?', [id]);
      if (!ex || ex.case_id !== input.caseId) throw notFound('العمل المرتبط');
      ctx.db.run(
        'UPDATE related_works SET kind = ?, title = ?, authority = ?, reference_no = ?, opened_on = ?, status = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [input.kind, input.title, input.authority, input.referenceNo, input.openedOn, input.status, input.notes, ctx.user!.id, now, id],
      );
    } else {
      id = uuid();
      ctx.db.run(
        `INSERT INTO related_works (id, case_id, kind, title, authority, reference_no, opened_on, status, notes, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.caseId, input.kind, input.title, input.authority, input.referenceNo, input.openedOn, input.status, input.notes, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'related_work', entityId: id, caseId: input.caseId, clientId: c.client_id, summary: `${input.id ? 'تعديل' : 'تسجيل'} عمل مرتبط: ${input.title}` });
  });
  return { id };
}

export function closeChecklist(ctx: Ctx, input: { id: string }) {
  requireCase(ctx, input.id);
  const nowIso = ctx.now().toISOString();
  const c = ctx.db.get<{ outcome: string | null; client_id: string }>('SELECT outcome, client_id FROM cases WHERE id = ?', [input.id])!;
  const openTasks = ctx.db.all<{ id: string; title: string; due_date: string | null }>("SELECT id, title, due_date FROM tasks WHERE case_id = ? AND status != 'done'", [input.id]);
  const upcomingHearings = ctx.db.all<{ id: string; starts_at: string }>("SELECT id, starts_at FROM hearings WHERE case_id = ? AND status = 'scheduled' AND starts_at >= ?", [input.id, nowIso]);
  const openDeadlines = ctx.db.all<{ id: string; title: string; due_date: string }>("SELECT id, title, due_date FROM deadlines WHERE case_id = ? AND status = 'open'", [input.id]);
  const draftMemos = ctx.db.all<{ id: string; title: string; status: string }>("SELECT id, title, status FROM memos WHERE case_id = ? AND status != 'submitted'", [input.id]);
  const docCount = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM documents WHERE case_id = ? AND archived_at IS NULL', [input.id])!.n;
  const pendingExtraction = ctx.db.get<{ n: number }>(
    `SELECT count(*) AS n FROM documents d WHERE d.case_id = ? AND d.status = 'needs_review' AND d.archived_at IS NULL`,
    [input.id],
  )!.n;
  let fees: { contracts: number; remaining: number; sharedContracts: number } | null = null;
  if (hasPerm(ctx, 'fees.view')) {
    const rows = ctx.db.all<{ id: string; fixed_amount: number | null; shared: number; paid: number }>(
      `SELECT k.id, k.fixed_amount, (SELECT count(*) FROM contract_cases cc2 WHERE cc2.contract_id = k.id) AS shared,
              coalesce((SELECT sum(amount) FROM payments p WHERE p.contract_id = k.id AND p.voided = 0), 0) AS paid
       FROM contracts k JOIN contract_cases cc ON cc.contract_id = k.id WHERE cc.case_id = ?`,
      [input.id],
    );
    fees = {
      contracts: rows.length,
      remaining: rows.reduce((s, r) => s + Math.max((r.fixed_amount ?? 0) - r.paid, 0), 0),
      sharedContracts: rows.filter((r) => r.shared > 1).length,
    };
  }
  return { outcome: c.outcome, openTasks, upcomingHearings, openDeadlines, draftMemos, docCount, pendingReviewDocs: pendingExtraction, fees };
}

export function closeCase(
  ctx: Ctx,
  input: { id: string; outcome: string; remainingWork: string | null; feesNote: string | null; documentsNote: string | null; lastClientReportOn: string | null },
) {
  requirePerm(ctx, 'cases.close', 'لا تملك صلاحية إقفال القضايا');
  const c = requireCaseWritable(ctx, input.id);
  if (c.status === 'closed') throw new AppError('CONFLICT', 'الملف مقفل مسبقًا');
  const checklist = closeChecklist(ctx, { id: input.id });
  const now = ctx.now().toISOString();
  const record = {
    outcome: input.outcome,
    remainingWork: input.remainingWork,
    feesNote: input.feesNote,
    documentsNote: input.documentsNote,
    lastClientReportOn: input.lastClientReportOn,
    snapshot: {
      openTasks: checklist.openTasks.length,
      upcomingHearings: checklist.upcomingHearings.length,
      openDeadlines: checklist.openDeadlines.length,
      unsubmittedMemos: checklist.draftMemos.length,
      docCount: checklist.docCount,
      feesRemaining: checklist.fees?.remaining ?? null,
    },
    decidedBy: ctx.user!.displayName,
    decidedAt: now,
  };
  ctx.db.tx(() => {
    ctx.db.run("UPDATE cases SET status = 'closed', outcome = ?, closed_at = ?, closed_by = ?, close_checklist = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      input.outcome,
      now,
      ctx.user!.id,
      JSON.stringify(record),
      ctx.user!.id,
      now,
      input.id,
    ]);
    logActivity(ctx, { action: 'close', entityType: 'case', entityId: input.id, caseId: input.id, clientId: c.client_id, summary: `إقفال ملف ${c.file_no}: ${input.outcome.slice(0, 120)}`, details: record });
  });
  return { ok: true };
}

export function reopenCase(ctx: Ctx, input: { id: string; reason: string }) {
  requirePerm(ctx, 'cases.close', 'لا تملك صلاحية إعادة فتح القضايا');
  const c = requireCaseWritable(ctx, input.id);
  if (c.status !== 'closed') throw new AppError('CONFLICT', 'الملف ليس مقفلًا');
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run("UPDATE cases SET status = 'open', closed_at = NULL, closed_by = NULL, updated_by = ?, updated_at = ? WHERE id = ?", [ctx.user!.id, now, input.id]);
    logActivity(ctx, { action: 'reopen', entityType: 'case', entityId: input.id, caseId: input.id, clientId: c.client_id, summary: `إعادة فتح ملف ${c.file_no}: ${input.reason.slice(0, 200)}` });
  });
  return { ok: true };
}

export function setCaseArchived(ctx: Ctx, input: { id: string; archived: boolean; reason: string | null }) {
  requirePerm(ctx, 'cases.archive', 'لا تملك صلاحية الأرشفة');
  const c = requireCase(ctx, input.id);
  if (!!c.archived === input.archived) return { ok: true };
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE cases SET archived = ?, archived_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      input.archived,
      input.archived ? now : null,
      ctx.user!.id,
      now,
      input.id,
    ]);
    // الأرشفة تُبقي كل البيانات والمرفقات؛ فقط تُوقف التذكيرات غير المنفذة
    if (input.archived) ctx.db.run('DELETE FROM reminders WHERE case_id = ? AND fired_at IS NULL', [input.id]);
    logActivity(ctx, {
      action: input.archived ? 'archive' : 'unarchive',
      entityType: 'case',
      entityId: input.id,
      caseId: input.id,
      clientId: c.client_id,
      summary: `${input.archived ? 'أرشفة' : 'إلغاء أرشفة'} ملف ${c.file_no}${input.reason ? ': ' + input.reason : ''}`,
    });
  });
  return { ok: true };
}

export function followStatusLabel(k: string) {
  return (FOLLOW_STATUSES as Record<string, { label: string }>)[k]?.label ?? k;
}

export function assertCaseAccessible(ctx: Ctx, caseId: string | null) {
  if (caseId && !canAccessCase(ctx, caseId)) throw forbidden('لا تملك صلاحية الوصول إلى ملف هذه القضية');
}
