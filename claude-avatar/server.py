#!/usr/bin/env python3
"""Claude Avatar — local bridge between the microphone, Claude Code, Arabic TTS and a 3D VRM avatar.

Runs only on 127.0.0.1. No third-party Python packages are required.

  Browser (avatar + mic)  --wav-->  /api/stt   --> whisper-server (whisper.cpp, local, offline)
                          --text->  /api/chat  --> `claude -p --resume <session>` (your Claude Code login)
                          <-ndjson-  streamed reply text / tool activity
                          --text->  /api/tts   --> macOS `say` (Arabic voice) or optional edge-tts
"""
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

DEFAULTS = {
    "port": 8765,
    "workdir": "~",
    "claude_bin": "claude",
    "model": "",
    # acceptEdits: file edits run without asking; shell commands only if listed in allowed_tools.
    # "auto": Claude Code's auto mode (a safety classifier approves/blocks each action), if your plan has it.
    # "bypassPermissions": everything runs without checks — not recommended for voice control.
    "permission_mode": "acceptEdits",
    "allowed_tools": [
        "Read", "Glob", "Grep", "Edit", "Write", "WebSearch", "WebFetch", "TodoWrite",
        "Bash(ls:*)", "Bash(pwd)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
        "Bash(find:*)", "Bash(du:*)", "Bash(df:*)", "Bash(mkdir:*)", "Bash(touch:*)", "Bash(cp:*)",
        "Bash(open:*)", "Bash(date)", "Bash(cal:*)", "Bash(sw_vers:*)", "Bash(system_profiler:*)",
        "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(python3:*)", "Bash(node:*)",
        "Bash(npm run:*)", "Bash(npm test:*)", "Bash(pmset -g:*)", "Bash(osascript -e:*)"
    ],
    "language_style": "saudi",
    "stt": {
        "server_bin": "whisper-server",
        "model": "models/ggml-large-v3-turbo-q5_0.bin",
        "port": 8178,
        "language": "ar",
        "threads": 0
    },
    "tts": {
        "engine": "say",          # "say" (macOS, offline) or "edge" (needs `pipx install edge-tts`, online)
        "voice": "auto",          # auto = best installed Arabic voice (Premium > Enhanced > default)
        "rate": 185,
        "edge_voice": "ar-SA-HamedNeural"
    }
}

SYSTEM_PROMPT = {
    "saudi": (
        "أنت تتحدث مع المستخدم صوتيًا عبر شخصية ثلاثية الأبعاد على جهاز ماك، وكل ما تكتبه سيُقرأ بصوت عالٍ. "
        "قواعد الرد: تكلّم بالعربية باللهجة السعودية البيضاء بأسلوب ودود ومختصر (من جملة إلى أربع جمل غالبًا). "
        "لا تستخدم Markdown ولا قوائم ولا جداول ولا رموز ولا إيموجي ولا كتل كود في ردك المنطوق. "
        "لا تقرأ الكود أو المسارات الطويلة أو الأوامر حرفيًا؛ لخّص ما فعلته بكلام بسيط. "
        "عند تنفيذ مهمة قل جملة قصيرة قبل البدء ثم لخّص النتيجة في النهاية. "
        "رسائل المستخدم ناتجة عن تحويل الكلام إلى نص وقد تحتوي أخطاء إملائية أو كلمات مسموعة خطأ؛ افهم المقصود من السياق. "
        "إذا كان الطلب خطيرًا أو لا رجعة فيه (حذف ملفات، تعديل إعدادات النظام، إرسال شيء خارج الجهاز) أو غامضًا، "
        "اسأل المستخدم للتأكيد قبل التنفيذ. إذا مُنعت من أداة بسبب الصلاحيات فأخبره بذلك بوضوح."
    ),
    "msa": (
        "أنت تتحدث مع المستخدم صوتيًا عبر شخصية ثلاثية الأبعاد، وكل ما تكتبه سيُقرأ بصوت عالٍ. "
        "تحدث بالعربية الفصحى المبسطة باختصار، دون Markdown أو رموز أو كود. "
        "رسائل المستخدم ناتجة عن تحويل الكلام إلى نص وقد تحتوي أخطاء. "
        "اطلب التأكيد قبل أي إجراء خطير أو لا رجعة فيه، وأخبر المستخدم إذا مُنعت من أداة."
    ),
}

