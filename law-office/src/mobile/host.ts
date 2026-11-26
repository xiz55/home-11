// مضيف نسخة الآيفون: يشغّل منطق البرنامج نفسه (AppCore والخدمات والصلاحيات والمزامنة) داخل تطبيق Capacitor،
// ويقدّم للواجهة الجسر نفسه window.lawApi الذي يقدّمه Electron على سطح المكتب.
import { Buffer } from 'buffer';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { App as CapApp } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { configureSqlite, flushAll } from './sqlite-shim';
import * as vfs from './shims/vfs';
import { CapacitorBackend, IdbBackend } from './backends';
import { Keychain, LawPrint, isNative } from './native';
import { AppCore } from '../main/core';
import { attachmentPath } from '../main/paths';
import { setBlobEnsurer, setFileLoader } from '../main/services/documents';
import { takeDueReminders } from '../main/services/reminders';
import { CloudService, type SecretStore } from '../sync/cloudService';
import type { Platform } from '../main/context';

const DATA = '/data';
const SESSION = 'ios-main';
const EVENTS = new Set(['session:locked', 'reminders:fired', 'app:navigate', 'cloud:status']);
const CHANNEL = /^[a-zA-Z]+\.[a-zA-Z]+$/;
// ما لا ينطبق على الآيفون: حزم النسخ الاحتياطية المضغوطة واستعادتها، وربط أدوات الذكاء الاصطناعي (MCP)،
// وفتح مجلد البيانات. هذه تبقى في نسخة سطح المكتب كما هي.
const DESKTOP_ONLY = /^(backup\.(create|export|inspectRestore|cancelRestore|applyRestore)|integration\.(setEnabled|createToken|revokeToken|accessLog)|system\.openDataFolder)$/;

type Listener = (d: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
function emit(ev: string, data?: unknown) {
  for (const l of listeners.get(ev) ?? []) l(data);
}

function secretStore(): SecretStore {
  if (isNative()) {
    return {
      get: async (k) => (await Keychain.get({ key: k })).value ?? null,
      set: async (k, v) => (v === null ? Keychain.remove({ key: k }) : Keychain.set({ key: k, value: v })),
    };
  }
  // متصفح الاختبار فقط: ذاكرة مؤقتة (لا حفظ دائم للأسرار)
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) };
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
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

