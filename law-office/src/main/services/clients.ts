import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { normalizeArabic, searchTokens, likeEscape } from '../../shared/text';
import { CLIENT_STATUSES, type ClientKind, type ClientStatus } from '../../shared/constants';
import {
  caseScope,
  clientAccess,
  clientScope,
  grantClient,
  hasPerm,
  isOwner,
  requireClient,
  requirePerm,
  requireUser,
} from './access';
import { logActivity } from './activity';
import { currentStageOf, lastActionOf, nextEventOf } from './overview';
import { clientFinanceSummary, listContracts, listPoas } from './finance';
import { listDocuments } from './documents';
import { listComms, listNotes } from './notes';
import { upcomingForCases } from './calendar';

export interface ClientRow {
  id: string;
  kind: ClientKind;
  name: string;
  short_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  id_type: string | null;
  id_number: string | null;
  rep_name: string | null;
  rep_title: string | null;
  rep_phone: string | null;
  rep_email: string | null;
  relationship_summary: string | null;
  notes: string | null;
  status: ClientStatus;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapClient(r: ClientRow, full: boolean) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    shortName: r.short_name,
    phone: r.phone,
    email: r.email,
    address: r.address,
    idType: r.id_type,
    idNumber: r.id_number,
    repName: r.rep_name,
    repTitle: r.rep_title,
    repPhone: r.rep_phone,
    repEmail: r.rep_email,
    relationshipSummary: full ? r.relationship_summary : null,
    notes: full ? r.notes : null,
    status: r.status,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type ClientInput = {
  kind: ClientKind;
  name: string;
  shortName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  idType: string | null;
  idNumber: string | null;
  repName: string | null;
  repTitle: string | null;
  repPhone: string | null;
  repEmail: string | null;
  relationshipSummary: string | null;
  notes: string | null;
};

function params(input: ClientInput) {
  return {
    kind: input.kind,
    name: input.name,
    short_name: input.shortName,
    phone: input.phone,
    email: input.email,
    address: input.address,
    id_type: input.idType,
    id_number: input.idNumber,
    rep_name: input.repName,
    rep_title: input.repTitle,
    rep_phone: input.repPhone,
    rep_email: input.repEmail,
    relationship_summary: input.relationshipSummary,
    notes: input.notes,
  };
}

export function listClients(ctx: Ctx, input: { q?: string | null; kind?: ClientKind | null; status?: ClientStatus | null }) {
  requireUser(ctx);
  const scope = clientScope(ctx, 'cl.id');
  const cscope = caseScope(ctx, 'ca.id');
  const where = [scope.sql];
  const p: Record<string, unknown> = { ...scope.params, ...cscope.params, now: ctx.now().toISOString() };
  if (input.kind) {
    where.push('cl.kind = :kind');
    p.kind = input.kind;
  }
  if (input.status) {
    where.push('cl.status = :status');
    p.status = input.status;
  } else {
    where.push("cl.status != 'archived'");
  }
  searchTokens(input.q ?? '').forEach((t, i) => {
    where.push(
      `(arnorm(cl.name) LIKE :t${i} ESCAPE '\\' OR arnorm(coalesce(cl.short_name,'')) LIKE :t${i} ESCAPE '\\' OR arnorm(coalesce(cl.phone,'')) LIKE :t${i} ESCAPE '\\' OR arnorm(coalesce(cl.id_number,'')) LIKE :t${i} ESCAPE '\\' OR arnorm(coalesce(cl.rep_name,'')) LIKE :t${i} ESCAPE '\\')`,
    );
    p[`t${i}`] = `%${likeEscape(t)}%`;
  });
  const rows = ctx.db.all<ClientRow & { case_count: number; open_count: number; next_hearing: string | null }>(
    `SELECT cl.*,
       (SELECT count(*) FROM cases ca WHERE ca.client_id = cl.id AND ${cscope.sql}) AS case_count,
       (SELECT count(*) FROM cases ca WHERE ca.client_id = cl.id AND ca.status = 'open' AND ca.archived = 0 AND ${cscope.sql}) AS open_count,
       (SELECT min(h.starts_at) FROM hearings h JOIN cases ca ON ca.id = h.case_id WHERE ca.client_id = cl.id AND h.status = 'scheduled' AND h.starts_at >= :now AND ${cscope.sql}) AS next_hearing
     FROM clients cl WHERE ${where.join(' AND ')} ORDER BY cl.name COLLATE NOCASE LIMIT 2000`,
    p,
  );
  return rows.map((r) => ({
    ...mapClient(r, false),
    caseCount: r.case_count,
    openCaseCount: r.open_count,
    nextHearingAt: r.next_hearing,
  }));
}

/** يبحث عن عملاء متشابهين للتنبيه فقط — لا دمج تلقائي. */
export function findSimilarClients(
  ctx: Ctx,
  input: { name: string | null; phone: string | null; idNumber: string | null; excludeId: string | null },
) {
  requireUser(ctx);
  const scope = clientScope(ctx, 'cl.id');
  const conds: string[] = [];
  const p: Record<string, unknown> = { ...scope.params, ex: input.excludeId ?? '' };
  if (input.name && normalizeArabic(input.name).length >= 3) {
    conds.push(`arnorm(cl.name) LIKE :n ESCAPE '\\'`);
    p.n = `%${likeEscape(normalizeArabic(input.name))}%`;
  }
  const digits = (input.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 7) {
    conds.push(`replace(replace(replace(coalesce(cl.phone,''),' ',''),'-',''),'+','') LIKE :ph`);
    p.ph = `%${digits.slice(-9)}`;
  }
  if (input.idNumber && input.idNumber.trim().length >= 4) {
    conds.push('cl.id_number = :idn');
    p.idn = input.idNumber.trim();
  }
  if (!conds.length) return [];
  return ctx.db
    .all<ClientRow>(`SELECT cl.* FROM clients cl WHERE (${conds.join(' OR ')}) AND cl.id != :ex AND ${scope.sql} LIMIT 10`, p)
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, phone: r.phone, idNumber: r.id_number, status: r.status }));
}

