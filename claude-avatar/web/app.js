import { Avatar } from './avatar.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), you: $('you'), reply: $('reply'), activity: $('activity'), meter: $('meter'),
  start: $('start'), listen: $('listen'), stop: $('stop'), reset: $('reset'), full: $('full'),
  text: $('text'), form: $('form'), file: $('file'), session: $('session'), panel: $('panel'), hide: $('hide'),
};
const LABEL = { idle: 'متوقف', listening: 'أسمعك…', recording: 'أسجّل كلامك…', transcribing: 'أحوّل الكلام لنص…', thinking: 'Claude يفكر وينفّذ…', speaking: 'يتكلم' };

const avatar = new Avatar($('scene'));
const prefs = (() => { try { return JSON.parse(localStorage.getItem('cavatar') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('cavatar', JSON.stringify(prefs)); } catch {} };

let state = 'idle';
let handsFree = prefs.handsFree ?? true;
let ctx, outGain, analyser, micNode, procNode;

function setState(s) {
  state = s;
  ui.status.textContent = LABEL[s] || s;
  ui.status.dataset.state = s;
  avatar.setState(s === 'recording' || s === 'transcribing' ? 'listening' : s === 'listening' ? 'idle' : s);
}

// ------------------------------------------------------------ Avatar loading
async function loadAvatar(url) {
  try { await avatar.load(url); }
  catch (e) { ui.activity.textContent = 'تعذّر تحميل الشخصية: ' + e.message; }
}
loadAvatar('models/default.vrm');
ui.file.addEventListener('change', () => { const f = ui.file.files[0]; if (f) loadAvatar(URL.createObjectURL(f)); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith('.vrm'));
  if (f) loadAvatar(URL.createObjectURL(f));
});

// ------------------------------------------------------------ Speech output (TTS queue)
const speech = { queue: [], playing: null, buffer: '', gen: 0 };

function enqueueSentence(text) {
  const t = text.trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
  const gen = speech.gen;
  const audio = fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) })
    .then((r) => (r.status === 200 ? r.arrayBuffer() : null))
    .then((buf) => (buf ? ctx.decodeAudioData(buf) : null))
    .catch(() => null);
  speech.queue.push({ audio, gen });
  pump();
}

// Split streamed text into speakable sentences as soon as they are complete.
function feedText(chunk, final = false) {
  speech.buffer += chunk;
  const re = /^([\s\S]*?(?:[.!?؟؛](?=\s|$)|\n)|[\s\S]{160,}?[،,\s])/u;
  let m;
  while ((m = speech.buffer.match(re))) {
    enqueueSentence(m[1]);
    speech.buffer = speech.buffer.slice(m[1].length);
  }
  if (final) { enqueueSentence(speech.buffer); speech.buffer = ''; }
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  while (speech.queue.length) {
    const item = speech.queue.shift();
    const buf = await item.audio;
    if (!buf || item.gen !== speech.gen) continue;
    setState('speaking');
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      src.onended = resolve;
      speech.playing = { src, resolve };
      src.start();
    });
    speech.playing = null;
  }
  pumping = false;
  if (state === 'speaking') setState(chatBusy ? 'thinking' : handsFree ? 'listening' : 'idle');
}

function stopSpeaking() {
  speech.gen++;
  speech.queue = [];
  speech.buffer = '';
  if (speech.playing) { try { speech.playing.src.stop(); } catch {} speech.playing.resolve(); }
}

// ------------------------------------------------------------ Claude Code turn
let chatBusy = false;
async function ask(text) {
  if (!text.trim() || chatBusy) return;
  stopSpeaking();
  chatBusy = true;
  ui.you.textContent = text;
  ui.reply.textContent = '';
  ui.activity.textContent = '';
  setState('thinking');
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        if (line.trim()) handleEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    ui.activity.textContent = 'خطأ: ' + e.message;
  }
  feedText('', true);
  chatBusy = false;
  if (!speech.queue.length && !speech.playing) setState(handsFree ? 'listening' : 'idle');
}

function handleEvent(ev) {
  if (ev.type === 'delta') { ui.reply.textContent += ev.text; feedText(ev.text); }
  else if (ev.type === 'tool') ui.activity.textContent = `⚙︎ ${ev.name}${ev.detail ? ': ' + ev.detail : ''}`;
  else if (ev.type === 'result') {
    if (!ui.reply.textContent.trim() && ev.text) { ui.reply.textContent = ev.text; feedText(ev.text); }
    ui.activity.textContent = ev.denials?.length ? '⛔ رُفضت صلاحية: ' + ev.denials.join(' | ') : (ev.is_error ? '⚠︎ انتهت الجولة بخطأ' : '');
    ui.session.textContent = ev.session_id ? `جلسة Claude Code: ${ev.session_id}` : '';
  } else if (ev.type === 'error') {
    ui.activity.textContent = '⚠︎ ' + ev.text;
    feedText('صار خطأ في تشغيل Claude Code، شيّك على النافذة.', true);
  } else if (ev.type === 'stopped') ui.activity.textContent = '⏹ تم الإيقاف';
}

// ------------------------------------------------------------ Microphone + voice activity detection
const vad = { sr: 48000, ring: [], ringMax: 0, rec: null, above: 0, below: 0, floor: 0.004, speechMs: 0 };

async function startAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  outGain = ctx.createGain();
  analyser.connect(outGain).connect(ctx.destination);
  avatar.attachAudio(analyser);

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  micNode = ctx.createMediaStreamSource(stream);
  procNode = ctx.createScriptProcessor(2048, 1, 1);
  vad.sr = ctx.sampleRate;
  vad.ringMax = Math.ceil((0.45 * vad.sr) / 2048); // ~450 ms pre-roll so first syllable isn't cut
  micNode.connect(procNode);
  const sink = ctx.createGain(); sink.gain.value = 0;
  procNode.connect(sink).connect(ctx.destination);
  procNode.onaudioprocess = (e) => onMic(new Float32Array(e.inputBuffer.getChannelData(0)));
}

