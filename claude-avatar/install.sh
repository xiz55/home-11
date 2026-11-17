#!/bin/bash
# Claude Avatar — installer for macOS. Asks before installing anything.
set -uo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ok()   { printf "  ✅ %s\n" "$*"; }
warn() { printf "  ⚠️  %s\n" "$*"; }
bad()  { printf "  ❌ %s\n" "$*"; }
ask()  { read -r -p "  ❓ $1 [y/N] " a; [[ "$a" =~ ^([Yy]|[Yy]es|نعم|ن)$ ]]; }

[[ "$(uname)" == "Darwin" ]] || { echo "هذا المثبّت لنظام macOS فقط."; exit 1; }

echo "== 1) فحص الجهاز =="
echo "  macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
echo "  المعالج: $(sysctl -n machdep.cpu.brand_string 2>/dev/null) — $(uname -m)"
echo "  الذاكرة: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo "  المساحة الحرة: $(df -h "$HOME" | awk 'NR==2{print $4}')"
MAJOR=$(sw_vers -productVersion | cut -d. -f1)
(( MAJOR >= 13 )) && ok "إصدار macOS مناسب" || warn "يفضّل macOS 13 أو أحدث (قد لا تتوفر حزم whisper-cpp الجاهزة)"
[[ "$(uname -m)" == "arm64" ]] && ok "Apple Silicon: تحويل الكلام سيعمل بسرعة عبر Metal" || warn "معالج Intel: تحويل الكلام سيكون أبطأ"

echo "== 2) الأدوات الأساسية =="
if python3 -c 'import sys; assert sys.version_info >= (3, 8)' 2>/dev/null; then ok "Python $(python3 -V | cut -d' ' -f2)"
else bad "Python 3 غير متوفر. شغّل: xcode-select --install ثم أعد تشغيل المثبّت"; exit 1; fi

if command -v brew >/dev/null; then ok "Homebrew $(brew --version | head -1 | cut -d' ' -f2)"
else
  bad "Homebrew غير مثبت. ثبّته (يطلب كلمة مرور الجهاز) بالأمر التالي ثم أعد تشغيل المثبّت:"
  echo '     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

if command -v claude >/dev/null; then ok "Claude Code $(claude --version 2>/dev/null)"
else
  bad "Claude Code غير مثبت."
  if ask "تثبيت Claude Code بالمثبّت الرسمي (claude.ai/install.sh)؟"; then
    curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v claude >/dev/null || { echo "  ثبّت Claude Code ثم أعد التشغيل."; exit 1; }
fi

echo "  … اختبار تسجيل الدخول في Claude Code (طلب قصير جدًا)"
if out=$(echo "رد بكلمة واحدة فقط: جاهز" | claude -p --model haiku 2>&1) && [[ -n "$out" ]]; then ok "Claude Code يعمل ومسجّل الدخول: $out"
else bad "Claude Code لا يستجيب: $out"; echo "     شغّل الأمر claude في الطرفية وسجّل الدخول بحسابك ثم أعد المثبّت."; exit 1; fi

echo "== 3) تحويل الكلام إلى نص (whisper.cpp — محلي ومجاني ومفتوح المصدر) =="
if command -v whisper-server >/dev/null; then ok "whisper-cpp مثبت"
elif ask "تثبيت whisper-cpp عبر Homebrew (حوالي 5 MB)؟"; then brew install whisper-cpp || { bad "فشل التثبيت"; exit 1; }
else warn "تم التخطي — ستعمل الكتابة فقط بدون ميكروفون"; fi

MODEL=models/ggml-large-v3-turbo-q5_0.bin
mkdir -p models
if [[ -s "$MODEL" ]] && (( $(stat -f%z "$MODEL") > 500000000 )); then ok "نموذج Whisper موجود"
elif ask "تنزيل نموذج Whisper large-v3-turbo (حوالي 550 MB، أفضل دقة للعربية)؟"; then
  curl -L --fail -C - -o "$MODEL" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" && ok "تم تنزيل النموذج"
fi

echo "== 4) الشخصية ثلاثية الأبعاد =="
mkdir -p web/models
if [[ -s web/models/default.vrm ]]; then ok "شخصية VRM موجودة"
else
  curl -L --fail -o web/models/default.vrm "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" \
    && ok "تم تنزيل الشخصية التجريبية (يمكنك استبدالها بأي ملف .vrm)"
fi

echo "== 5) الصوت العربي =="
[[ -f config.json ]] || cp config.example.json config.json
VOICES=$(say -v '?' | grep -E ' ar[_-]' || true)
if [[ -n "$VOICES" ]]; then ok "أصوات عربية مثبتة:"; echo "$VOICES" | sed 's/^/       /'
  echo "$VOICES" | grep -qE 'Premium|Enhanced' || warn "لصوت أوضح: نزّل صوت (Majed — محسّن) من إعدادات النظام ← تسهيلات الاستخدام ← المحتوى المنطوق ← صوت النظام ← إدارة الأصوات ← العربية"
else
  bad "لا يوجد صوت عربي. سأفتح الإعدادات: المحتوى المنطوق ← صوت النظام ← إدارة الأصوات ← العربية ← Majed"
  open "x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent" 2>/dev/null || true
fi

chmod +x "Claude Avatar.command" stop.command 2>/dev/null
if ask "إضافة اختصار التشغيل (Claude Avatar) على سطح المكتب؟"; then
  ln -sf "$PWD/Claude Avatar.command" "$HOME/Desktop/Claude Avatar.command" && ok "تمت الإضافة على سطح المكتب"
fi

echo "== 6) الفحص النهائي =="
python3 server.py --check && echo && echo "🎉 جاهز. شغّل: ./\"Claude Avatar.command\"  (أو انقر عليه مرتين)"
