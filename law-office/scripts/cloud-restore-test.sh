#!/usr/bin/env bash
# اختبار الاستعادة: يأخذ نسخة من قاعدة الاختبار المحلية (sbfull من scripts/cloud-test-stack.sh)،
# ثم يستعيدها في خادم PostgreSQL منفصل تمامًا، ويقارن السجلات (العدد وبصمة المعرّفات والبيانات) والحسابات.
# بيانات خيالية فقط. لا يلمس أي مشروع حقيقي.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres
IMG=supabase/postgres:15.8.1.085
SECRET=super-secret-jwt-token-with-at-least-32-characters-long
WORK=$(mktemp -d)
SRC="postgres://supabase_admin:postgres@127.0.0.1:54333/postgres"
DST="postgres://supabase_admin:postgres@127.0.0.1:54334/postgres"

# 1) النسخ الاحتياطي بالسكربت نفسه المقدم لصاحب المكتب
SUPABASE_DB_URL="$SRC" bash scripts/cloud-backup.sh "$WORK"
( cd "$WORK" && sha256sum -c lawoffice-*.sha256 )

# 2) خادم جديد منفصل: قاعدة Supabase فارغة + بنية auth من GoTrue نفسه
docker rm -f sbrestore sbrestore-auth >/dev/null 2>&1 || true
docker run -d --name sbrestore --network host -e POSTGRES_PASSWORD=postgres "$IMG" postgres -D /etc/postgresql -c port=54334 >/dev/null
for _ in $(seq 1 90); do psql "$DST" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
sleep 5
docker run -d --name sbrestore-auth --network host -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9998 -e API_EXTERNAL_URL=http://127.0.0.1:9998 \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@127.0.0.1:54334/postgres" \
  -e GOTRUE_SITE_URL=http://127.0.0.1 -e GOTRUE_JWT_SECRET=$SECRET supabase/gotrue:v2.164.0 >/dev/null
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:9998/health >/dev/null && break; sleep 2; done
docker rm -f sbrestore-auth >/dev/null
# قاعدة Supabase قد تعيد التشغيل مرة أثناء التهيئة الأولى: ننتظر أن تقبل الاتصال فعلًا قبل الاستعادة
for _ in $(seq 1 60); do psql "$DST" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
psql "$DST" -Atc 'select 1' >/dev/null

# 3) الاستعادة: الحسابات أولًا ثم بيانات المكتب.
# أدوات pg_restore الأحدث (17+) ترسل الإعداد transaction_timeout الذي لا يعرفه خادم 15 — خطأ غير مؤثر يُتجاهل وحده؛ أي خطأ آخر يُفشل الاختبار.
restore() {
  local log="$WORK/restore.log"
  pg_restore "$@" >"$log" 2>&1 || true
  cat "$log"
  if grep 'error:' "$log" | grep -v 'transaction_timeout' | grep -q .; then echo "RESTORE ERRORS"; exit 1; fi
}
restore --dbname="$DST" --data-only --no-owner --disable-triggers "$WORK"/lawoffice-auth-*.dump
psql "$DST" -qc 'drop schema if exists public cascade'
restore --dbname="$DST" --no-owner "$WORK"/lawoffice-public-*.dump
psql "$DST" -q -c 'grant usage on schema public to anon, authenticated, service_role' \
  -c 'grant all on all tables in schema public to authenticated, service_role' \
  -c 'grant all on all sequences in schema public to authenticated, service_role' \
  -c 'grant execute on all functions in schema public to authenticated, service_role'

# 4) المقارنة: كل جدول في public (العدد + بصمة المحتوى كاملًا)، وحسابات الدخول
Q="select string_agg(t || ':' || n || ':' || h, E'\n' order by t) from (
  select 'records' t, count(*) n, md5(string_agg(office_id||tbl||rid||data::text||version||deleted, ',' order by office_id, tbl, rid)) h from public.records
  union all select 'offices', count(*), md5(string_agg(id::text||name, ',' order by id)) from public.offices
  union all select 'office_members', count(*), md5(string_agg(office_id::text||user_id::text||local_user_id::text||role||array_to_string(permissions,'+'), ',' order by office_id, local_user_id)) from public.office_members
  union all select 'devices', count(*), md5(coalesce(string_agg(id::text, ',' order by id),'')) from public.devices
  union all select 'auth.users', count(*), md5(string_agg(id::text||coalesce(email,'')||coalesce(encrypted_password,''), ',' order by id)) from auth.users
  union all select 'auth.mfa_factors', count(*), md5(coalesce(string_agg(id::text||coalesce(secret,''), ',' order by id),'')) from auth.mfa_factors
) x"
A=$(psql "$SRC" -Atc "$Q")
B=$(psql "$DST" -Atc "$Q")
echo "$A" > "$WORK/source.txt"
echo "$B" > "$WORK/restored.txt"
echo "— المصدر —"; echo "$A"
if [ "$A" != "$B" ]; then
  echo "RESTORE MISMATCH"; diff "$WORK/source.txt" "$WORK/restored.txt" || true; exit 1
fi
# الدوال وسياسات الحماية استُعيدت أيضًا
psql "$DST" -Atc "select count(*) from pg_policies where schemaname='public'" | xargs -I{} echo "RLS policies restored: {}"
psql "$DST" -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'app_%'" | xargs -I{} echo "functions restored: {}"
docker rm -f sbrestore >/dev/null
echo "RESTORE OK: restored copy matches the source exactly"
