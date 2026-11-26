// المصادقة: تجزئة كلمات المرور بـ scrypt (من مكتبة التشفير المدمجة في Node/Electron)، ورمز استعادة للمالك.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Ctx, SessionUser } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { normalizeArabic } from '../../shared/text';
import { DEFAULT_CONSULTANT_PERMISSIONS, PERMISSION_KEYS, type Permission, type Role } from '../../shared/constants';
import { logActivity } from './activity';
import { requireOwner, requireUser } from './access';
import { writeSetting } from './settings';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function scrypt(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret.normalize('NFC'), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(secret.normalize('NFC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += RC_ALPHABET[bytes[i] % RC_ALPHABET.length];
  return s.match(/.{5}/g)!.join('-');
}
function normalizeRecoveryCode(c: string): string {
  return c.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normUsername(u: string): string {
  return normalizeArabic(u).replace(/\s+/g, '');
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  recovery_hash: string | null;
  permissions: string;
  active: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function toSessionUser(row: UserRow): SessionUser {
  let perms: Permission[] = [];
  try {
    perms = (JSON.parse(row.permissions) as string[]).filter((p): p is Permission =>
      (PERMISSION_KEYS as string[]).includes(p),
    );
  } catch {
    perms = [];
  }
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, permissions: new Set(perms) };
}

export function loadSessionUser(ctx: Ctx, userId: string): SessionUser | null {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row || !row.active) return null;
  return toSessionUser(row);
}

export function isInitialized(ctx: Ctx): boolean {
  const r = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM users WHERE role = 'owner'");
  return (r?.n ?? 0) > 0;
}

export async function setupOwner(
  ctx: Ctx,
  input: { officeName: string; displayName: string; username: string; password: string },
): Promise<{ user: SessionUser; recoveryCode: string }> {
  if (isInitialized(ctx)) throw forbidden('تم إنشاء حساب صاحب المكتب مسبقًا');
  const passwordHash = await hashSecret(input.password);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode));
  const now = ctx.now().toISOString();
  const id = uuid();
  ctx.db.tx(() => {
    if (isInitialized(ctx)) throw forbidden('تم إنشاء حساب صاحب المكتب مسبقًا');
    ctx.db.run(
      `INSERT INTO users (id, username, username_norm, display_name, role, password_hash, recovery_hash, permissions, active, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, 'owner', ?, ?, '[]', 1, ?, ?, ?)`,
      [id, input.username, normUsername(input.username), input.displayName, passwordHash, recoveryHash, now, now, now],
    );
    writeSetting(ctx.db, 'office.name', input.officeName, now);
    logActivity(
      ctx,
      { action: 'create', entityType: 'user', entityId: id, summary: `إنشاء حساب صاحب المكتب (${input.username})` },
      { id, username: input.username },
    );
  });
  return { user: loadSessionUser(ctx, id)!, recoveryCode };
}

const MAX_ATTEMPTS = 5;

export async function login(ctx: Ctx, input: { username: string; password: string }): Promise<SessionUser> {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE username_norm = ?', [normUsername(input.username)]);
  const generic = new AppError('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if (!row) {
    // وقت تحقق مماثل لتقليل كشف وجود الحساب
    await hashSecret(input.password);
    logActivity(ctx, { action: 'login_failed', entityType: 'user', summary: `محاولة دخول باسم غير موجود (${input.username.slice(0, 40)})` }, null);
    throw generic;
  }
  const now = ctx.now();
  if (row.locked_until && new Date(row.locked_until) > now) {
    const secs = Math.ceil((new Date(row.locked_until).getTime() - now.getTime()) / 1000);
    throw new AppError('UNAUTHENTICATED', `تم إيقاف المحاولات مؤقتًا بسبب تكرار الخطأ. حاول بعد ${secs} ثانية.`);
  }
  if (!row.active) throw new AppError('UNAUTHENTICATED', 'هذا الحساب موقوف. راجع صاحب المكتب.');
  const ok = await verifySecret(input.password, row.password_hash);
  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(now.getTime() + 60_000 * Math.min(attempts - MAX_ATTEMPTS + 1, 15)).toISOString() : null;
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [attempts, lockedUntil, row.id]);
      logActivity(ctx, { action: 'login_failed', entityType: 'user', entityId: row.id, summary: `كلمة مرور خاطئة للمستخدم ${row.username}` }, { id: row.id, username: row.username });
    });
    throw generic;
  }
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [now.toISOString(), row.id]);
    logActivity(ctx, { action: 'login', entityType: 'user', entityId: row.id, summary: `دخول ${row.display_name}` }, { id: row.id, username: row.username });
  });
  return toSessionUser(row);
}

