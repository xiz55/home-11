// الرابط الآمن (للآيفون وأي متصفح): الواجهة نفسها، وكل الأوامر تُنفّذ على جهاز المكتب ويُحفظ كل شيء فيه.
// لا تُخزن بيانات المكتب على الجوال. الدخول: كلمة المرور، ورمز يصل إلى البريد عند أول دخول من الجهاز ثم كل 15 يومًا.
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '../renderer/styles/app.css';

type ApiResult = { ok: boolean; data?: unknown; error?: { code: string; message: string; fields?: Record<string, string> } };

function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { __b64: btoa(s) };
  }
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { __b64?: unknown }).__b64 === 'string' && Object.keys(v).length === 1) {
    const bin = atob((v as { __b64: string }).__b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, decode(x)]));
  return v;
}

async function post(p: string, body: unknown) {
  const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j as Record<string, unknown> };
}

async function dispatch(channel: string, payload: unknown): Promise<ApiResult> {
  let r;
  try {
    r = await post('/api/dispatch', { channel, payload: encode(payload) });
  } catch {
    return { ok: false, error: { code: 'STORAGE', message: 'تعذر الاتصال بجهاز المكتب. تحقق من الإنترنت وأن جهاز المكتب يعمل.' } };
  }
  const res = decode(r.body) as ApiResult;
  if (!res.ok && res.error?.code === 'UNAUTHENTICATED') location.reload();
  return res;
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.heic,.xlsx,.txt';
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** فتح الملف أو حفظه: يُنزّل من جهاز المكتب بعد التحقق من الصلاحية، ويعرضه الجوال أو يحفظه في «الملفات». */
function download(versionId: string) {
  const a = document.createElement('a');
  a.href = `/api/file/${versionId}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

window.lawApi = {
  async invoke(channel: string, payload?: unknown) {
    if (typeof channel !== 'string' || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(channel)) throw new Error('قناة غير مسموحة');
    const p = (payload ?? {}) as Record<string, unknown>;
    if (channel === 'documents.pickFile') {
      const f = await pickFile();
      if (!f) return { ok: true, data: null };
      return dispatch('documents.stageBytes', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    if (channel === 'documents.open' || channel === 'documents.showInFolder') {
      download(String(p.versionId));
      return { ok: true, data: { opened: true, message: 'يُنزَّل الملف من جهاز المكتب…' } };
    }
    if (channel === 'documents.export') {
      download(String(p.versionId));
      return { ok: true, data: { saved: true } };
    }
    const r = await dispatch(channel, p);
    // بعد الخروج أو انتهاء الجلسة: شاشة الدخول الآمن (كلمة المرور + الرمز عند الحاجة) لا شاشة البرنامج المحلية
    const noUser = channel === 'auth.state' && r.ok && !(r.data as { user?: unknown } | undefined)?.user;
    if (channel === 'auth.logout' || noUser) {
      location.reload();
      return new Promise(() => {}) as never;
    }
    return r as never;
  },
  on() {
    return () => {};
  },
};

// ———— شاشة الدخول (قبل تحميل البرنامج) ————
const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

function field(label: string, input: HTMLInputElement) {
  const id = `f-${Math.random().toString(36).slice(2)}`;
  input.id = id;
  input.className = 'input';
  return h('div', { class: 'field' }, h('label', { for: id }, label), input);
}

function gate(officeName: string): Promise<void> {
  return new Promise((done) => {
    const root = document.getElementById('root')!;
    root.innerHTML = '';
    const err = h('div', { class: 'field-error', role: 'alert', style: 'color: var(--danger-text); min-height: 1.4em' });
    const mark = h('div', { class: 'mark', 'aria-hidden': 'true' }, '⚖');
    const head = h('div', { class: 'office' }, mark, h('h1', {}, officeName || 'مكتب المحاماة'), h('div', { class: 'help', style: 'margin-top:6px' }, 'الدخول الآمن إلى جهاز المكتب'));
    const user = h('input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }) as HTMLInputElement;
    const pass = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
    const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'دخول') as HTMLButtonElement;
    const form = h('form', { class: 'stack g2', novalidate: '' }, field('اسم المستخدم', user), field('كلمة المرور', pass), err, btn) as HTMLFormElement;
    const card = h('div', { class: 'auth-card' }, head, form);
    root.append(h('div', { class: 'auth-screen' }, card));
    user.focus();
    let challenge: string | null = null;
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*' }) as HTMLInputElement;
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        if (!challenge) {
          const r = await post('/api/web/login', { username: user.value.trim(), password: pass.value, deviceName: /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : 'متصفح' });
          if (r.status !== 200) throw new Error(String(r.body.error ?? 'تعذر الدخول'));
          if (r.body.ok) return done();
          challenge = String(r.body.challengeId);
          form.replaceChildren(h('div', { class: 'help' }, `أرسلنا رمز تحقق من 6 أرقام إلى ${String(r.body.sentTo)}. هذا الجهاز لن يُطلب منه الرمز مرة أخرى لمدة 15 يومًا.`), field('رمز التحقق', code), err, btn);
          btn.textContent = 'تحقق';
          code.focus();
        } else {
          const r = await post('/api/web/verify', { challengeId: challenge, code: code.value.trim() });
          if (r.status !== 200) throw new Error(String(r.body.error ?? 'الرمز غير صحيح'));
          return done();
        }
      } catch (x) {
        err.textContent = (x as Error).message;
      } finally {
        btn.disabled = false;
      }
    };
  });
}

async function boot() {
  (window as unknown as { __lawBooted?: boolean }).__lawBooted = false;
  document.documentElement.classList.add('platform-ios', 'platform-web');
  let st = { session: false, officeName: '' };
  try {
    st = (await (await fetch('/api/web/state', { credentials: 'same-origin' })).json()) as typeof st;
  } catch {
    document.getElementById('root')!.textContent = 'تعذر الاتصال بجهاز المكتب. تحقق من الإنترنت وأن جهاز المكتب يعمل.';
    return;
  }
  if (!st.session) {
    const p = gate(st.officeName);
    (window as unknown as { __lawBooted?: boolean }).__lawBooted = true;
    await p;
  }
  (window as unknown as { __lawBooted?: boolean }).__lawBooted = true;
  document.getElementById('root')!.innerHTML = '';
  await import('../renderer/main');
}

void boot();