# Common Whisper hallucinations on silence / noise in Arabic.
HALLUCINATIONS = [
    "نانسي قنقر", "ترجمة نانسي", "اشتركوا في القناة", "اشترك في القناة", "شكرا للمشاهدة",
    "شكرًا للمشاهدة", "شكرا على المشاهدة", "المترجم", "سبحان الله وبحمده", "موسيقى",
    "[موسيقى]", "(موسيقى)", "[BLANK_AUDIO]", "♪",
]


def deep_merge(base, extra):
    out = dict(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config():
    path = os.path.join(ROOT, "config.json")
    user = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
    cfg = deep_merge(DEFAULTS, user)
    cfg["workdir"] = os.path.abspath(os.path.expanduser(cfg["workdir"]))
    m = cfg["stt"]["model"]
    cfg["stt"]["model"] = m if os.path.isabs(m) else os.path.join(ROOT, m)
    return cfg


CFG = load_config()
STATE_FILE = os.path.join(ROOT, ".session.json")


class State:
    lock = threading.Lock()
    busy = False
    interrupted = False
    session_id = None
    whisper = None
    voice = None

    @classmethod
    def load(cls):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                cls.session_id = json.load(f).get("session_id")
        except (OSError, ValueError):
            pass

    @classmethod
    def save(cls):
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"session_id": cls.session_id}, f)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- Speech to text (whisper.cpp)

def start_whisper():
    st = CFG["stt"]
    binp = shutil.which(st["server_bin"])
    if not binp:
        log("STT: whisper-server not found (brew install whisper-cpp). Mic input disabled; typing still works.")
        return
    if not os.path.exists(st["model"]):
        log("STT: model missing:", st["model"], "— run ./install.sh")
        return
    args = [binp, "-m", st["model"], "-l", st["language"], "--host", "127.0.0.1", "--port", str(st["port"])]
    if st.get("threads"):
        args += ["-t", str(st["threads"])]
    log("STT: starting", " ".join(args))
    State.whisper = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def whisper_ready():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{CFG['stt']['port']}/", timeout=1)
        return True
    except Exception as e:  # any HTTP response (even 404) means it is up
        return hasattr(e, "code")


def transcribe(wav_bytes):
    boundary = "----claudeavatar" + uuid.uuid4().hex
    parts = []

    def field(name, value):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())

    field("temperature", "0.0")
    field("response_format", "json")
    field("language", CFG["stt"]["language"])
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n".encode() + wav_bytes + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"http://127.0.0.1:{CFG['stt']['port']}/inference",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        text = json.loads(r.read().decode("utf-8")).get("text", "")
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text).strip()
    cleaned = text
    for h in HALLUCINATIONS:
        cleaned = cleaned.replace(h, "")
    if len(re.sub(r"[\W_]+", "", cleaned)) < 2:
        return ""
    return text


# ---------------------------------------------------------------- Text to speech

def pick_say_voice():
    want = CFG["tts"]["voice"]
    if want and want != "auto":
        return want
    if not shutil.which("say"):
        return None
    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\s{2,}(ar[_-][A-Za-z0-9]+)\s+#", line)
        if m:
            voices.append((m.group(1).strip(), m.group(2)))
    if not voices:
        return None

    def score(v):
        name, loc = v
        s = 0
        s += 30 if "Premium" in name else 20 if "Enhanced" in name else 0
        s += 5 if loc.endswith("SA") else 0
        s += 2 if name.startswith("Majed") else 0
        return -s

    voices.sort(key=score)
    return voices[0][0]