export async function verifyUserPassword(ctx: Ctx, userId: string, password: string): Promise<boolean> {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row || !row.active) return false;
  return verifySecret(password, row.password_hash);
}

export async function recoverOwner(
  ctx: Ctx,
  input: { username: string; recoveryCode: string; newPassword: string },
): Promise<{ user: SessionUser; recoveryCode: string }> {
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE username_norm = ?', [normUsername(input.username)]);
  const generic = new AppError('UNAUTHENTICATED', 'اسم المستخدم أو رمز الاستعادة غير صحيح');
  if (!row || row.role !== 'owner') {
    await hashSecret(input.recoveryCode);
    throw generic;
  }
  const now = ctx.now();
  if (row.locked_until && new Date(row.locked_until) > now) throw new AppError('UNAUTHENTICATED', 'تم إيقاف المحاولات مؤقتًا. حاول بعد قليل.');
  const ok = await verifySecret(normalizeRecoveryCode(input.recoveryCode), row.recovery_hash);
  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(now.getTime() + 120_000).toISOString() : null;
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [attempts, lockedUntil, row.id]);
      logActivity(ctx, { action: 'login_failed', entityType: 'user', entityId: row.id, summary: 'رمز استعادة خاطئ' }, { id: row.id, username: row.username });
    });
    throw generic;
  }
  const newHash = await hashSecret(input.newPassword);
  const newCode = generateRecoveryCode();
  const newRecHash = await hashSecret(normalizeRecoveryCode(newCode));
  ctx.db.tx(() => {
    ctx.db.run(
      'UPDATE users SET password_hash = ?, recovery_hash = ?, failed_attempts = 0, locked_until = NULL, active = 1, updated_at = ?, last_login_at = ? WHERE id = ?',
      [newHash, newRecHash, now.toISOString(), now.toISOString(), row.id],
    );
    logActivity(ctx, { action: 'password', entityType: 'user', entityId: row.id, summary: 'استعادة وصول صاحب المكتب برمز الاستعادة وتعيين كلمة مرور جديدة' }, { id: row.id, username: row.username });
  });
  return { user: loadSessionUser(ctx, row.id)!, recoveryCode: newCode };
}

export async function changePassword(ctx: Ctx, input: { currentPassword: string; newPassword: string }) {
  const u = requireUser(ctx);
  if (!(await verifyUserPassword(ctx, u.id, input.currentPassword)))
    throw new AppError('VALIDATION', 'كلمة المرور الحالية غير صحيحة', { currentPassword: 'كلمة المرور الحالية غير صحيحة' });
  const h = await hashSecret(input.newPassword);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [h, ctx.now().toISOString(), u.id]);
    logActivity(ctx, { action: 'password', entityType: 'user', entityId: u.id, summary: 'تغيير كلمة المرور' });
  });
  return { ok: true };
}

export async function regenerateRecoveryCode(ctx: Ctx, input: { password: string }) {
  const u = requireOwner(ctx);
  if (!(await verifyUserPassword(ctx, u.id, input.password)))
    throw new AppError('VALIDATION', 'كلمة المرور غير صحيحة', { password: 'كلمة المرور غير صحيحة' });
  const code = generateRecoveryCode();
  const h = await hashSecret(normalizeRecoveryCode(code));
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET recovery_hash = ?, updated_at = ? WHERE id = ?', [h, ctx.now().toISOString(), u.id]);
    logActivity(ctx, { action: 'password', entityType: 'user', entityId: u.id, summary: 'إصدار رمز استعادة جديد (الرمز السابق لم يعد صالحًا)' });
  });
  return { recoveryCode: code };
}

// ———————— إدارة المستخدمين (لصاحب المكتب فقط) ————————

export function listUsers(ctx: Ctx) {
  requireOwner(ctx);
  return ctx.db
    .all<UserRow & { case_count: number; client_count: number }>(
      `SELECT u.*, (SELECT count(*) FROM user_case_access a WHERE a.user_id = u.id) AS case_count,
              (SELECT count(*) FROM user_client_access a WHERE a.user_id = u.id) AS client_count
       FROM users u ORDER BY u.role DESC, u.display_name`,
    )
    .map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      active: !!r.active,
      permissions: toSessionUser(r).permissions.size ? [...toSessionUser(r).permissions] : [],
      caseCount: r.case_count,
      clientCount: r.client_count,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    }));
}

/** قائمة مختصرة للمستخدمين النشطين لاختيار المسؤول — متاحة لكل مستخدم مسجل. */
export function listAssignableUsers(ctx: Ctx) {
  requireUser(ctx);
  return ctx.db.all<{ id: string; display_name: string; role: Role }>(
    'SELECT id, display_name, role FROM users WHERE active = 1 ORDER BY role DESC, display_name',
  ).map((r) => ({ id: r.id, displayName: r.display_name, role: r.role }));
}

