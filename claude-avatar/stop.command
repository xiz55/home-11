#!/bin/bash
# Stops the Claude Avatar bridge (and the whisper-server it started).
cd "$(dirname "$0")"
if [[ -f .server.pid ]] && kill "$(cat .server.pid)" 2>/dev/null; then echo "تم إيقاف Claude Avatar."
else pkill -f "claude-avatar/server.py" && echo "تم إيقاف Claude Avatar." || echo "المساعد غير مشغّل."; fi
rm -f .server.pid