def clean_for_speech(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"https?://\S+", " رابط ", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"[*_#>|~\[\]{}<>]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def synthesize(text):
    text = clean_for_speech(text)
    if not text:
        return None, None
    tmp = tempfile.mkdtemp(prefix="cavatar-")
    try:
        tts = CFG["tts"]
        if tts["engine"] == "edge":
            out = os.path.join(tmp, "out.mp3")
            subprocess.run(["edge-tts", "--voice", tts["edge_voice"], "--text", text, "--write-media", out],
                           check=True, capture_output=True, timeout=60)
            mime = "audio/mpeg"
        else:
            txt = os.path.join(tmp, "in.txt")
            with open(txt, "w", encoding="utf-8") as f:
                f.write(text)
            out = os.path.join(tmp, "out.wav")
            args = ["say", "-r", str(tts["rate"]), "-f", txt, "-o", out,
                    "--file-format=WAVE", "--data-format=LEI16@22050"]
            if State.voice:
                args[1:1] = ["-v", State.voice]
            subprocess.run(args, check=True, capture_output=True, timeout=60)
            mime = "audio/wav"
        with open(out, "rb") as f:
            return f.read(), mime
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- Claude Code

def summarize_tool(name, inp):
    inp = inp or {}
    for key in ("command", "file_path", "pattern", "url", "query", "path", "description"):
        if key in inp and isinstance(inp[key], str):
            v = inp[key]
            return v if len(v) < 140 else v[:137] + "..."
    return ""


def claude_args():
    # One long-lived Claude Code process per conversation (official stream-json input mode):
    # no start-up cost per turn, instant interrupt, and the same session/context throughout.
    args = [CFG["claude_bin"], "-p", "--input-format", "stream-json", "--output-format", "stream-json",
            "--verbose", "--include-partial-messages", "--permission-mode", CFG["permission_mode"],
            "--append-system-prompt", SYSTEM_PROMPT.get(CFG["language_style"], SYSTEM_PROMPT["saudi"])]
    if CFG["allowed_tools"]:
        args += ["--allowedTools", ",".join(CFG["allowed_tools"])]
    if CFG.get("model"):
        args += ["--model", CFG["model"]]
    if State.session_id:
        args += ["--resume", State.session_id]
    return args


class ClaudeProcess:
    """Persistent `claude -p --input-format stream-json` child; events are read by a background thread."""

    def __init__(self):
        self.proc = None
        self.events = queue.Queue()
        self.stderr_tail = []

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def ensure(self):
        if self.alive():
            return
        log("CLAUDE: starting", "(resume " + State.session_id + ")" if State.session_id else "(new session)")
        self.events = queue.Queue()
        self.stderr_tail = []
        self.proc = subprocess.Popen(claude_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=CFG["workdir"], text=True, encoding="utf-8",
                                     bufsize=1, start_new_session=True)
        proc, events, tail = self.proc, self.events, self.stderr_tail

        def read_out():
            for line in proc.stdout:
                line = line.strip()
                if line:
                    try:
                        events.put(json.loads(line))
                    except ValueError:
                        pass
            events.put(None)  # process ended

        def read_err():
            for line in proc.stderr:
                tail.append(line)
                del tail[:-20]

        threading.Thread(target=read_out, daemon=True).start()
        threading.Thread(target=read_err, daemon=True).start()

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def interrupt(self):
        if not self.alive():
            return False
        try:
            self.send({"type": "control_request", "request_id": uuid.uuid4().hex,
                       "request": {"subtype": "interrupt"}})
            return True
        except (BrokenPipeError, OSError):
            self.kill()
            return True

    def kill(self):
        p = self.proc
        self.proc = None
        if p and p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                p.terminate()


CLAUDE = ClaudeProcess()


def run_claude(text, emit, _retry=True):
    """Run one turn of the persistent Claude Code session, calling emit(dict) for each UI event."""
    CLAUDE.ensure()
    while True:  # drop leftovers from a previous (interrupted) turn
        try:
            if CLAUDE.events.get_nowait() is None:
                CLAUDE.kill()
                CLAUDE.ensure()
                break
        except queue.Empty:
            break
    log("CLAUDE:", text[:80])
    State.busy = True
    try:
        CLAUDE.send({"type": "user", "message": {"role": "user", "content": text}})
    except (BrokenPipeError, OSError):
        CLAUDE.kill()
        if _retry:
            return run_claude(text, emit, False)
        raise

    streamed = set()
    while True:
        ev = CLAUDE.events.get()
        if ev is None:  # process died mid-turn
            time.sleep(0.2)
            err = "".join(CLAUDE.stderr_tail).strip()[-600:]
            CLAUDE.kill()
            if State.session_id and "session" in err.lower():
                State.session_id = None  # stale session id must not brick the assistant
            State.save()
            emit({"type": "error", "text": err or "Claude Code توقف بشكل غير متوقع"})
            return
        t = ev.get("type")
        if ev.get("session_id"):
            State.session_id = ev["session_id"]
        if ev.get("parent_tool_use_id"):
            continue  # sub-agent chatter: not spoken
        if t == "stream_event":
            e = ev.get("event", {})
            if e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                streamed.add(ev.get("api_message_id"))
                emit({"type": "delta", "text": e["delta"]["text"]})
            elif e.get("type") == "message_stop":
                emit({"type": "delta", "text": "\n"})
        elif t == "assistant":
            msg = ev.get("message", {})
            for block in msg.get("content", []):
                if block.get("type") == "text" and msg.get("id") not in streamed:
                    emit({"type": "delta", "text": block.get("text", "") + "\n"})
                elif block.get("type") == "tool_use":
                    emit({"type": "tool", "name": block.get("name"),
                          "detail": summarize_tool(block.get("name"), block.get("input"))})
        elif t == "result":
            State.save()
            if State.interrupted:
                emit({"type": "stopped"})
                return
            denials = [f"{d.get('tool_name')}: {summarize_tool(d.get('tool_name'), d.get('tool_input'))}"
                       for d in (ev.get("permission_denials") or [])]
            emit({"type": "result", "is_error": bool(ev.get("is_error")), "text": ev.get("result") or "",
                  "denials": denials, "session_id": State.session_id,
                  "cost": ev.get("total_cost_usd")})
            return


def stop_claude():
    if State.busy:
        State.interrupted = True
        return CLAUDE.interrupt()
    return False


# ---------------------------------------------------------------- HTTP

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".vrm": "application/octet-stream", ".json": "application/json",
        ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp"}
MODELS = os.path.join(WEB, "models")


class Handler(BaseHTTPRequestHandler):
    server_version = "ClaudeAvatar/1.0"

    def log_message(self, fmt, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self.send_error(403)
            return False
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^http://(127\.0\.0\.1|localhost):\d+$", origin):
            self.send_error(403)
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self._json({
                "session_id": State.session_id, "busy": State.busy,
                "stt": whisper_ready(), "tts_engine": CFG["tts"]["engine"],
                "voice": State.voice if CFG["tts"]["engine"] == "say" else CFG["tts"]["edge_voice"],
                "workdir": CFG["workdir"], "permission_mode": CFG["permission_mode"],
            })
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._local_only():
            return
        path = self.path.split("?")[0]
        try:
            if path == "/api/stt":
                if not whisper_ready():
                    return self._json({"error": "whisper-server not running"}, 503)
                t0 = time.time()
                text = transcribe(self._body())
                log(f"STT ({time.time() - t0:.1f}s):", text)
                return self._json({"text": text})
            if path == "/api/tts":
                text = json.loads(self._body() or b"{}").get("text", "")
                audio, mime = synthesize(text)
                if not audio:
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
                return
            if path == "/api/chat":
                return self._chat(json.loads(self._body() or b"{}").get("text", "").strip())
            if path == "/api/avatar":
                return self._save_avatar()
            if path == "/api/portrait":
                return self._save_rig(json.loads(self._body() or b"{}"))
            if path == "/api/stop":
                return self._json({"stopped": stop_claude()})
            if path == "/api/reset":
                stop_claude()
                CLAUDE.kill()
                State.session_id = None
                State.save()
                return self._json({"ok": True})
        except subprocess.CalledProcessError as e:
            return self._json({"error": (e.stderr or b"").decode(errors="ignore")[-400:] or str(e)}, 500)
        except Exception as e:  # report to UI instead of dropping the connection
            log("ERROR", path, repr(e))
            return self._json({"error": str(e)}, 500)
        self.send_error(404)

    def _save_avatar(self):
        """Persist an uploaded character so it is used on the next launch too."""
        from urllib.parse import parse_qs, urlparse
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        kind, ext = q.get("kind"), q.get("ext", "")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 80 * 1024 * 1024:
            return self._json({"error": "الملف كبير جدًا"}, 413)
        os.makedirs(MODELS, exist_ok=True)
        if kind == "vrm":
            name = "default.vrm"
        elif kind == "portrait" and ext in ("png", "jpg", "webp"):
            name = "portrait." + ext
        else:
            return self._json({"error": "نوع ملف غير مدعوم"}, 400)
        tmp = os.path.join(MODELS, "." + name + ".part")
        with open(tmp, "wb") as f:
            f.write(self._body())
        os.replace(tmp, os.path.join(MODELS, name))
        if kind == "vrm":
            self._save_rig(None, disable=True, reply=False)
        log("AVATAR: saved", name)
        return self._json({"image": name})

    def _save_rig(self, data, disable=False, reply=True):
        path = os.path.join(MODELS, "portrait.json")
        if disable:
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    cfg = json.load(f)
                cfg["enabled"] = False
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=1)
            return None
        pts = data.get("points") or {}
        image = os.path.basename(data.get("image", ""))
        if not os.path.isfile(os.path.join(MODELS, image)) or \
                sorted(pts) != ["chin", "eyeA", "eyeB", "mouth", "top"]:
            return self._json({"error": "بيانات المعايرة غير مكتملة"}, 400)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"enabled": True, "image": image, "points": pts}, f, ensure_ascii=False, indent=1)
        return self._json({"ok": True}) if reply else None

    def _chat(self, text):
        if not text:
            return self._json({"error": "empty"}, 400)
        if not State.lock.acquire(blocking=False):
            return self._json({"error": "busy"}, 409)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            alive = [True]

            def emit(obj):
                if not alive[0]:
                    return
                try:
                    self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    alive[0] = False
                    stop_claude()

            State.interrupted = False
            try:
                run_claude(text, emit)
            except FileNotFoundError:
                emit({"type": "error", "text": f"لم يتم العثور على Claude Code ({CFG['claude_bin']})"})
        finally:
            State.busy = False
            State.lock.release()


