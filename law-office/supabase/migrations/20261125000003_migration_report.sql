-- تقرير التحقق بعد نقل بيانات المكتب: لكل جدول عدد السجلات وبصمة لقائمة المعرّفات (لا تُكشف البيانات نفسها)،
-- ومجموع الدفعات غير الملغاة. يقارنه البرنامج بما على الجهاز الأصلي. لصاحب المكتب فقط.
create or replace function public.app_migration_report(p_office uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  r jsonb;
begin
  if not public.app_is_owner(p_office) then
    raise exception 'owner only' using errcode = 'insufficient_privilege';
  end if;
  select jsonb_build_object(
    'tables', coalesce((
      select jsonb_object_agg(tbl, jsonb_build_object('n', n, 'hash', h))
      from (
        select tbl, count(*)::int as n,
               encode(sha256(convert_to(string_agg(rid, ',' order by rid collate "C"), 'UTF8')), 'hex') as h
        from public.records
        where office_id = p_office and not deleted and tbl not like '%$%'
        group by tbl
      ) x), '{}'::jsonb),
    'payments_total', coalesce((
      select sum((data->>'amount')::bigint)
      from public.records
      where office_id = p_office and tbl = 'payments' and not deleted and coalesce((data->>'voided')::int, 0) = 0), 0)
  ) into r;
  return r;
end;
$$;

revoke all on function public.app_migration_report(uuid) from public, anon;
grant execute on function public.app_migration_report(uuid) to authenticated;
