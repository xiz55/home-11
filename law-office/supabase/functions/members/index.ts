// Supabase Edge Function: إنشاء حساب سحابي لمستشار وربطه بمستخدمه في المكتب. يستدعيها صاحب المكتب فقط.
// مفتاح الخدمة يبقى داخل الدالة. كلمة المرور المؤقتة تُعرض لصاحب المكتب مرة واحدة ليسلمها للمستشار، ويغيرها عند أول دخول.
import { createClient } from 'npm:@supabase/supabase-js@2';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };
const env = (k: string) => Deno.env.get(k) ?? '';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, apikey', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

function tempPassword() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('') + '#7';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const auth = req.headers.get('authorization') ?? '';
  if (!auth) return json(401, { error: 'auth required' });
  const user = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const b = (await req.json().catch(() => ({}))) as { action?: string; office_id?: string; email?: string; local_user_id?: string; display_name?: string; permissions?: string[] };
  if (b.action !== 'invite' || !b.office_id || !b.email || !b.local_user_id) return json(400, { error: 'bad request' });
  const { data: owner } = await user.rpc('app_is_owner', { p_office: b.office_id });
  if (owner !== true) return json(403, { error: 'owner only' });
  const email = b.email.trim().toLowerCase();
  let userId: string | null = null;
  let password: string | undefined;
  const created = await service.auth.admin.createUser({ email, password: (password = tempPassword()), email_confirm: true });
  if (created.error) {
    // الحساب موجود مسبقًا: لا نغير كلمة مروره
    password = undefined;
    const list = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = list.data?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
    if (!userId) return json(409, { error: created.error.message });
  } else userId = created.data.user.id;
  const { error } = await user.rpc('app_link_member', { p_office: b.office_id, p_user: userId, p_local_user: b.local_user_id, p_display_name: b.display_name ?? email, p_permissions: b.permissions ?? [] });
  if (error) return json(400, { error: error.message });
  return json(200, { ok: true, existing: !password, temporaryPassword: password });
});