# ---------------------------------------------------------------- checks

def check():
    ok = True

    def row(name, good, info=""):
        nonlocal ok
        ok = ok and good
        print(f"  {'✅' if good else '❌'} {name}  {info}")

    print("Claude Avatar — فحص المتطلبات")
    cl = shutil.which(CFG["claude_bin"])
    ver = subprocess.run([cl, "--version"], capture_output=True, text=True).stdout.strip() if cl else ""
    row("Claude Code", bool(cl), ver or "غير مثبت: curl -fsSL https://claude.ai/install.sh | bash")
    row("whisper-server", bool(shutil.which(CFG["stt"]["server_bin"])), "brew install whisper-cpp")
    row("Whisper model", os.path.exists(CFG["stt"]["model"]), CFG["stt"]["model"])
    if CFG["tts"]["engine"] == "edge":
        row("edge-tts", bool(shutil.which("edge-tts")), "pipx install edge-tts")
    else:
        v = pick_say_voice()
        row("Arabic voice (say)", bool(v), v or "أضف صوتًا عربيًا من: إعدادات النظام ← تسهيلات الاستخدام ← المحتوى المنطوق")
    row("Avatar model", os.path.exists(os.path.join(WEB, "models", "default.vrm")), "web/models/default.vrm")
    row("Workdir", os.path.isdir(CFG["workdir"]), CFG["workdir"])
    return ok


def main():
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
    State.load()
    State.voice = pick_say_voice() if CFG["tts"]["engine"] == "say" else None
    log("TTS:", CFG["tts"]["engine"], CFG["tts"]["edge_voice"] if CFG["tts"]["engine"] == "edge" else State.voice)
    start_whisper()
    srv = ThreadingHTTPServer(("127.0.0.1", CFG["port"]), Handler)
    srv.daemon_threads = True

    def shutdown(*_):
        CLAUDE.kill()
        if State.whisper:
            State.whisper.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log(f"Claude Avatar running on http://127.0.0.1:{CFG['port']}  (workdir: {CFG['workdir']})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
