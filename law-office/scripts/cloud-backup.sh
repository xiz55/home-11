#!/usr/bin/env bash
# نسخة احتياطية لقاعدة المكتب السحابية (Supabase) إلى مجلد خارجي — يشغّلها صاحب المكتب على جهازه أو بجدولة يعتمدها.
# الاستخدام:
#   SUPABASE_DB_URL='postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres' scripts/cloud-backup.sh /path/to/backups
# - لا تضع كلمة مرور القاعدة في التطبيق ولا في المستودع؛ تُمرر هنا فقط كمتغير بيئة على جهاز صاحب المكتب.
# - الناتج: ملفان لكل نسخة (بيانات المكتب، وحسابات الدخول) مع بصمة SHA-256 للتحقق.
# - ملفات المرفقات في Backblaze B2 تُنسخ بخطوة منفصلة إلى موقع آخر (انظر docs/BACKUP_PLAN.md).
set -euo pipefail
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
OUT="${1:?output directory required}"
mkdir -p "$OUT"
TS=$(date -u +%Y%m%dT%H%M%SZ)
APP="$OUT/lawoffice-public-$TS.dump"
AUTH="$OUT/lawoffice-auth-$TS.dump"

# بيانات المكتب كاملة: الجداول والدوال وسياسات RLS
pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges --schema=public --file="$APP"
# حسابات الدخول وعوامل التحقق بخطوتين (بيانات فقط؛ بنية auth تنشئها Supabase نفسها)
pg_dump "$SUPABASE_DB_URL" --format=custom --data-only --no-owner \
  --table=auth.users --table=auth.identities --table=auth.mfa_factors --file="$AUTH"

( cd "$OUT" && sha256sum "$(basename "$APP")" "$(basename "$AUTH")" > "lawoffice-$TS.sha256" )
echo "backup written: $APP $AUTH"
