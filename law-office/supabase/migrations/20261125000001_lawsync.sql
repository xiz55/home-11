-- مزامنة برنامج إدارة مكتب المحاماة — قاعدة البيانات المركزية (Supabase / PostgreSQL 15+)
-- كل الجداول محمية بـ RLS. الأسرار (مفاتيح B2، مفتاح الخدمة) لا تُخزن هنا ولا في التطبيقات.

create extension if not exists pgcrypto;

-- ———————————————— الجداول ————————————————

create table public.offices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  require_mfa boolean not null default false,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.office_members (
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid not null,                         -- auth.users.id
  local_user_id uuid not null,                   -- users.id في قاعدة التطبيق
  role text not null check (role in ('owner','consultant')),
  permissions text[] not null default '{}',
  active boolean not null default true,
  display_name text,
  access_version bigint not null default 1,      -- يتغير عند تغيير نطاق الوصول ← إعادة مزامنة كاملة
  created_at timestamptz not null default now(),
  primary key (office_id, user_id),
  unique (office_id, local_user_id)
);

create table public.records (
  office_id uuid not null references public.offices(id) on delete cascade,
  tbl text not null,
  rid text not null,
  data jsonb not null,
  version bigint not null default 1,
  seq bigint not null,
  deleted boolean not null default false,
  client_id uuid,
  case_id uuid,
  consultation_id uuid,
  meeting_id uuid,
  user_refs uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (office_id, tbl, rid)
);
create sequence public.records_seq;
create index records_pull on public.records (office_id, seq);
create index records_case on public.records (office_id, case_id);
create index records_client on public.records (office_id, client_id);

create table public.member_case_access (
  office_id uuid not null, local_user_id uuid not null, case_id uuid not null,
  primary key (office_id, local_user_id, case_id)
);
create table public.member_client_access (
  office_id uuid not null, local_user_id uuid not null, client_id uuid not null,
  primary key (office_id, local_user_id, client_id)
);

