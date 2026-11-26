#!/usr/bin/env bash
# يشغّل مكدس Supabase محليًا لاختبارات السحابة فقط (بيانات خيالية، مفاتيح اختبار لا تُستخدم في أي مشروع حقيقي):
#  - sbpg   : PostgreSQL من صورة Supabase على 54322 (اختبارات RLS والمزامنة والمرفقات)
#  - sbfull : PostgreSQL على 54333 + GoTrue على 9999 + PostgREST على 54401 (اختبار الدخول والتحقق بخطوتين والأجهزة)
set -euo pipefail
cd "$(dirname "$0")/.."
IMG=supabase/postgres:15.8.1.085
SECRET=super-secret-jwt-token-with-at-least-32-characters-long
export PGPASSWORD=postgres

wait_pg() {
  for _ in $(seq 1 90); do
    if psql -h 127.0.0.1 -p "$1" -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "postgres on $1 did not start" >&2
  return 1
}

docker rm -f sbpg sbfull sbauth sbrest >/dev/null 2>&1 || true
docker run -d --name sbpg -p 54322:5432 -e POSTGRES_PASSWORD=postgres "$IMG" postgres -D /etc/postgresql >/dev/null
docker run -d --name sbfull --network host -e POSTGRES_PASSWORD=postgres "$IMG" postgres -D /etc/postgresql -c port=54333 >/dev/null
wait_pg 54322
wait_pg 54333
sleep 5

docker run -d --name sbauth --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9999 -e API_EXTERNAL_URL=http://127.0.0.1:9999 \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@127.0.0.1:54333/postgres" \
  -e GOTRUE_SITE_URL=http://127.0.0.1 -e GOTRUE_JWT_SECRET=$SECRET -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  -e GOTRUE_MFA_TOTP_ENROLL_ENABLED=true -e GOTRUE_MFA_TOTP_VERIFY_ENABLED=true -e GOTRUE_MFA_MAX_ENROLLED_FACTORS=10 \
  supabase/gotrue:v2.164.0 >/dev/null
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:9999/health >/dev/null && break; sleep 2; done

# ترحيلات المشروع نفسها التي تُطبق على مشروع Supabase الحقيقي
for f in supabase/migrations/*.sql; do
  psql -h 127.0.0.1 -p 54333 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f "$f"
done

docker run -d --name sbrest --network host -e "PGRST_DB_URI=postgres://authenticator:postgres@127.0.0.1:54333/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=$SECRET -e PGRST_SERVER_PORT=54401 \
  postgrest/postgrest:v12.2.3 >/dev/null
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:54401/ >/dev/null && break; sleep 2; done
echo "cloud test stack ready"
