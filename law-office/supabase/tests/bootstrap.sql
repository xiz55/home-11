-- للاختبار المحلي فقط: ما يوفره Supabase المُدار تلقائيًا (auth.jwt، auth.sessions) غير موجود في صورة Postgres الخام.
create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz default now(), aal text);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), auth.jwt() ->> 'sub'), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.jwt(), auth.uid() to authenticated;
grant select on auth.sessions to postgres;
