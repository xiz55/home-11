// دخول الأجهزة إلى «خادم المكتب»: كلمة المرور (بقواعد البرنامج نفسها وإيقافه المؤقت بعد المحاولات الخاطئة)،
// ثم رمز من 6 أرقام يُرسل إلى بريد المستخدم عند أول دخول من جهاز جديد، ومرة كل 15 يومًا للجهاز نفسه.
// الرموز ومفاتيح الأجهزة تُحفظ مجزأة (SHA-256) لا نصًا.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../main/db/db';

export const TRUST_DAYS = 15;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;

export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  kind: 'sync' | 'web';
  name: string | null;
  platform: string | null;
  created_at: string;
  last_seen: string | null;
  revoked_at: string | null;
  trusted_until: string | null;
}

export function ensureAuthSchema(db: Db) {
  const cols = new Set(db.all<{ name: string }>('PRAGMA table_info(hub_devices)').map((c) => c.name));
  if (!cols.has('trusted_until')) db.exec('ALTER TABLE hub_devices ADD COLUMN trusted_until TEXT');
}

export function userEmail(db: Db, userId: string): string | null {
  return db.get<{ email: string }>('SELECT email FROM hub_user_email WHERE user_id = ?', [userId])?.email ?? null;
}

export function maskEmail(e: string): string {
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

/** ينشئ رمز تحقق ويرسله بالبريد. يعيد معرّف التحدي (لا الرمز). */
export async function issueCode(db: Db, mailer: Mailer, now: Date, userId: string, purpose: 'web' | 'link', meta: Record<string, unknown>): Promise<{ challengeId: string; sentTo: string }> {
  const email = userEmail(db, userId);
  if (!email) throw new Error('NO_EMAIL');
  // حد إرسال: 5 رموز كل 15 دقيقة لكل مستخدم
  const since = new Date(now.getTime() - 15 * 60_000).toISOString();
  const recent = db.get<{ n: number }>("SELECT count(*) AS n FROM hub_codes WHERE user_id = ? AND json_extract(meta, '$.at') > ?", [userId, since])!.n;
  if (recent >= 5) throw new Error('TOO_MANY_CODES');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  db.run('INSERT INTO hub_codes (id, user_id, code_hash, purpose, meta, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    userId,
    sha(`${id}:${code}`),
    purpose,
    JSON.stringify({ ...meta, at: now.toISOString() }),
    new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(),
  ]);
  await mailer.send(
    email,
    `رمز الدخول: ${code}`,
    `رمز التحقق للدخول إلى برنامج المكتب من جهاز ${String(meta.deviceName ?? 'جديد')}:\n\n${code}\n\nصالح ${CODE_MINUTES} دقائق. إن لم تطلبه فلا تشاركه مع أحد، وغيّر كلمة مرورك.`,
  );
  return { challengeId: id, sentTo: maskEmail(email) };
}

/** يتحقق من الرمز: مرة واحدة، قبل انتهاء صلاحيته، و5 محاولات كحد أقصى. */
export function verifyCode(db: Db, now: Date, challengeId: string, code: string, purpose: 'web' | 'link'): { userId: string; meta: Record<string, unknown> } {
  const c = db.get<{ user_id: string; code_hash: string; purpose: string; meta: string; expires_at: string; attempts: number; used: number }>('SELECT * FROM hub_codes WHERE id = ?', [challengeId]);
  if (!c || c.purpose !== purpose || c.used) throw new Error('رمز غير صالح. اطلب رمزًا جديدًا.');
  if (c.expires_at < now.toISOString()) throw new Error('انتهت صلاحية الرمز. اطلب رمزًا جديدًا.');
  if (c.attempts >= CODE_ATTEMPTS) throw new Error('تجاوزت عدد المحاولات. اطلب رمزًا جديدًا.');
  db.run('UPDATE hub_codes SET attempts = attempts + 1 WHERE id = ?', [challengeId]);
  const a = Buffer.from(sha(`${challengeId}:${code.trim()}`));
  const b = Buffer.from(c.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('الرمز غير صحيح.');
  db.run('UPDATE hub_codes SET used = 1 WHERE id = ?', [challengeId]);
  return { userId: c.user_id, meta: JSON.parse(c.meta) };
}

export function createDevice(db: Db, now: Date, userId: string, kind: 'sync' | 'web', name: string, platform: string): { id: string; token: string } {
  const id = randomUUID();
  const token = newToken();
  db.run('INSERT INTO hub_devices (id, user_id, kind, name, platform, token_hash, created_at, last_seen, trusted_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    userId,
    kind,
    name.slice(0, 80),
    platform.slice(0, 30),
    sha(token),
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() + TRUST_DAYS * 86400_000).toISOString(),
  ]);
  return { id, token };
}

/** الجهاز بمفتاحه: غير ملغى. `trusted` = ما زال ضمن مدة الإعفاء من الرمز (15 يومًا). */
export function deviceByToken(db: Db, now: Date, token: string | null | undefined): (DeviceRow & { trusted: boolean }) | null {
  if (!token || token.length < 20) return null;
  const d = db.get<DeviceRow>('SELECT id, user_id, kind, name, platform, created_at, last_seen, revoked_at, trusted_until FROM hub_devices WHERE token_hash = ?', [sha(token)]);
  if (!d || d.revoked_at) return null;
  return { ...d, trusted: !!d.trusted_until && d.trusted_until > now.toISOString() };
}

export function renewTrust(db: Db, now: Date, deviceId: string) {
  db.run('UPDATE hub_devices SET trusted_until = ?, last_seen = ? WHERE id = ?', [new Date(now.getTime() + TRUST_DAYS * 86400_000).toISOString(), now.toISOString(), deviceId]);
}

export function touchDevice(db: Db, now: Date, deviceId: string) {
  db.run('UPDATE hub_devices SET last_seen = ? WHERE id = ?', [now.toISOString(), deviceId]);
}

/** محاولات الدخول من عنوان واحد: 20 كل 15 دقيقة (إضافة إلى إيقاف الحساب المؤقت في البرنامج نفسه). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 20,
    private windowMs = 15 * 60_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
