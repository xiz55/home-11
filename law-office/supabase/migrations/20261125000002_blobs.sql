-- المرفقات: الخادم يتحقق من صلاحية المستخدم على نسخة المستند نفسها، ومن تطابق البصمة والحجم والنوع مع بيانات السجل،
-- قبل إصدار رابط رفع/تنزيل مؤقت. الحالة verified لا تُمنح إلا من دالة الخادم بمفتاح الخدمة بعد فحص الملف المرفوع.

create or replace function public.app_blob_request(p_office uuid, p_version uuid, p_sha text, p_size bigint, p_ext text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r records;
  b blobs;
begin
  select * into r from records where office_id = p_office and tbl = 'document_versions' and rid = p_version::text and not deleted;
  if not found then raise exception 'document version not synced yet' using errcode = 'P0002'; end if;
  if not app_can_write(r) then raise exception 'not allowed' using errcode = '42501'; end if;
  if lower(p_ext) not in ('pdf','docx','doc','jpg','jpeg','png','webp','gif','bmp','tif','tiff','heic') then raise exception 'file type not allowed' using errcode = '22023'; end if;
  if p_size <= 0 or p_size > 157286400 then raise exception 'file size not allowed' using errcode = '22023'; end if;
  if (r.data ->> 'sha256') is distinct from p_sha or (r.data ->> 'size')::bigint is distinct from p_size or lower(r.data ->> 'ext') is distinct from lower(p_ext) then
    raise exception 'file does not match its document record' using errcode = '22023';
  end if;
  select * into b from blobs where office_id = p_office and version_id = p_version;
  if found and b.status = 'verified' then return jsonb_build_object('status', 'verified', 'object_key', b.object_key); end if;
  insert into blobs (office_id, version_id, object_key, sha256, size, ext, status)
    values (p_office, p_version, p_office::text || '/' || p_version::text, p_sha, p_size, lower(p_ext), 'pending')
    on conflict (office_id, version_id) do update set sha256 = excluded.sha256, size = excluded.size, ext = excluded.ext
    returning * into b;
  return jsonb_build_object('status', 'pending', 'object_key', b.object_key, 'sha256', b.sha256, 'size', b.size);
end $$;

create or replace function public.app_blob_access(p_office uuid, p_version uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r records;
  b blobs;
begin
  select * into r from records where office_id = p_office and tbl = 'document_versions' and rid = p_version::text and not deleted;
  if not found or not app_can_read(r) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from blobs where office_id = p_office and version_id = p_version;
  if not found or b.status <> 'verified' then return jsonb_build_object('status', coalesce(b.status, 'missing')); end if;
  return jsonb_build_object('status', 'verified', 'object_key', b.object_key, 'sha256', b.sha256, 'size', b.size);
end $$;

create or replace function public.app_blob_pending(p_office uuid, p_version uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('object_key', object_key, 'sha256', sha256, 'size', size) from blobs where office_id = p_office and version_id = p_version and status = 'pending'
$$;

/** لا يستدعيها إلا مفتاح الخدمة (دالة الخادم) بعد فحص الملف في B2. */
create or replace function public.app_blob_verified(p_office uuid, p_version uuid, p_size bigint, p_sha text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update blobs set status = 'verified', verified_at = now()
    where office_id = p_office and version_id = p_version and size = p_size and sha256 = p_sha;
  return found;
end $$;

/** حالة رفع المرفقات لجهاز (للعرض: لا «تمت المزامنة» قبل التحقق). */
create or replace function public.app_blob_states(p_office uuid, p_versions uuid[]) returns table (version_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select b.version_id, b.status from blobs b
  where b.office_id = p_office and b.version_id = any(p_versions)
    and exists (select 1 from records r where r.office_id = b.office_id and r.tbl = 'document_versions' and r.rid = b.version_id::text and app_can_read(r))
$$;

revoke all on function public.app_blob_verified(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.app_blob_pending(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_blob_verified(uuid, uuid, bigint, text), public.app_blob_pending(uuid, uuid) to service_role;
