// التحقق من الصلاحيات على مستوى البيانات والعمليات — يُستدعى في كل خدمة، ولا يعتمد على إخفاء الأزرار.
import type { Ctx, SessionUser } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import type { Permission } from '../../shared/constants';

export function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new AppError('UNAUTHENTICATED', 'يجب تسجيل الدخول أولًا');
  return ctx.user;
}

export function isOwner(ctx: Ctx): boolean {
  return ctx.user?.role === 'owner';
}

export function requireOwner(ctx: Ctx): SessionUser {
  const u = requireUser(ctx);
  if (u.role !== 'owner') throw forbidden('هذا الإجراء متاح لصاحب المكتب فقط');
  return u;
}

export function hasPerm(ctx: Ctx, perm: Permission): boolean {
  const u = ctx.user;
  if (!u) return false;
  if (u.role === 'owner') return true;
  if (perm === 'fees.manage') return u.permissions.has('fees.manage') && u.permissions.has('fees.view');
  return u.permissions.has(perm);
}

export function requirePerm(ctx: Ctx, perm: Permission, msg?: string): void {
  requireUser(ctx);
  if (!hasPerm(ctx, perm)) throw forbidden(msg);
}

/** شرط SQL يقصر القضايا على المسموح بها. alias هو اسم جدول القضايا في الاستعلام. */
export function caseScope(ctx: Ctx, col = 'c.id'): { sql: string; params: Record<string, unknown> } {
  const u = requireUser(ctx);
  if (u.role === 'owner') return { sql: '1=1', params: {} };
  return {
    sql: `${col} IN (SELECT case_id FROM user_case_access WHERE user_id = :scope_uid)`,
    params: { scope_uid: u.id },
  };
}

/** شرط SQL للعملاء المرئيين: وصول كامل ممنوح أو قضية مسموحة واحدة على الأقل. */
export function clientScope(ctx: Ctx, col = 'cl.id'): { sql: string; params: Record<string, unknown> } {
  const u = requireUser(ctx);
  if (u.role === 'owner') return { sql: '1=1', params: {} };
  return {
    sql: `(${col} IN (SELECT client_id FROM user_client_access WHERE user_id = :scope_uid)
      OR ${col} IN (SELECT ca.client_id FROM cases ca JOIN user_case_access uca ON uca.case_id = ca.id WHERE uca.user_id = :scope_uid))`,
    params: { scope_uid: u.id },
  };
}

/** شرط للسجلات المرتبطة بعميل وقضية اختيارية (مستندات، ملاحظات، مهام...). */
export function linkedScope(
  ctx: Ctx,
  clientCol: string,
  caseCol: string,
): { sql: string; params: Record<string, unknown> } {
  const u = requireUser(ctx);
  if (u.role === 'owner') return { sql: '1=1', params: {} };
  return {
    sql: `((${caseCol} IS NOT NULL AND ${caseCol} IN (SELECT case_id FROM user_case_access WHERE user_id = :scope_uid))
      OR (${caseCol} IS NULL AND ${clientCol} IN (SELECT client_id FROM user_client_access WHERE user_id = :scope_uid)))`,
    params: { scope_uid: u.id },
  };
}

export function canAccessCase(ctx: Ctx, caseId: string): boolean {
  const u = requireUser(ctx);
  if (u.role === 'owner') return true;
  return !!ctx.db.get('SELECT 1 AS x FROM user_case_access WHERE user_id = ? AND case_id = ?', [u.id, caseId]);
}

export type ClientAccess = 'full' | 'basic' | 'none';

export function clientAccess(ctx: Ctx, clientId: string): ClientAccess {
  const u = requireUser(ctx);
  if (u.role === 'owner') return 'full';
  if (ctx.db.get('SELECT 1 AS x FROM user_client_access WHERE user_id = ? AND client_id = ?', [u.id, clientId]))
    return 'full';
  if (
    ctx.db.get(
      'SELECT 1 AS x FROM cases ca JOIN user_case_access uca ON uca.case_id = ca.id WHERE uca.user_id = ? AND ca.client_id = ?',
      [u.id, clientId],
    )
  )
    return 'basic';
  return 'none';
}

export interface CaseRow {
  id: string;
  client_id: string;
  file_no: string;
  title: string;
  status: string;
  archived: number;
  responsible_user_id: string | null;
}

export function requireCase(ctx: Ctx, caseId: string): CaseRow {
  requireUser(ctx);
  const c = ctx.db.get<CaseRow>(
    'SELECT id, client_id, file_no, title, status, archived, responsible_user_id FROM cases WHERE id = ?',
    [caseId],
  );
  if (!c) throw notFound('ملف القضية');
  if (!canAccessCase(ctx, caseId)) throw forbidden('لا تملك صلاحية الوصول إلى ملف هذه القضية');
  return c;
}

export function requireClient(ctx: Ctx, clientId: string, level: 'basic' | 'full' = 'basic') {
  requireUser(ctx);
  const c = ctx.db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM clients WHERE id = ?', [
    clientId,
  ]);
  if (!c) throw notFound('العميل');
  const a = clientAccess(ctx, clientId);
  if (a === 'none' || (level === 'full' && a !== 'full'))
    throw forbidden('لا تملك صلاحية الوصول إلى بيانات هذا العميل');
  return c;
}

/** وصول لسجل مرتبط بعميل وقضية اختيارية. */
export function requireLinked(ctx: Ctx, clientId: string, caseId: string | null): void {
  if (caseId) requireCase(ctx, caseId);
  else requireClient(ctx, clientId, 'full');
}

/** يمنع التعديل على ملف مؤرشف أو مقفل إلا بإعادة فتحه. */
export function requireCaseWritable(ctx: Ctx, caseId: string): CaseRow {
  const c = requireCase(ctx, caseId);
  if (c.archived) throw new AppError('CONFLICT', 'ملف القضية مؤرشف. ألغِ الأرشفة أولًا لإضافة أو تعديل بياناته.');
  return c;
}

/** يمنح المستخدم وصولًا لقضية (يُستخدم عند تعيين المسؤول أو إنشاء المستشار لقضية). */
export function grantCase(ctx: Ctx, userId: string, caseId: string): void {
  const target = ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  if (!target || target.role === 'owner') return;
  ctx.db.run(
    'INSERT OR IGNORE INTO user_case_access (user_id, case_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    [userId, caseId, ctx.user?.id ?? null, ctx.now().toISOString()],
  );
}

export function grantClient(ctx: Ctx, userId: string, clientId: string): void {
  const target = ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', [userId]);
  if (!target || target.role === 'owner') return;
  ctx.db.run(
    'INSERT OR IGNORE INTO user_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    [userId, clientId, ctx.user?.id ?? null, ctx.now().toISOString()],
  );
}