export function createClient(ctx: Ctx, input: ClientInput) {
  const u = requireUser(ctx);
  requirePerm(ctx, 'clients.create', 'لا تملك صلاحية إضافة عملاء جدد');
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO clients (id, kind, name, short_name, phone, email, address, id_type, id_number, rep_name, rep_title, rep_phone, rep_email,
         relationship_summary, notes, status, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :kind, :name, :short_name, :phone, :email, :address, :id_type, :id_number, :rep_name, :rep_title, :rep_phone, :rep_email,
         :relationship_summary, :notes, 'active', :uid, :now, :uid, :now)`,
      { id, ...params(input), uid: u.id, now },
    );
    if (u.role !== 'owner') grantClient(ctx, u.id, id);
    logActivity(ctx, { action: 'create', entityType: 'client', entityId: id, clientId: id, summary: `إضافة عميل: ${input.name}` });
  });
  return { id };
}

export function updateClient(ctx: Ctx, input: ClientInput & { id: string }) {
  const u = requireUser(ctx);
  requireClient(ctx, input.id, 'full');
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE clients SET kind = :kind, name = :name, short_name = :short_name, phone = :phone, email = :email, address = :address,
         id_type = :id_type, id_number = :id_number, rep_name = :rep_name, rep_title = :rep_title, rep_phone = :rep_phone, rep_email = :rep_email,
         relationship_summary = :relationship_summary, notes = :notes, updated_by = :uid, updated_at = :now WHERE id = :id`,
      { id: input.id, ...params(input), uid: u.id, now: ctx.now().toISOString() },
    );
    logActivity(ctx, { action: 'update', entityType: 'client', entityId: input.id, clientId: input.id, summary: `تعديل بيانات العميل: ${input.name}` });
  });
  return { ok: true };
}

