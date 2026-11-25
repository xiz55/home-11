#!/bin/bash
# ينشئ ملف DMG من التطبيق المغلف بأداة macOS الأصلية hdiutil: التطبيق + اختصار «التطبيقات» للسحب والإفلات.
set -euo pipefail
APP="$1"      # مسار LawOfficeManager.app
OUT="$2"      # مسار ملف DMG الناتج
VOL="إدارة مكتب المحاماة"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/LawOfficeManager.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT"
hdiutil verify "$OUT"
echo "DMG: $OUT"
