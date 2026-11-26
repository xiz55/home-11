// اتصال مباشر بقاعدة Supabase المحلية (صورة supabase/postgres) لاختبار السياسات والدوال كما يراها المستخدم المصادَق.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RpcTransport, OfflineError } from '../../src/sync/transport';

export const PG_URL = process.env.LAWSYNC_PG_URL ?? 'postgres://postgres:postgres@localhost:54322/postgres';
export const ADMIN_URL = process.env.LAWSYNC_PG_ADMIN_URL ?? 'postgres://supabase_admin:postgres@localhost:54322/postgres';

export async function pgAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch (e) {
    // في CI نطلب تشغيل القاعدة فعلًا: لا تُتخطى الاختبارات بصمت
    if (process.env.LAWSYNC_REQUIRE_PG) throw new Error(`cloud test database unavailable: ${(e as Error).message}`);
    return false;
  }
}

/** يطبق ترحيلات الخادم على قاعدة الاختبار، ويعيد تطبيقها إن تغيرت (قاعدة اختبار معزولة فقط). */
export async function ensureSchema() {
  const files = fs.readdirSync('supabase/migrations').sort();
  const sql = files.map((f) => fs.readFileSync(path.join('supabase/migrations', f), 'utf8')).join('\n');
  const hash = createHash('sha256').update(sql).digest('hex');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(fs.readFileSync(path.resolve('supabase/tests/bootstrap.sql'), 'utf8'));
    await admin.query('create table if not exists public._lawsync_test_meta (hash text)');
    const cur = await admin.query('select hash from public._lawsync_test_meta');
    if (cur.rows[0]?.hash === hash) return;
    await admin.query('drop schema public cascade; create schema public; grant usage on schema public to anon, authenticated, service_role; grant all on schema public to postgres;');
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    await c.query(sql);
    await c.end();
    await admin.query('create table public._lawsync_test_meta (hash text)');
    await admin.query('insert into public._lawsync_test_meta values ($1)', [hash]);
  } finally {
    await admin.end();
  }
}

export async function adminQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return (await admin.query(sql, params)).rows as T[];
  } finally {
    await admin.end();
  }
}

/** ينشئ مستخدم مصادقة وجلسة (ما تفعله Supabase Auth عند الدخول). */
export async function createAuthUser(email: string): Promise<{ userId: string; sessionId: string }> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await adminQuery('insert into auth.users (id, email, aud, role) values ($1, $2, $3, $3)', [userId, email, 'authenticated']);
  await adminQuery('insert into auth.sessions (id, user_id) values ($1, $2)', [sessionId, userId]);
  return { userId, sessionId };
}

export async function newSession(userId: string): Promise<string> {
  const sessionId = randomUUID();
  await adminQuery('insert into auth.sessions (id, user_id) values ($1, $2)', [sessionId, userId]);
  return sessionId;
}

/** نقل يمثل جهازًا مسجّل الدخول: دور authenticated ومطالبات JWT مثل Supabase تمامًا. */
export class PgTransport extends RpcTransport {
  offline = false;
  /** لمحاكاة ضياع الرد بعد تنفيذ الطلب في الخادم */
  dropNextResponse = false;
  calls: string[] = [];
  constructor(
    public userId: string,
    public sessionId: string,
    public aal: 'aal1' | 'aal2' = 'aal1',
  ) {
    super();
  }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.offline) throw new OfflineError();
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: this.userId, role: 'authenticated', session_id: this.sessionId, aal: this.aal })]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r.rows as T[];
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  async rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push(name);
    const keys = Object.keys(args);
    const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const vals = keys.map((k) => {
      const v = args[k];
      if (v !== null && typeof v === 'object' && !(name !== 'sync_push' && Array.isArray(v))) return JSON.stringify(v);
      return v;
    });
    const rows = await this.query<Record<string, unknown>>(sql, vals);
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new OfflineError('response lost');
    }
    // الدوال القياسية ترجع عمودًا واحدًا باسمها؛ دوال الجداول ترجع صفوفًا
    if (rows.length === 1 && Object.keys(rows[0]).length === 1 && name in rows[0]) return rows[0][name] as T;
    return rows as T;
  }
}