create table public.sync_ops (
  op_id uuid primary key,
  office_id uuid not null,
  user_id uuid not null default auth.uid(),
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  tbl text not null,
  rid text not null,
  fields text[] not null,
  base_data jsonb,
  server_data jsonb not null,
  client_data jsonb not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

create table public.devices (
  id uuid primary key,                           -- معرف ثابت يولده الجهاز
  office_id uuid not null references public.offices(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  session_id uuid,
  device_name text not null,
  platform text not null,
  app_version text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid
);

create table public.office_counters (
  office_id uuid not null references public.offices(id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (office_id, name)
);

-- حالة رفع كل نسخة مرفق — مستقلة عن سجل المستند (لا يُعد مكتملًا قبل التحقق)
create table public.blobs (
  office_id uuid not null references public.offices(id) on delete cascade,
  version_id uuid not null,
  object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size > 0 and size <= 157286400),
  ext text not null,
  status text not null default 'pending' check (status in ('pending','verified')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  primary key (office_id, version_id)
);

-- ———————————————— دوال الهوية والجلسة ————————————————

create or replace function public.app_session_id() returns uuid
language sql stable as $$ select nullif(coalesce(auth.jwt() ->> 'session_id', ''), '')::uuid $$;

/** الجلسة سارية: لم يلغها المالك، وما زالت قائمة في جلسات المصادقة، وتحقق الخطوتين إن كان إلزاميًا. */
create or replace function public.app_auth_session_exists() returns boolean
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if app_session_id() is null then return true; end if;
  return exists (select 1 from auth.sessions s where s.id = app_session_id());
exception when insufficient_privilege or undefined_table then
  return true; -- إن لم يُتح جدول الجلسات، يبقى الاعتماد على علامة الإلغاء في devices
end $$;

create or replace function public.app_session_ok(p_office uuid) returns boolean
language sql stable security definer set search_path = public, auth as $$
  select auth.uid() is not null
    and app_auth_session_exists()
    and not exists (select 1 from devices d where d.office_id = p_office and d.session_id = app_session_id() and d.revoked_at is not null)
    and (not coalesce((select require_mfa from offices where id = p_office), false) or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
$$;

create or replace function public.app_member(p_office uuid) returns office_members
language sql stable security definer set search_path = public as $$
  select m.* from office_members m where m.office_id = p_office and m.user_id = auth.uid() and m.active and app_session_ok(p_office)
$$;

create or replace function public.app_is_owner(p_office uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'owner' from app_member(p_office)), false)
$$;

create or replace function public.app_has_perm(p_office uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.role = 'owner' or (p_perm = any(m.permissions) and (p_perm <> 'fees.manage' or 'fees.view' = any(m.permissions))) from app_member(p_office) m), false)
$$;

-- ———————————————— نطاق السجل (يحسبه الخادم من البيانات) ————————————————

create or replace function public.app_uuid(v text) returns uuid language sql immutable as $$
  select case when v ~ '^[0-9a-fA-F-]{36}$' then v::uuid else null end
$$;

create or replace function public.app_parent(p_office uuid, p_tbl text, p_rid text) returns public.records
language sql stable security definer set search_path = public as $$
  select * from records where office_id = p_office and tbl = p_tbl and rid = p_rid
$$;

/** يحسب أعمدة النطاق للسجل؛ السجلات الفرعية ترث نطاق السجل الأب. */
create or replace function public.app_compute_scope(r public.records) returns public.records
language plpgsql stable security definer set search_path = public as $$
declare
  d jsonb := r.data;
  base text := split_part(r.tbl, '$', 1);
  p public.records;
begin
  r.client_id := app_uuid(d ->> 'client_id');
  r.case_id := app_uuid(d ->> 'case_id');
  r.consultation_id := app_uuid(d ->> 'consultation_id');
  r.meeting_id := app_uuid(d ->> 'meeting_id');
  if base = 'clients' then r.client_id := app_uuid(r.rid); end if;
  if base = 'cases' then r.case_id := app_uuid(r.rid); end if;
  if base = 'consultations' then r.consultation_id := app_uuid(r.rid); end if;
  if base = 'meetings' then r.meeting_id := app_uuid(r.rid); r.consultation_id := null; end if;
  -- السجلات الفرعية
  if base in ('hearing_changes') then p := app_parent(r.office_id, 'hearings', d ->> 'hearing_id');
  elsif base in ('document_versions') then p := app_parent(r.office_id, 'documents', d ->> 'document_id');
  elsif base in ('memo_revisions','memo_submissions') then p := app_parent(r.office_id, 'memos', d ->> 'memo_id');
  elsif base = 'opinion_revisions' then p := app_parent(r.office_id, 'consultation_opinions', d ->> 'opinion_id');
  elsif base = 'meeting_items' then p := app_parent(r.office_id, 'meetings', d ->> 'meeting_id');
  elsif base = 'fee_items' then p := app_parent(r.office_id, 'contracts', d ->> 'contract_id');
  elsif base in ('contract_cases') then p := app_parent(r.office_id, 'contracts', d ->> 'contract_id');
  elsif base in ('poa_cases') then p := app_parent(r.office_id, 'poas', d ->> 'poa_id');
  elsif base = 'appointment_changes' then
    p := app_parent(r.office_id, case when d ->> 'entity_type' = 'meeting' then 'meetings' else 'consultations' end, d ->> 'entity_id');
  end if;
  if p.rid is not null then
    r.client_id := coalesce(r.client_id, p.client_id);
    r.case_id := coalesce(r.case_id, p.case_id);
    r.consultation_id := coalesce(r.consultation_id, p.consultation_id);
    r.meeting_id := coalesce(r.meeting_id, p.meeting_id);
    r.user_refs := p.user_refs;
  else
    r.user_refs := array_remove(array[
      app_uuid(d ->> 'responsible_user_id'), app_uuid(d ->> 'created_by'), app_uuid(d ->> 'assignee_user_id'),
      case when base in ('user_case_access','user_client_access','users') then app_uuid(coalesce(d ->> 'user_id', case when base = 'users' then r.rid end)) end
    ], null);
  end if;
  return r;
end $$;

-- ———————————————— قواعد القراءة والكتابة ————————————————

create or replace function public.app_case_ok(p_office uuid, p_local uuid, p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_case is not null and exists (select 1 from member_case_access a where a.office_id = p_office and a.local_user_id = p_local and a.case_id = p_case)
$$;
create or replace function public.app_client_full(p_office uuid, p_local uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_client is not null and exists (select 1 from member_client_access a where a.office_id = p_office and a.local_user_id = p_local and a.client_id = p_client)
$$;

create or replace function public.app_finance_table(p_tbl text) returns boolean language sql immutable as $$
  select p_tbl like '%$fin' or p_tbl in ('fee_items','payments','expenses','contract_adjustments','service_txns')
$$;

create or replace function public.app_can_read(r public.records) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  m office_members;
  base text := split_part(r.tbl, '$', 1);
  appt boolean;
begin
  select * into m from app_member(r.office_id);
  if m.user_id is null then return false; end if;
  if m.role = 'owner' then return true; end if;
  -- مشتركة للقراءة لكل الأعضاء (الأسماء، القوائم، إعدادات المكتب)
  if base in ('users','lookups','settings') then return true; end if;
  if base in ('activity_log') then return false; end if;
  if app_finance_table(r.tbl) and not ('fees.view' = any(m.permissions)) then return false; end if;
  if base in ('user_case_access','user_client_access') then return m.local_user_id = any(r.user_refs); end if;
  -- الاستشارات والاجتماعات
  if r.consultation_id is not null or r.meeting_id is not null then
    appt := 'consultations.viewAll' = any(m.permissions) or m.local_user_id = any(r.user_refs)
      or app_case_ok(r.office_id, m.local_user_id, r.case_id) or app_client_full(r.office_id, m.local_user_id, r.client_id);
    if appt then return true; end if;
    if r.consultation_id is not null then
      select true into appt from records c where c.office_id = r.office_id and c.tbl = 'consultations' and c.rid = r.consultation_id::text
        and (m.local_user_id = any(c.user_refs) or app_case_ok(r.office_id, m.local_user_id, c.case_id) or app_client_full(r.office_id, m.local_user_id, c.client_id));
      if coalesce(appt, false) then return true; end if;
    end if;
    if r.meeting_id is not null then
      select true into appt from records c where c.office_id = r.office_id and c.tbl = 'meetings' and c.rid = r.meeting_id::text
        and (m.local_user_id = any(c.user_refs) or app_case_ok(r.office_id, m.local_user_id, c.case_id) or app_client_full(r.office_id, m.local_user_id, c.client_id));
      if coalesce(appt, false) then return true; end if;
    end if;
    return false;
  end if;
  if base = 'tasks' and m.local_user_id = any(r.user_refs) then return true; end if;
  if r.case_id is not null then return app_case_ok(r.office_id, m.local_user_id, r.case_id); end if;
  if base = 'clients' then
    return app_client_full(r.office_id, m.local_user_id, r.client_id)
      or exists (select 1 from records c join member_case_access a on a.office_id = c.office_id and a.case_id = c.case_id and a.local_user_id = m.local_user_id
                 where c.office_id = r.office_id and c.tbl = 'cases' and c.client_id = r.client_id);
  end if;
  if r.client_id is not null then return app_client_full(r.office_id, m.local_user_id, r.client_id); end if;
  return false;
end $$;

create or replace function public.app_can_write(r public.records) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  m office_members;
  base text := split_part(r.tbl, '$', 1);
begin
  select * into m from app_member(r.office_id);
  if m.user_id is null then return false; end if;
  if m.role = 'owner' then return true; end if;
  if base in ('users','lookups','settings','user_case_access','user_client_access') then return false; end if;
  if base = 'activity_log' then return (r.data ->> 'user_id') = m.local_user_id::text; end if;
  if app_finance_table(r.tbl) and not app_has_perm(r.office_id, 'fees.manage') then return false; end if;
  if base = 'clients' and not exists (select 1 from records x where x.office_id = r.office_id and x.tbl = r.tbl and x.rid = r.rid) then
    return 'clients.create' = any(m.permissions) or 'consultations.manage' = any(m.permissions);
  end if;
  return app_can_read(r);
end $$;

-- ———————————————— RLS ————————————————

alter table public.offices enable row level security;
alter table public.office_members enable row level security;
alter table public.records enable row level security;
alter table public.member_case_access enable row level security;
alter table public.member_client_access enable row level security;
alter table public.sync_ops enable row level security;
alter table public.sync_conflicts enable row level security;
alter table public.devices enable row level security;
alter table public.office_counters enable row level security;
alter table public.blobs enable row level security;

create policy offices_read on public.offices for select using ((app_member(id)).user_id is not null);
create policy offices_owner_update on public.offices for update using (app_is_owner(id)) with check (app_is_owner(id));
create policy members_read on public.office_members for select using (user_id = auth.uid() or app_is_owner(office_id));
create policy records_read on public.records for select using (app_can_read(records));
create policy records_insert on public.records for insert with check (app_can_write(records));
create policy records_update on public.records for update using (app_can_write(records)) with check (app_can_write(records));
create policy mca_read on public.member_case_access for select using (app_is_owner(office_id));
create policy mcl_read on public.member_client_access for select using (app_is_owner(office_id));
create policy ops_own on public.sync_ops for select using (user_id = auth.uid());
create policy ops_insert on public.sync_ops for insert with check (user_id = auth.uid() and (app_member(office_id)).user_id is not null);
create policy conflicts_insert on public.sync_conflicts for insert with check (created_by = auth.uid() and (app_member(office_id)).user_id is not null);
create policy conflicts_read on public.sync_conflicts for select using (created_by = auth.uid() or app_is_owner(office_id));
create policy conflicts_resolve on public.sync_conflicts for update using (created_by = auth.uid() or app_is_owner(office_id));
create policy devices_read on public.devices for select using (user_id = auth.uid() or app_is_owner(office_id));
create policy blobs_read on public.blobs for select using (
  exists (select 1 from records r where r.office_id = blobs.office_id and r.tbl = 'document_versions' and r.rid = blobs.version_id::text and app_can_read(r)));

-- لا حذف فعلي من التطبيقات؛ الحذف علامة deleted
revoke delete on public.records from authenticated, anon;
revoke all on public.member_case_access, public.member_client_access, public.office_counters from anon;
revoke insert, update, delete on public.member_case_access, public.member_client_access, public.office_counters, public.sync_ops, public.blobs, public.devices, public.office_members, public.offices from authenticated;
revoke all on all tables in schema public from anon;

-- ———————————————— مشغلات الخادم ————————————————

create or replace function public.app_records_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new := app_compute_scope(new);
  new.seq := nextval('records_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_before before insert or update on public.records for each row execute function app_records_before();

/** نطاق الوصول وصلاحيات الأعضاء تُشتق من سجلات التطبيق نفسها. */
create or replace function public.app_records_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := split_part(new.tbl, '$', 1);
begin
  if base = 'user_case_access' then
    if new.deleted then delete from member_case_access where office_id = new.office_id and local_user_id = app_uuid(new.data ->> 'user_id') and case_id = app_uuid(new.data ->> 'case_id');
    else insert into member_case_access values (new.office_id, app_uuid(new.data ->> 'user_id'), app_uuid(new.data ->> 'case_id')) on conflict do nothing; end if;
    update office_members set access_version = access_version + 1 where office_id = new.office_id and local_user_id = app_uuid(new.data ->> 'user_id');
  elsif base = 'user_client_access' then
    if new.deleted then delete from member_client_access where office_id = new.office_id and local_user_id = app_uuid(new.data ->> 'user_id') and client_id = app_uuid(new.data ->> 'client_id');
    else insert into member_client_access values (new.office_id, app_uuid(new.data ->> 'user_id'), app_uuid(new.data ->> 'client_id')) on conflict do nothing; end if;
    update office_members set access_version = access_version + 1 where office_id = new.office_id and local_user_id = app_uuid(new.data ->> 'user_id');
  elsif base = 'users' then
    update office_members set
      permissions = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce((new.data ->> 'permissions')::jsonb, '[]'::jsonb)) x), '{}'),
      active = coalesce((new.data ->> 'active')::int, 1) = 1 and not new.deleted,
      display_name = new.data ->> 'display_name',
      access_version = access_version + 1
    where office_id = new.office_id and local_user_id = app_uuid(new.rid) and role <> 'owner';
  end if;
  return null;
end $$;
create trigger records_after after insert or update on public.records for each row execute function app_records_after();

-- ———————————————— الدفع (Push) ————————————————

create or replace function public.app_text_field(p_tbl text, p_key text) returns boolean language sql immutable as $$
  select (split_part(p_tbl, '$', 1), p_key) in (
    ('memos','body'),('memos','title'),('consultation_opinions','body'),('case_analysis','sections'),('notes','body'),('hearings','summary'),
    ('hearings','outcome'),('consultations','description'),('consultations','questions'),('consultations','internal_notes'),('meetings','minutes'),
    ('meetings','agenda'),('cases','notes'),('cases','subject'),('cases','requests'),('clients','notes'),('judgments','summary'),('evidence_items','statement'))
$$;

/**
 * يطبق دفعة تغييرات من جهاز. لكل تغيير: op_id فريد (إعادة الإرسال لا تكرر)، base_version وbase (آخر نسخة رآها الجهاز).
 * - لا تعارض: تطبيق مباشر.
 * - تعارض في حقول مختلفة: دمج آمن.
 * - تعارض في الحقل نفسه: تبقى قيمة الخادم، وتُحفظ قيمة الجهاز في sync_conflicts للمراجعة (لا استبدال صامت).
 * - المحذوف لا يُعاد إحياؤه. الحركات المالية لا تُعدل مبالغها، والإلغاء لا يُتراجع عنه.
 */
create or replace function public.sync_push(p_office uuid, p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  ch jsonb;
  out jsonb := '[]'::jsonb;
  res jsonb;
  cur public.records;
  newdata jsonb;
  basedata jsonb;
  merged jsonb;
  k text;
  conflict_keys text[];
  fin_locked text[] := array['amount','paid_on','txn_on','adjusted_on','kind','contract_id','client_id','consultation_id','meeting_id','fee_item_id','is_advance'];
  base text;
begin
  if (app_member(p_office)).user_id is null then raise exception 'not a member or session revoked' using errcode = '42501'; end if;
  for ch in select value from jsonb_array_elements(p_changes) loop
    select result into res from sync_ops where op_id = (ch ->> 'op_id')::uuid;
    if found then out := out || jsonb_build_array(res); continue; end if;
    begin
    base := split_part(ch ->> 'tbl', '$', 1);
    newdata := ch -> 'data';
    basedata := ch -> 'base';
    conflict_keys := '{}';
    select * into cur from records where office_id = p_office and tbl = ch ->> 'tbl' and rid = ch ->> 'rid' for update;
    if not found then
      insert into records (office_id, tbl, rid, data, version, seq, deleted)
        values (p_office, ch ->> 'tbl', ch ->> 'rid', coalesce(newdata, '{}'::jsonb), 1, 0, coalesce((ch ->> 'op') = 'delete', false))
        returning * into cur;
      res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', 'applied', 'version', cur.version, 'data', cur.data, 'deleted', cur.deleted);
    elsif cur.deleted and (ch ->> 'op') = 'upsert' and base in ('contract_cases','poa_cases','user_case_access','user_client_access') then
      -- جداول الربط: إعادة الربط بعد فكه مسموحة
      update records set data = newdata, deleted = false, version = version + 1 where office_id = p_office and tbl = cur.tbl and rid = cur.rid returning * into cur;
      res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', 'applied', 'version', cur.version, 'data', cur.data, 'deleted', false);
    elsif cur.deleted then
      res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', 'deleted', 'version', cur.version, 'data', cur.data, 'deleted', true);
    elsif (ch ->> 'op') = 'delete' then
      update records set deleted = true, version = version + 1 where office_id = p_office and tbl = cur.tbl and rid = cur.rid returning * into cur;
      res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', 'applied', 'version', cur.version, 'data', cur.data, 'deleted', true);
    else
      merged := cur.data;
      for k in select jsonb_object_keys(newdata) loop
        -- الحقل غيّره الجهاز (مقارنة بأساسه)
        if basedata is null or (newdata -> k) is distinct from (basedata -> k) then
          if base in ('payments','service_txns','contract_adjustments') and k = any(fin_locked) and (cur.data -> k) is distinct from (newdata -> k) then
            raise exception 'financial record % is immutable (field %): correct it with a reversal or adjustment', cur.rid, k using errcode = '23514';
          end if;
          if basedata is not null and (cur.data -> k) is distinct from (basedata -> k) and (cur.data -> k) is distinct from (newdata -> k) then
            -- الخادم غيّر الحقل نفسه أيضًا
            if k = 'voided' and (cur.data ->> k) = '1' then continue; end if;
            if k in ('updated_at','updated_by') then continue; end if;
            conflict_keys := conflict_keys || k;
            continue;
          end if;
          if k = 'voided' and (cur.data ->> k) = '1' then continue; end if;
          merged := jsonb_set(merged, array[k], newdata -> k, true);
        end if;
      end loop;
      if merged is distinct from cur.data then
        update records set data = merged, version = version + 1 where office_id = p_office and tbl = cur.tbl and rid = cur.rid returning * into cur;
      end if;
      if array_length(conflict_keys, 1) > 0 then
        insert into sync_conflicts (office_id, tbl, rid, fields, base_data, server_data, client_data)
          values (p_office, cur.tbl, cur.rid, conflict_keys, basedata, cur.data, newdata);
        res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', 'conflict', 'fields', to_jsonb(conflict_keys), 'version', cur.version, 'data', cur.data, 'deleted', false);
      else
        res := jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', cur.tbl, 'rid', cur.rid, 'status', case when basedata is null or (ch ->> 'base_version')::bigint = cur.version - 1 then 'applied' else 'merged' end,
          'version', cur.version, 'data', cur.data, 'deleted', false);
      end if;
    end if;
    exception when insufficient_privilege or unique_violation or check_violation or raise_exception then
      -- رفض هذا التغيير وحده دون إسقاط بقية الدفعة؛ لا تُخزن نتيجة الرفض حتى يمكن إعادة المحاولة بعد منح الصلاحية
      out := out || jsonb_build_array(jsonb_build_object('op_id', ch ->> 'op_id', 'tbl', ch ->> 'tbl', 'rid', ch ->> 'rid', 'status', 'rejected', 'message', sqlerrm));
      continue;
    end;
    insert into sync_ops (op_id, office_id, result) values ((ch ->> 'op_id')::uuid, p_office, res);
    out := out || jsonb_build_array(res);
  end loop;
  return out;
end $$;

-- ———————————————— السحب (Pull) ————————————————

create or replace function public.sync_pull(p_office uuid, p_since bigint, p_limit int default 500)
returns table (tbl text, rid text, data jsonb, version bigint, seq bigint, deleted boolean)
language sql stable security invoker set search_path = public as $$
  select r.tbl, r.rid, r.data, r.version, r.seq, r.deleted from records r
  where r.office_id = p_office and r.seq > p_since order by r.seq limit least(greatest(p_limit, 1), 2000)
$$;

/** حالة العضو: نسخة نطاق الوصول (تغيرها يعني إعادة مزامنة كاملة) وصلاحياته. */
create or replace function public.sync_status(p_office uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('member', to_jsonb(m) - 'user_id', 'max_seq', (select coalesce(max(seq), 0) from records where office_id = p_office), 'server_time', now())
  from app_member(p_office) m where m.user_id is not null
$$;

-- ———————————————— الأرقام المرجعية ————————————————

create or replace function public.app_reserve_numbers(p_office uuid, p_name text, p_count int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if (app_member(p_office)).user_id is null then raise exception 'not a member' using errcode = '42501'; end if;
  if p_count < 1 or p_count > 200 then raise exception 'bad count'; end if;
  insert into office_counters (office_id, name, value) values (p_office, p_name, 0) on conflict do nothing;
  update office_counters set value = value + p_count where office_id = p_office and name = p_name returning value into v;
  return jsonb_build_object('from', v - p_count + 1, 'to', v);
end $$;

/** يرفع العداد إلى قيمة لا تقل عن الحالية (عند نقل بيانات مكتب قائم). للمالك فقط. */
create or replace function public.app_bump_counter(p_office uuid, p_name text, p_min bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_owner(p_office) then raise exception 'owner only' using errcode = '42501'; end if;
  insert into office_counters (office_id, name, value) values (p_office, p_name, p_min) on conflict (office_id, name) do update set value = greatest(office_counters.value, excluded.value);
end $$;

-- ———————————————— المكتب والأعضاء ————————————————

create or replace function public.app_create_office(p_name text, p_local_owner uuid, p_display_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare oid uuid;
begin
  if auth.uid() is null then raise exception 'auth required' using errcode = '42501'; end if;
  insert into offices (name, created_by) values (p_name, auth.uid()) returning id into oid;
  insert into office_members (office_id, user_id, local_user_id, role, display_name) values (oid, auth.uid(), p_local_owner, 'owner', p_display_name);
  return oid;
end $$;

/** ربط حساب مصادقة قائم بمستخدم في المكتب (المالك فقط). إنشاء الحساب/الدعوة يتم عبر دالة الخادم بمفتاح الخدمة. */
create or replace function public.app_link_member(p_office uuid, p_user uuid, p_local_user uuid, p_display_name text, p_permissions text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_owner(p_office) then raise exception 'owner only' using errcode = '42501'; end if;
  insert into office_members (office_id, user_id, local_user_id, role, permissions, display_name)
    values (p_office, p_user, p_local_user, 'consultant', p_permissions, p_display_name)
    on conflict (office_id, user_id) do update set local_user_id = excluded.local_user_id, permissions = excluded.permissions, display_name = excluded.display_name, active = true;
end $$;

create or replace function public.app_my_offices() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('office_id', o.id, 'name', o.name, 'role', m.role, 'local_user_id', m.local_user_id, 'require_mfa', o.require_mfa)), '[]'::jsonb)
  from office_members m join offices o on o.id = m.office_id where m.user_id = auth.uid() and m.active
$$;

-- ———————————————— الأجهزة والجلسات ————————————————

create or replace function public.app_touch_device(p_office uuid, p_device uuid, p_name text, p_platform text, p_version text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d devices;
begin
  if not exists (select 1 from office_members where office_id = p_office and user_id = auth.uid() and active) then
    return jsonb_build_object('allowed', false, 'reason', 'not_member');
  end if;
  select * into d from devices where id = p_device;
  if found and (d.revoked_at is not null or d.user_id <> auth.uid()) then
    return jsonb_build_object('allowed', false, 'reason', 'revoked');
  end if;
  insert into devices (id, office_id, user_id, session_id, device_name, platform, app_version)
    values (p_device, p_office, auth.uid(), app_session_id(), left(p_name, 120), left(p_platform, 40), left(p_version, 40))
    on conflict (id) do update set session_id = excluded.session_id, device_name = excluded.device_name, platform = excluded.platform, app_version = excluded.app_version, last_seen = now();
  return jsonb_build_object('allowed', app_session_ok(p_office));
end $$;

/** إلغاء جهاز: يمنع الوصول الجديد فورًا (حذف جلسته من المصادقة + علامة إلغاء تفحصها RLS). المالك لأي جهاز، والمستخدم لأجهزته. */
create or replace function public.app_revoke_device(p_device uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
declare d devices;
begin
  select * into d from devices where id = p_device;
  if not found then raise exception 'device not found'; end if;
  if not (d.user_id = auth.uid() or app_is_owner(d.office_id)) then raise exception 'not allowed' using errcode = '42501'; end if;
  -- علامة الإلغاء تُفحص في كل سياسة RLS فيُمنع الوصول الجديد فورًا. إنهاء جلسة المصادقة نفسها (رمز التحديث) تتولاه دالة الخادم devices بمفتاح الخدمة.
  update devices set revoked_at = now(), revoked_by = auth.uid() where id = p_device;
end $$;

create or replace function public.app_set_require_mfa(p_office uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_owner(p_office) then raise exception 'owner only' using errcode = '42501'; end if;
  if p_on and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then raise exception 'enable your own two-step verification first' using errcode = '42501'; end if;
  update offices set require_mfa = p_on where id = p_office;
end $$;

-- ———————————————— التعارضات ————————————————

create or replace function public.app_resolve_conflict(p_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update sync_conflicts set resolved_at = now(), resolved_by = auth.uid() where id = p_id and resolved_at is null;
end $$;

-- ———————————————— الصلاحيات على الدوال ————————————————
revoke all on function public.app_records_before(), public.app_records_after() from public, anon, authenticated;
revoke all on function public.app_bump_counter(uuid, text, bigint), public.app_create_office(text, uuid, text) from anon;
grant usage on schema public to authenticated;
grant select on public.offices, public.office_members, public.records, public.sync_conflicts, public.devices, public.blobs to authenticated;
grant insert, update on public.records to authenticated;
grant update on public.sync_conflicts to authenticated;
grant insert on public.sync_ops to authenticated;
grant select on public.sync_ops to authenticated;
grant usage on sequence public.records_seq to authenticated;
grant insert on public.sync_conflicts to authenticated;
