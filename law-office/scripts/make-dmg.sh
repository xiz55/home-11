#!/bin/bash
# ينشئ ملف DMG من التطبيق المغلف بأداة macOS الأصلية hdiutil: التطبيق + اختصار «التطبيقات» للسحب والإفلات.
set -euo pipefail
APP="$1"      # مسار LawOfficeManager.app
OUT="$2"      # مسار ملف DMG الناتج
VOL="مكتب المحامي محمد إبراهيم الشهراني للمحاماة"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# اسم التطبيق الظاهر في Finder والـDock هو اسم مجلد التطبيق نفسه (بأي لغة للنظام)؛ الاسم الداخلي ومجلد البيانات لا يتغيران
ditto "$APP" "$STAGE/$VOL.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
# قد يفشل hdiutil مؤقتًا بـ «Resource busy» عند انشغال القرص (فهرسة/فحص)؛ نعيد المحاولة
for attempt in 1 2 3 4 5 6; do
  if hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT"; then break; fi
  if [ "$attempt" = 6 ]; then echo "hdiutil create failed after $attempt attempts" >&2; exit 1; fi
  echo "hdiutil busy — retry $attempt" >&2
  sleep $((attempt * 10))
done
hdiutil verify "$OUT"
echo "DMG: $OUT"
