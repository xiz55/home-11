import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { COMM_CHANNELS, type CommChannel } from '../../shared/constants';
import { isOwner, linkedScope, requireCase, requireLinked, requireUser } from './access';
import { logActivity } from './activity';

export function listNotes(ctx: Ctx, input: { clientId: string; caseId?: string | null }) {
  requireUser(ctx);
  const scope = linkedScope(ctx, 'n.client_id', 'n.case_id');
  const p: Record<string, unknown> = { ...scope.params, cid: input.clientId };
  let extra = '';
  if (input.caseId) {
    extra = ' AND n.case_id = :caseId';
    p.caseId = input.caseId;
  }
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT n.*, u.display_name AS by_name, c.file_no FROM notes n LEFT JOIN users u ON u.id = n.created_by LEFT JOIN cases c ON c.id = n.case_id
       WHERE n.client_id = :cid AND n.deleted_at IS NULL AND ${scope.sql}${extra} ORDER BY n.created_at DESC`,
      p,
    )
    .map((n) => ({
      id: String(n.id),
      clientId: String(n.client_id),
      caseId: n.case_id as string | null,
      caseFileNo: n.file_no as string | null,
      body: String(n.body),
      isInternal: !!n.is_internal,
      byName: n.by_name as string | null,
      createdBy: n.created_by as string | null,
      createdAt: String(n.created_at),
      updatedAt: String(n.updated_at),
    }));
}

function checkCaseClient(ctx: Ctx, clientId: string, caseId: string | null) {
  if (!caseId) return;
  const c = requireCase(ctx, caseId);
  if (c.client_id !== clientId) throw new AppError('VALIDATION', 'القضية لا تتبع العميل', { caseId: 'اختيار غير صالح' });
}

export function saveNote(ctx: Ctx, input: { id: string | null; clientId: string; caseId: string | null; body: string; isInternal: boolean }) {
  requireUser(ctx);
  requireLinked(ctx, input.clientId, input.caseId);
  checkCaseClient(ctx, input.clientId, input.caseId);
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ client_id: string; created_by: string }>('SELECT client_id, created_by FROM notes WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!ex || ex.client_id !== input.clientId) throw notFound('الملاحظة');
      if (!isOwner(ctx) && ex.created_by !== ctx.user!.id) throw forbidden('تعديل ملاحظات الآخرين متاح لصاحب المكتب فقط');
      ctx.db.run('UPDATE notes SET case_id = ?, body = ?, is_internal = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.caseId, input.body, input.isInternal, ctx.user!.id, now, id]);
    } else {
      id = uuid();
      ctx.db.run('INSERT INTO notes (id, client_id, case_id, body, is_internal, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        input.clientId,
        input.caseId,
        input.body,
        input.isInternal,
        ctx.user!.id,
        now,
        ctx.user!.id,
        now,
      ]);
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'note', entityId: id, caseId: input.caseId, clientId: input.clientId, summary: `${input.id ? 'تعديل' : 'إضافة'} ملاحظة${input.isInternal ? ' داخلية' : ''}` });
  });
  return { id };
}

export function removeNote(ctx: Ctx, input: { id: string }) {
  const n = ctx.db.get<{ client_id: string; case_id: string | null; created_by: string }>('SELECT client_id, case_id, created_by FROM notes WHERE id = ? AND deleted_at IS NULL', [input.id]);
  if (!n) throw notFound('الملاحظة');
  requireLinked(ctx, n.client_id, n.case_id);
  if (!isOwner(ctx) && n.created_by !== ctx.user!.id) throw forbidden('حذف ملاحظات الآخرين متاح لصاحب المكتب فقط');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE notes SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', [ctx.now().toISOString(), ctx.user!.id, ctx.now().toISOString(), input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'note', entityId: input.id, caseId: n.case_id, clientId: n.client_id, summary: 'حذف ملاحظة (محفوظة في السجل الداخلي)' });
  });
  return { ok: true };
}

export function listComms(ctx: Ctx, input: { clientId: string; caseId?: string | null }) {
  requireUser(ctx);
  const scope = linkedScope(ctx, 'm.client_id', 'm.case_id');
  const p: Record<string, unknown> = { ...scope.params, cid: input.clientId };
  let extra = '';
  if (input.caseId) {
    extra = ' AND m.case_id = :caseId';
    p.caseId = input.caseId;
  }
  return ctx.db
    .all<Record<string, string | null>>(
      `SELECT m.*, u.display_name AS by_name, c.file_no FROM communications m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN cases c ON c.id = m.case_id
       WHERE m.client_id = :cid AND m.deleted_at IS NULL AND ${scope.sql}${extra} ORDER BY m.occurred_on DESC, m.created_at DESC`,
      p,
    )
    .map((m) => ({
      id: m.id!,
      clientId: m.client_id!,
      caseId: m.case_id,
      caseFileNo: m.file_no,
      occurredOn: m.occurred_on!,
      channel: m.channel as CommChannel,
      contactPerson: m.contact_person,
      summary: m.summary!,
      byName: m.by_name,
      createdAt: m.created_at!,
    }));
}

export function saveComm(
  ctx: Ctx,
  input: { id: string | null; clientId: string; caseId: string | null; occurredOn: string; channel: CommChannel; contactPerson: string | null; summary: string },
) {
  requireUser(ctx);
  requireLinked(ctx, input.clientId, input.caseId);
  checkCaseClient(ctx, input.clientId, input.caseId);
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ client_id: string }>('SELECT client_id FROM communications WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!ex || ex.client_id !== input.clientId) throw notFound('سجل التواصل');
      ctx.db.run('UPDATE communications SET case_id = ?, occurred_on = ?, channel = ?, contact_person = ?, summary = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
        input.caseId,
        input.occurredOn,
        input.channel,
        input.contactPerson,
        input.summary,
        ctx.user!.id,
        now,
        id,
      ]);
    } else {
      id = uuid();
      ctx.db.run(
        'INSERT INTO communications (id, client_id, case_id, occurred_on, channel, contact_person, summary, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, input.clientId, input.caseId, input.occurredOn, input.channel, input.contactPerson, input.summary, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'communication', entityId: id, caseId: input.caseId, clientId: input.clientId, summary: `سجل تواصل (${COMM_CHANNELS[input.channel].label}) بتاريخ ${input.occurredOn}` });
  });
  return { id };
}