export function setClientStatus(ctx: Ctx, input: { id: string; status: ClientStatus }) {
  const u = requireUser(ctx);
  const c = requireClient(ctx, input.id, 'full');
  if (input.status === 'archived' && !isOwner(ctx) && !hasPerm(ctx, 'cases.archive'))
    throw new AppError('FORBIDDEN', 'لا تملك صلاحية الأرشفة');
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE clients SET status = ?, archived_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      input.status,
      input.status === 'archived' ? now : null,
      u.id,
      now,
      input.id,
    ]);
    logActivity(ctx, {
      action: input.status === 'archived' ? 'archive' : c.status === 'archived' ? 'unarchive' : 'status',
      entityType: 'client',
      entityId: input.id,
      clientId: input.id,
      summary: `حالة العميل ${c.name}: ${CLIENT_STATUSES[input.status].label}`,
    });
  });
  return { ok: true };
}

export function caseRowsForClient(ctx: Ctx, clientId: string, includeArchived = true) {
  const scope = caseScope(ctx, 'c.id');
  const rows = ctx.db.all<{
    id: string;
    file_no: string;
    title: string;
    case_type: string | null;
    status: string;
    follow_status: string;
    archived: number;
    priority: string;
    responsible: string | null;
    updated_at: string;
  }>(
    `SELECT c.id, c.file_no, c.title, c.case_type, c.status, c.follow_status, c.archived, c.priority, c.updated_at, u.display_name AS responsible
     FROM cases c LEFT JOIN users u ON u.id = c.responsible_user_id
     WHERE c.client_id = :cid AND ${scope.sql} ${includeArchived ? '' : 'AND c.archived = 0'}
     ORDER BY c.archived, CASE c.status WHEN 'open' THEN 0 ELSE 1 END, c.created_at DESC`,
    { cid: clientId, ...scope.params },
  );
  const now = ctx.now();
  return rows.map((r) => {
    const opponents = ctx.db
      .all<{ name: string }>('SELECT name FROM case_parties WHERE case_id = ? AND is_opponent = 1 ORDER BY sort_order', [r.id])
      .map((x) => x.name);
    return {
      id: r.id,
      fileNo: r.file_no,
      title: r.title,
      caseType: r.case_type,
      status: r.status,
      followStatus: r.follow_status,
      archived: !!r.archived,
      priority: r.priority,
      responsible: r.responsible,
      opponents,
      stage: currentStageOf(ctx.db, r.id),
      lastAction: lastActionOf(ctx.db, r.id, now),
      nextEvent: nextEventOf(ctx.db, r.id, now),
      updatedAt: r.updated_at,
    };
  });
}

export function getClient(ctx: Ctx, input: { id: string }) {
  requireUser(ctx);
  const row = ctx.db.get<ClientRow>('SELECT * FROM clients WHERE id = ?', [input.id]);
  if (!row) throw notFound('العميل');
  const access = clientAccess(ctx, input.id);
  if (access === 'none') throw new AppError('FORBIDDEN', 'لا تملك صلاحية الوصول إلى بيانات هذا العميل');
  const full = access === 'full';
  const cases = caseRowsForClient(ctx, input.id);
  const caseIds = cases.map((c) => c.id);
  const canFees = hasPerm(ctx, 'fees.view');
  return {
    client: mapClient(row, full),
    access,
    canFees,
    canManageFees: hasPerm(ctx, 'fees.manage'),
    cases,
    contracts: listContracts(ctx, { clientId: input.id }),
    poas: listPoas(ctx, { clientId: input.id }),
    upcoming: upcomingForCases(ctx, caseIds, 40),
    finance: canFees ? clientFinanceSummary(ctx, input.id) : null,
    documents: listDocuments(ctx, { clientId: input.id, archived: 'active', clientLevelOnly: false, q: null, caseId: null, stageId: null, hearingId: null, judgmentId: null, memoId: null, contractId: null, poaId: null, category: null }),
    notes: listNotes(ctx, { clientId: input.id }),
    communications: listComms(ctx, { clientId: input.id }),
  };
}

export function clientOptions(ctx: Ctx) {
  requireUser(ctx);
  const scope = clientScope(ctx, 'cl.id');
  return ctx.db
    .all<{ id: string; name: string; kind: ClientKind; status: string; full: number }>(
      `SELECT cl.id, cl.name, cl.kind, cl.status FROM clients cl WHERE ${scope.sql} AND cl.status != 'archived' ORDER BY cl.name`,
      scope.params,
    )
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, access: clientAccess(ctx, r.id) }));
}