export async function createUser(
  ctx: Ctx,
  input: { displayName: string; username: string; password: string; permissions: Permission[] },
) {
  requireOwner(ctx);
  const norm = normUsername(input.username);
  if (ctx.db.get('SELECT id FROM users WHERE username_norm = ?', [norm]))
    throw new AppError('VALIDATION', 'اسم المستخدم مستخدم مسبقًا', { username: 'اسم المستخدم مستخدم مسبقًا' });
  const h = await hashSecret(input.password);
  const id = uuid();
  const now = ctx.now().toISOString();
  const perms = input.permissions.length ? input.permissions : DEFAULT_CONSULTANT_PERMISSIONS;
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO users (id, username, username_norm, display_name, role, password_hash, permissions, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'consultant', ?, ?, 1, ?, ?)`,
      [id, input.username, norm, input.displayName, h, JSON.stringify(perms), now, now],
    );
    logActivity(ctx, { action: 'create', entityType: 'user', entityId: id, summary: `إنشاء حساب مستشار: ${input.displayName} (${input.username})`, details: { permissions: perms } });
  });
  return { id };
}

export function updateUser(ctx: Ctx, input: { id: string; displayName: string; active: boolean; permissions: Permission[] }) {
  const me = requireOwner(ctx);
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [input.id]);
  if (!row) throw notFound('المستخدم');
  if (row.role === 'owner' && !input.active) throw forbidden('لا يمكن إيقاف حساب صاحب المكتب');
  if (row.id === me.id && !input.active) throw forbidden('لا يمكنك إيقاف حسابك');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET display_name = ?, active = ?, permissions = ?, updated_at = ? WHERE id = ?', [
      input.displayName,
      input.active ? 1 : 0,
      JSON.stringify(row.role === 'owner' ? [] : input.permissions),
      ctx.now().toISOString(),
      input.id,
    ]);
    logActivity(ctx, {
      action: 'permissions',
      entityType: 'user',
      entityId: input.id,
      summary: `تعديل حساب ${input.displayName}${input.active ? '' : ' (موقوف)'}`,
      details: { permissions: input.permissions, active: input.active },
    });
  });
  return { ok: true };
}

export async function resetUserPassword(ctx: Ctx, input: { id: string; newPassword: string }) {
  requireOwner(ctx);
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [input.id]);
  if (!row) throw notFound('المستخدم');
  if (row.role === 'owner') throw forbidden('استخدم «تغيير كلمة المرور» لحساب صاحب المكتب');
  const h = await hashSecret(input.newPassword);
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [h, ctx.now().toISOString(), input.id]);
    logActivity(ctx, { action: 'password', entityType: 'user', entityId: input.id, summary: `تعيين كلمة مرور جديدة للمستخدم ${row.username}` });
  });
  return { ok: true };
}

export function getUserAccess(ctx: Ctx, input: { userId: string }) {
  requireOwner(ctx);
  return {
    caseIds: ctx.db.all<{ case_id: string }>('SELECT case_id FROM user_case_access WHERE user_id = ?', [input.userId]).map((r) => r.case_id),
    clientIds: ctx.db.all<{ client_id: string }>('SELECT client_id FROM user_client_access WHERE user_id = ?', [input.userId]).map((r) => r.client_id),
  };
}

export function setUserAccess(ctx: Ctx, input: { userId: string; caseIds: string[]; clientIds: string[] }) {
  requireOwner(ctx);
  const row = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [input.userId]);
  if (!row) throw notFound('المستخدم');
  if (row.role === 'owner') throw forbidden('صاحب المكتب يصل إلى كل الملفات تلقائيًا');
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM user_case_access WHERE user_id = ?', [input.userId]);
    ctx.db.run('DELETE FROM user_client_access WHERE user_id = ?', [input.userId]);
    for (const cid of new Set(input.caseIds)) {
      if (!ctx.db.get('SELECT id FROM cases WHERE id = ?', [cid])) continue;
      ctx.db.run('INSERT INTO user_case_access (user_id, case_id, granted_by, granted_at) VALUES (?, ?, ?, ?)', [input.userId, cid, ctx.user!.id, now]);
    }
    for (const cid of new Set(input.clientIds)) {
      if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', [cid])) continue;
      ctx.db.run('INSERT INTO user_client_access (user_id, client_id, granted_by, granted_at) VALUES (?, ?, ?, ?)', [input.userId, cid, ctx.user!.id, now]);
    }
    logActivity(ctx, {
      action: 'permissions',
      entityType: 'user',
      entityId: input.userId,
      summary: `تحديد الملفات المسموحة للمستخدم ${row.username}: ${input.caseIds.length} قضية، ${input.clientIds.length} عميل`,
    });
  });
  return { ok: true };
}