const pushToTalk = { held: false };

function onMic(buf) {
  let s = 0; for (const v of buf) s += v * v;
  const rms = Math.sqrt(s / buf.length);
  const ms = (buf.length / vad.sr) * 1000;
  ui.meter.style.width = Math.min(100, rms * 900) + '%';

  if (!vad.rec) {
    vad.ring.push(buf); if (vad.ring.length > vad.ringMax) vad.ring.shift();
    if (rms < vad.floor * 1.5 || vad.floor < 0.002) vad.floor = vad.floor * 0.98 + rms * 0.02; // adapt to room noise
  }
  const thr = Math.max(vad.floor * 3.2, 0.012);

  if (pushToTalk.held && !chatBusy) { if (!vad.rec) beginRec(true); vad.rec.push(buf); return; }

  const canListen = handsFree && (state === 'listening');
  // Barge-in: user talks loudly over the avatar → stop speaking and listen (works best with headphones).
  const bargeIn = handsFree && state === 'speaking' && prefs.bargeIn !== false;
  const need = bargeIn ? Math.max(thr * 2.5, 0.05) : thr;

  if (vad.rec) {
    vad.rec.push(buf);
    vad.speechMs += ms;
    vad.peak = Math.max(vad.peak, rms);
    // End of utterance: ~0.85 s clearly quieter than the speaker's own level (robust to steady room noise).
    vad.below = rms < Math.max(thr, vad.peak * 0.22) ? vad.below + ms : 0;
    if (vad.below > 850 || vad.speechMs > 25000) endRec();
    return;
  }
  if ((canListen || bargeIn) && rms > need) {
    vad.above += ms;
    if (vad.above > (bargeIn ? 260 : 110)) {
      if (bargeIn) stopSpeaking();
      beginRec();
    }
  } else vad.above = 0;
}

function beginRec(ptt = pushToTalk.held) {
  if (state === 'speaking') stopSpeaking();
  vad.rec = [...vad.ring];
  vad.ring = [];
  vad.ptt = ptt;
  vad.speechMs = 0; vad.below = 0; vad.above = 0; vad.peak = 0;
  setState('recording');
}

async function endRec() {
  const chunks = vad.rec; vad.rec = null;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total / vad.sr < 0.45) { setState(handsFree ? 'listening' : 'idle'); return; }
  setState('transcribing');
  try {
    const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(chunks, vad.sr) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (j.text) return ask(j.text);
  } catch (e) { ui.activity.textContent = 'تحويل الكلام: ' + e.message; }
  setState(handsFree ? 'listening' : 'idle');
}

function encodeWav(chunks, sr) {
  // Downsample to 16 kHz mono PCM16 (what whisper expects).
  const ratio = sr / 16000;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Float32Array(total); let o = 0; for (const c of chunks) { flat.set(c, o); o += c.length; }
  const n = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += flat[j];
    const x = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

// ------------------------------------------------------------ Controls
ui.start.addEventListener('click', async () => {
  ui.start.disabled = true;
  try {
    await startAudio();
    ui.start.hidden = true;
    document.body.classList.add('running');
    setState(handsFree ? 'listening' : 'idle');
    refreshStatus();
  } catch (e) {
    ui.start.disabled = false;
    ui.activity.textContent = 'تعذّر تشغيل الميكروفون: ' + e.message + ' — اسمح للمتصفح باستخدام الميكروفون من إعدادات النظام ← الخصوصية والأمان ← الميكروفون.';
  }
});
function renderListen() { ui.listen.textContent = handsFree ? '🎙 الاستماع: تلقائي' : '🎙 الاستماع: اضغط مسافة للتحدث'; }
renderListen();
ui.listen.addEventListener('click', () => {
  handsFree = !handsFree; prefs.handsFree = handsFree; savePrefs(); renderListen();
  if (state === 'listening' || state === 'idle') setState(handsFree ? 'listening' : 'idle');
});
ui.stop.addEventListener('click', () => { stopSpeaking(); fetch('/api/stop', { method: 'POST' }); if (vad.rec) vad.rec = null; setState(handsFree ? 'listening' : 'idle'); });
ui.reset.addEventListener('click', async () => {
  stopSpeaking(); await fetch('/api/reset', { method: 'POST' });
  ui.you.textContent = ''; ui.reply.textContent = ''; ui.session.textContent = 'محادثة جديدة';
});
ui.full.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
ui.hide.addEventListener('click', () => ui.panel.classList.toggle('collapsed'));
ui.form.addEventListener('submit', (e) => { e.preventDefault(); const t = ui.text.value; ui.text.value = ''; if (ctx) ask(t); });

// Space = push-to-talk (when not typing).
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement !== ui.text && ctx) { e.preventDefault(); pushToTalk.held = true; }
  if (e.code === 'Escape') ui.stop.click();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pushToTalk.held) { e.preventDefault(); pushToTalk.held = false; if (vad.rec) endRec(); }
});

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    ui.session.textContent = (s.session_id ? `جلسة Claude Code: ${s.session_id}` : 'محادثة جديدة') + ` · ${s.workdir}` + (s.stt ? '' : ' · ⚠︎ تحويل الكلام غير جاهز (whisper)') + (s.voice ? ` · الصوت: ${s.voice}` : ' · ⚠︎ لا يوجد صوت عربي');
  } catch {}
}
refreshStatus();
setState('idle');
window.__cavatar = { ask, avatar, feedText, get state() { return state; } };
