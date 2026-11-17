#!/bin/bash
# Double-click to start Claude Avatar: launches the local bridge and opens the avatar window.
cd "$(dirname "$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$0")")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PORT=$(python3 -c "import json;print(json.load(open('config.json')).get('port',8765))" 2>/dev/null || echo 8765)
URL="http://127.0.0.1:$PORT/"

if ! curl -fs "${URL}api/status" >/dev/null; then
  echo "تشغيل Claude Avatar…"
  nohup python3 server.py > server.log 2>&1 &
  echo $! > .server.pid
  for _ in $(seq 1 40); do curl -fs "${URL}api/status" >/dev/null && break; sleep 0.25; done
fi
curl -fs "${URL}api/status" >/dev/null || { echo "تعذّر التشغيل. السجل:"; tail -20 server.log; exit 1; }

# A standalone app-style window (resizable, ⌃⌘F for full screen). Chrome/Edge/Brave preferred, Safari works too.
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [[ -d "/Applications/$app.app" || -d "$HOME/Applications/$app.app" ]]; then
    open -na "$app" --args --app="$URL" --window-size=900,1000
    echo "فُتحت نافذة الشخصية في $app. لإيقاف المساعد: stop.command"
    exit 0
  fi
done
open -a Safari "$URL"
echo "فُتحت نافذة الشخصية في Safari. لإيقاف المساعد: stop.command"