export async function bootHost(opts: { testBackend?: boolean } = {}) {
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
  const backend = isNative() && !opts.testBackend ? new CapacitorBackend() : new IdbBackend();
  const lazyRe = /^\/data\/(attachments\/(?!\.staging)|backups\/|exports\/|working-copies\/)/;
  await vfs.mountVfs(backend, { isLazy: (p) => lazyRe.test(p) });
  vfs.rmSync(`${DATA}/tmp/picks`, { recursive: true, force: true });

  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  configureSqlite({
    SQL,
    io: {
      read: (f) => (vfs.existsSync(f) ? new Uint8Array(vfs.readFileSync(f) as Uint8Array) : null),
      write: (f, b) => vfs.writeFileSync(f, b),
    },
    saveDelayMs: 400,
  });

  const shareWhenWritten = new Set<string>();
  async function share(file: string, title: string) {
    await vfs.flushVfs();
    if (backend instanceof CapacitorBackend) await Share.share({ title, files: [await backend.uri(file)] });
    else emit('test:shared', file);
  }
  vfs.onFileWritten((p) => {
    if (!shareWhenWritten.delete(p)) return;
    void share(p, p.slice(p.lastIndexOf('/') + 1)).catch(() => undefined);
  });

  const platform: Platform = {
    async showOpenFile(o) {
      const exts = (o.filters ?? []).flatMap((f) => f.extensions).map((e) => `.${e}`);
      const f = await pickFile(exts.join(','));
      if (!f) return null;
      const dir = `${DATA}/tmp/picks/${crypto.randomUUID()}`;
      vfs.mkdirSync(dir, { recursive: true });
      const p = `${dir}/${f.name.replace(/[\\/]/g, '_')}`;
      vfs.writeFileSync(p, new Uint8Array(await f.arrayBuffer()));
      return p;
    },
    async showSaveFile(o) {
      // الآيفون: يُحفظ الملف في مجلد التصدير ثم تُفتح ورقة المشاركة (حفظ في «الملفات»، بريد، طباعة…)
      const dir = `${DATA}/exports/${crypto.randomUUID()}`;
      vfs.mkdirSync(dir, { recursive: true });
      const p = `${dir}/${o.defaultName.replace(/[\\/]/g, '_')}`;
      shareWhenWritten.add(p);
      return p;
    },
    async openPath(p) {
      try {
        await share(p, p.slice(p.lastIndexOf('/') + 1));
        return '';
      } catch (e) {
        return String((e as Error).message);
      }
    },
    showItemInFolder(p) {
      void share(p, p.slice(p.lastIndexOf('/') + 1)).catch(() => undefined);
    },
    async printHtml(html) {
      if (isNative()) await LawPrint.print({ html, jobName: 'مكتب المحاماة' });
      else emit('test:printed', html.length);
    },
    async htmlToPdf(html, o) {
      if (!isNative()) throw new Error('PDF غير متاح في متصفح الاختبار');
      const r = await LawPrint.pdf({ html, landscape: !!o?.landscape });
      return Buffer.from(r.base64, 'base64');
    },
  };

  const core = new AppCore(DATA, platform, () => new Date(), { noExtraction: true });
  core.onLocked = () => emit('session:locked');
  core.startup();

  const secrets = secretStore();
  core.cloud = new CloudService({
    db: () => core.db,
    secrets,
    blobStore: {
      has: (n) => vfs.existsSync(attachmentPath(core.paths, n)),
      read: async (n) => {
        const f = attachmentPath(core.paths, n);
        await vfs.loadFile(f);
        const b = new Uint8Array(vfs.readFileSync(f) as Uint8Array);
        vfs.unloadFile(f);
        return b;
      },
      write: (n, b) => {
        const f = attachmentPath(core.paths, n);
        vfs.mkdirSync(f.slice(0, f.lastIndexOf('/')), { recursive: true });
        vfs.writeFileSync(f, b);
      },
      remove: (n) => vfs.rmSync(attachmentPath(core.paths, n), { force: true }),
    },
    device: { name: 'iPhone', platform: 'ios', appVersion: '1.0.0' },
    // الآيفون: لا تنزيل تلقائي لكل المرفقات؛ فقط ما اختاره المستخدم «متاحًا دون اتصال»
    autoDownload: () => false,
    onStatus: (s) => emit('cloud:status', s),
  });
  setBlobEnsurer((vid) => core.cloud!.blobs!.download(vid));
  setFileLoader((f) => vfs.loadFile(f));
  void core.cloud.init().catch(() => undefined);

  // التذكيرات وقفل الخمول أثناء فتح التطبيق
  setInterval(() => {
    for (const k of core.sessions.keys()) core.checkIdle(k);
    try {
      const due = takeDueReminders(core.systemCtx());
      if (due.length) emit('reminders:fired', due.length);
    } catch {
      /* */
    }
  }, 30_000);

  // حفظ كل شيء عند انتقال التطبيق للخلفية، ومزامنة عند العودة
  if (isNative()) {
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        flushAll();
        void vfs.flushVfs();
      } else void core.cloud?.syncNow().catch(() => undefined);
    });
  }
  window.addEventListener('pagehide', () => flushAll());

  window.lawApi = {
    async invoke(channel: string, payload?: unknown) {
      if (typeof channel !== 'string' || !CHANNEL.test(channel)) throw new Error('قناة غير مسموحة');
      if (DESKTOP_ONLY.test(channel)) return { ok: false, error: { code: 'UNSUPPORTED', message: 'هذه العملية متاحة في نسخة سطح المكتب (ويندوز/ماك) فقط.' } };
      const r = await core.dispatch(SESSION, channel, payload);
      return r as never;
    },
    on(event: string, cb: (d: unknown) => void) {
      if (!EVENTS.has(event) && !event.startsWith('test:')) return () => {};
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => set.delete(cb);
    },
  };
  (window as unknown as { __lawHost?: unknown }).__lawHost = { core, vfs, flush: async () => (flushAll(), vfs.flushVfs()) };
  document.documentElement.classList.add('platform-ios');
  return core;
}
