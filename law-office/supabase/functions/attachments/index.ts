// Supabase Edge Function: روابط مؤقتة لرفع المرفقات وتنزيلها من Backblaze B2 بعد التحقق من صلاحية المستخدم على الملف نفسه.
// الأسرار (مفاتيح B2 ومفتاح الخدمة) في متغيرات بيئة الدالة فقط — لا في التطبيقات ولا في المستودع:
//   supabase secrets set B2_ENDPOINT=... B2_REGION=... B2_BUCKET=... B2_KEY_ID=... B2_APP_KEY=...
// SUPABASE_URL وSUPABASE_ANON_KEY وSUPABASE_SERVICE_ROLE_KEY تتوفر تلقائيًا داخل دوال Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, type Req } from '../_shared/attachments.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, apikey', 'access-control-allow-methods': 'POST, OPTIONS' };

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
  const auth = request.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+/.test(auth)) return new Response(JSON.stringify({ error: 'auth required' }), { status: 401, headers: cors });
  const url = env('SUPABASE_URL');
  const user = createClient(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const service = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const rpc = (c: typeof user) => async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await c.rpc(name, args);
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`);
    return data;
  };
  let body: Req;
  try {
    body = (await request.json()) as Req;
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors });
  }
  const r = await handle(body, {
    userRpc: rpc(user),
    serviceRpc: rpc(service),
    b2: { endpoint: env('B2_ENDPOINT'), region: env('B2_REGION'), bucket: env('B2_BUCKET'), keyId: env('B2_KEY_ID'), appKey: env('B2_APP_KEY') },
    fetch,
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
});
