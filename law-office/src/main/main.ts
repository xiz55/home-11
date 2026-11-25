// نقطة دخول Electron. الواجهة معزولة (contextIsolation + sandbox، بلا nodeIntegration)، وكل الوصول للبيانات والملفات هنا.
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerSaveBlocker, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppCore } from './core';
import { REGISTRY } from './ipc/registry';
import { appendLog, buildPaths } from './paths';
import type { Platform } from './context';
import { setRuntime } from './runtime';
import { takeDueReminders } from './services/reminders';
import { loadReportFonts } from './services/reports';
import { readSetting } from './services/settings';
import { CloudService, type SecretStore } from '../sync/cloudService';
import { setBlobEnsurer } from './services/documents';
import { attachmentPath } from './paths';
import { HubClient } from '../sync/hubClient';
import { HubController } from '../hub/controller';
import { getState } from '../sync/local';
import { safeStorage } from 'electron';

const APP_ID = 'com.lawoffice.manager';
const isDev = !app.isPackaged;

// ———— تحديد مجلد البيانات (مسار بيانات المستخدم في نظام التشغيل، خارج مجلد التثبيت) ————
function argValue(name: string): string | null {
  const pref = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}
const customDir = argValue('data-dir') ?? process.env.LAWOFFICE_DATA_DIR ?? null;
const dataDir = customDir ? path.resolve(customDir) : path.join(app.getPath('userData'), 'data');
if (customDir) {
  // مساحة منفصلة (اختبار/تجربة): ملف تعريف Chromium مستقل أيضًا
  app.setPath('userData', path.join(path.dirname(dataDir), `.profile-${path.basename(dataDir)}`));
}
app.setAppUserModelId(APP_ID);
// تنسيق حقول التاريخ سنة-شهر-يوم بأرقام لاتينية متسقًا مع عرض التواريخ في البرنامج
app.commandLine.appendSwitch('lang', 'en-CA');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// ———— منع نسختين على البيانات نفسها ————
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const paths = buildPaths(dataDir);
function acquireDataLock(): boolean {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const info = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(paths.lockFile, info, { flag: 'wx' });
      return true;
    } catch {
      try {
        const cur = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')) as { pid: number; host: string };
        let alive = false;
        if (cur.host === os.hostname()) {
          try {
            process.kill(cur.pid, 0);
            alive = cur.pid !== process.pid;
          } catch {
            alive = false;
          }
        } else alive = true; // مجلد مشترك من جهاز آخر — لا نتجاوزه
        if (alive) return false;
        fs.rmSync(paths.lockFile, { force: true }); // قفل قديم من تشغيل انتهى بشكل غير طبيعي
      } catch {
        fs.rmSync(paths.lockFile, { force: true });
      }
    }
  }
  return false;
}
function releaseDataLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')) as { pid: number };
    if (cur.pid === process.pid) fs.rmSync(paths.lockFile, { force: true });
  } catch {
    /* */
  }
}

let mainWindow: BrowserWindow | null = null;
let core: AppCore | null = null;
const rendererDir = path.join(__dirname, '..', 'renderer');

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' about: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/octet-stream',
};

function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'local') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.resolve(rendererDir, '.' + rel);
    const relCheck = path.relative(rendererDir, target);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(target);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  // لا اتصالات شبكة خارجية من الواجهة إطلاقًا
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    if (/^(https?|wss?|ftp):/i.test(url) && !/^devtools:/.test(url)) {
      appendLog(paths, `BLOCKED network request: ${url.slice(0, 200)}`);
      return cb({ cancel: true });
    }
    cb({});
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

function platformFor(getWin: () => BrowserWindow | null): Platform {
  const renderHidden = async (html: string) => {
    const file = path.join(paths.tmpDir, `report-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    await w.loadFile(file);
    return { w, file };
  };
  return {
    async showOpenFile(opts) {
      const win = getWin();
      const r = win ? await dialog.showOpenDialog(win, { title: opts.title, filters: opts.filters, properties: ['openFile'] }) : await dialog.showOpenDialog({ title: opts.title, filters: opts.filters, properties: ['openFile'] });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    async showSaveFile(opts) {
      const win = getWin();
      const o = { title: opts.title, defaultPath: path.join(app.getPath('documents'), opts.defaultName), filters: opts.filters };
      const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    async printHtml(html) {
      const { w, file } = await renderHidden(html);
      await new Promise<void>((resolve) => {
        w.webContents.print({ printBackground: true, silent: false }, () => resolve());
      });
      w.destroy();
      fs.rmSync(file, { force: true });
    },
    async htmlToPdf(html, opts) {
      const { w, file } = await renderHidden(html);
      try {
        if (opts?.footer) {
          // ترقيم الصفحات وتاريخ الاستخراج في تذييل كل صفحة
          const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return await w.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            landscape: !!opts.landscape,
            pageSize: 'A4',
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `<div dir="rtl" style="width:100%;font-family:Tahoma,'Segoe UI',sans-serif;font-size:7.5px;color:#555;padding:0 10mm;display:flex;justify-content:space-between;"><span>${esc(opts.footer)}</span><span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>`,
          });
        }
        return await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' });
      } finally {
        w.destroy();
        fs.rmSync(file, { force: true });
      }
    },
  };
}

function buildContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      items.push({ label: 'قص', role: 'cut', enabled: params.editFlags.canCut }, { label: 'نسخ', role: 'copy', enabled: params.editFlags.canCopy }, { label: 'لصق', role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { label: 'تحديد الكل', role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ label: 'نسخ', role: 'copy' }, { label: 'تحديد الكل', role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const iconFile = path.join(__dirname, '..', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#F7F7F5',
    title: readSetting(core!.db, 'office.name'),
    icon: fs.existsSync(iconFile) ? iconFile : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev || process.env.LAWOFFICE_DEVTOOLS === '1',
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://local/')) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('before-input-event', (e, input) => {
    // اختصارات التكبير والتصغير (Ctrl + / Ctrl - / Ctrl 0)
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = mainWindow!.webContents;
    if (input.key === '=' || input.key === '+') {
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3));
      e.preventDefault();
    } else if (input.key === '-') {
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -2));
      e.preventDefault();
    } else if (input.key === '0') {
      wc.setZoomLevel(0);
      e.preventDefault();
    }
  });
  buildContextMenu(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    const key = `wc-${mainWindow!.webContents.id}`;
    const s = core?.sessions.get(key);
    if (s?.dirty) {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        buttons: ['البقاء ومتابعة التحرير', 'الخروج دون حفظ'],
        defaultId: 0,
        cancelId: 0,
        title: 'نص غير محفوظ',
        message: 'لديك نص لم يُحفظ بعد. هل تريد الخروج وفقدان التغييرات غير المحفوظة؟',
      });
      if (choice === 0) e.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL('app://local/index.html');
}

/** قائمة التطبيق: على ماك قائمة عربية قياسية باختصارات Command (نسخ/لصق/تكبير/إغلاق)، وعلى ويندوز لا شريط قوائم. */
function buildAppMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const zoom = (d: number | null, w?: Electron.BaseWindow) => {
    const target = (w instanceof BrowserWindow ? w : null) ?? BrowserWindow.getFocusedWindow() ?? mainWindow;
    const wc = target?.webContents;
    if (!wc) return;
    wc.setZoomLevel(d === null ? 0 : Math.max(-2, Math.min(3, wc.getZoomLevel() + d)));
  };
  const name = 'إدارة مكتب المحاماة';
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `حول ${name}` },
        { type: 'separator' },
        { role: 'hide', label: `إخفاء ${name}` },
        { role: 'hideOthers', label: 'إخفاء الآخرين' },
        { role: 'unhide', label: 'إظهار الكل' },
        { type: 'separator' },
        { role: 'quit', label: `إنهاء ${name}` },
      ],
    },
    {
      label: 'تحرير',
      submenu: [
        { role: 'undo', label: 'تراجع' },
        { role: 'redo', label: 'إعادة' },
        { type: 'separator' },
        { role: 'cut', label: 'قص' },
        { role: 'copy', label: 'نسخ' },
        { role: 'paste', label: 'لصق' },
        { role: 'selectAll', label: 'تحديد الكل' },
      ],
    },
    {
      label: 'عرض',
      submenu: [
        { label: 'تكبير', accelerator: 'Command+=', click: (_i, w) => zoom(0.5, w) },
        { label: 'تصغير', accelerator: 'Command+-', click: (_i, w) => zoom(-0.5, w) },
        { label: 'الحجم الافتراضي', accelerator: 'Command+0', click: (_i, w) => zoom(null, w) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'ملء الشاشة' },
      ],
    },
    {
      label: 'نافذة',
      submenu: [
        { role: 'minimize', label: 'تصغير إلى Dock' },
        { role: 'zoom', label: 'تكبير النافذة' },
        { role: 'close', label: 'إغلاق النافذة' },
        { type: 'separator' },
        { role: 'front', label: 'إحضار الكل للأمام' },
      ],
    },
    {
      label: 'مساعدة',
      submenu: [
        {
          label: 'دليل الاستخدام',
          click: () => {
            const f = path.join(app.isPackaged ? path.join(process.resourcesPath, 'docs') : path.join(__dirname, '..', '..', 'docs'), 'دليل-الاستخدام.html');
            if (fs.existsSync(f)) void shell.openPath(f);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  for (const name of Object.keys(REGISTRY)) {
    ipcMain.handle(`api:${name}`, async (event, payload) => {
      // التحقق من مصدر الطلب: الإطار الرئيسي لصفحة البرنامج فقط
      const frameUrl = event.senderFrame?.url ?? '';
      if (!frameUrl.startsWith('app://local/') || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'مصدر غير موثوق' } };
      }
      return core!.dispatch(`wc-${event.sender.id}`, name, payload);
    });
  }
}

/** مخزن أسرار الجهاز: مشفر بمخزن النظام (DPAPI على ويندوز، Keychain على ماك) عبر safeStorage، خارج مجلد البيانات والنسخ الاحتياطية. */
function deviceSecrets(): SecretStore {
  const file = path.join(app.getPath('userData'), 'secure', 'device-secrets.json');
  const mem = new Map<string, string>();
  const can = () => safeStorage.isEncryptionAvailable();
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    async get(k) {
      if (!can()) return mem.get(k) ?? null;
      const v = load()[k];
      return v ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null;
    },
    async set(k, v) {
      if (!can()) {
        // لا مخزن أسرار متاح (بعض توزيعات لينكس): لا يُحفظ شيء على القرص، ويُطلب الدخول عند كل تشغيل
        if (v === null) mem.delete(k);
        else mem.set(k, v);
        return;
      }
      const all = load();
      if (v === null) delete all[k];
      else all[k] = safeStorage.encryptString(v).toString('base64');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
}

function setupCloud(c: AppCore) {
  const secrets = deviceSecrets();
  const platformName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  let autoDownload = true;
  c.cloud = new CloudService({
    db: () => c.db,
    secrets,
    blobStore: {
      has: (n) => fs.existsSync(attachmentPath(c.paths, n)),
      read: (n) => new Uint8Array(fs.readFileSync(attachmentPath(c.paths, n))),
      write: (n, b) => {
        const f = attachmentPath(c.paths, n);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(`${f}.part`, b);
        fs.renameSync(`${f}.part`, f);
      },
      remove: (n) => fs.rmSync(attachmentPath(c.paths, n), { force: true }),
    },
    device: { name: os.hostname(), platform: platformName, appVersion: app.getVersion() },
    autoDownload: () => autoDownload,
    onStatus: (s) => mainWindow?.webContents.send('cloud:status', s),
  });
  const blobStore = {
    has: (n: string) => fs.existsSync(attachmentPath(c.paths, n)),
    read: (n: string) => new Uint8Array(fs.readFileSync(attachmentPath(c.paths, n))),
    write: (n: string, b: Uint8Array) => {
      const f = attachmentPath(c.paths, n);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.part`, b);
      fs.renameSync(`${f}.part`, f);
    },
    remove: (n: string) => fs.rmSync(attachmentPath(c.paths, n), { force: true }),
  };
  // ربط هذا الجهاز (الماك) بخادم المكتب المحلي
  c.hubClient = new HubClient({
    db: () => c.db,
    secrets,
    blobStore,
    device: { name: os.hostname(), platform: platformName, appVersion: app.getVersion() },
    autoDownload: () => autoDownload,
    onStatus: (s) => mainWindow?.webContents.send('cloud:status', { ...s, mode: 'hub' }),
  });
  // هذا الجهاز خادم المكتب (جهاز المكتب الدائم)
  let blocker: number | null = null;
  const keepAwake = () => {
    if (c.hub?.running()) {
      // جهاز المكتب يبقى متاحًا: يمنع تعليق البرنامج، ويبدأ مع تسجيل الدخول إلى ويندوز
      if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      app.setLoginItemSettings({ openAtLogin: true });
    } else if (blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };
  c.hub = new HubController({ core: c, secrets, webDir: path.join(__dirname, '..', 'web'), onState: keepAwake });
  setBlobEnsurer((versionId) => (c.hubClient?.linked() ? c.hubClient.blobs : c.cloud!.blobs!).download(versionId));
  void secrets.get('pref.autoDownload').then((v) => (autoDownload = v !== '0'));
  const hubMode = getState(c.db, 'mode') === 'hub';
  void c.hubClient
    .init()
    .then(() => {
      if (c.hubClient?.linked()) c.hubClient.startLoop(60_000);
    })
    .catch((e) => appendLog(paths, `hub client init: ${(e as Error).message}`));
  void c.hub
    .init()
    .then(keepAwake)
    .catch((e) => appendLog(paths, `hub server: ${(e as Error).message}`));
  if (hubMode) return;
  void c.cloud
    .init()
    .then(() => {
      if (c.cloud?.getStatus().officeId) c.cloud.startLoop(60_000);
    })
    .catch((e) => appendLog(paths, `cloud init: ${(e as Error).message}`));
}

function startScheduler() {
  const tick = () => {
    if (!core) return;
    // قفل الجلسات الخاملة وإبلاغ الواجهة
    for (const key of core.sessions.keys()) core.checkIdle(key);
    try {
      const due = takeDueReminders(core.systemCtx());
      if (due.length && Notification.isSupported()) {
        const anyUnlocked = [...core.sessions.values()].some((s) => !s.locked);
        for (const r of due.slice(0, 5)) {
          // عند قفل الجلسة لا تظهر أسماء العملاء في الإشعار
          const n = new Notification({ title: anyUnlocked ? 'تذكير — مكتب المحاماة' : 'تذكير بموعد', body: anyUnlocked ? r.label : 'لديك موعد قريب. افتح البرنامج للاطلاع.', silent: false });
          n.on('click', () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.focus();
              if (r.entityType === 'consultation') mainWindow.webContents.send('app:navigate', `/appointments/consultations/${r.entityId}`);
              else if (r.entityType === 'meeting') mainWindow.webContents.send('app:navigate', `/appointments/meetings/${r.entityId}`);
              else if (r.caseId) mainWindow.webContents.send('app:navigate', `/cases/${r.caseId}`);
            }
          });
          n.show();
        }
        mainWindow?.webContents.send('reminders:fired', due.length);
      }
    } catch (e) {
      appendLog(paths, `scheduler: ${(e as Error).message}`);
    }
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
}

process.on('uncaughtException', (e) => appendLog(paths, `uncaught: ${e.stack ?? e}`));
process.on('unhandledRejection', (e) => appendLog(paths, `unhandled: ${(e as Error)?.stack ?? e}`));

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (!acquireDataLock()) {
    dialog.showErrorBox('البرنامج مفتوح مسبقًا', 'بيانات المكتب مفتوحة حاليًا في نسخة أخرى من البرنامج. أغلقها أولًا ثم أعد المحاولة، حمايةً للبيانات من التعارض.');
    app.exit(0);
    return;
  }
  buildAppMenu();
  setRuntime({
    appVersion: app.getVersion(),
    execPath: process.execPath,
    // خادم MCP خارج أرشيف asar حتى يُشغَّل مباشرة بوضع Node
    mcpScriptPath: path.join(__dirname, '..', 'mcp', 'server.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
    fontsDir: path.join(__dirname, '..', 'fonts'),
    docsDir: app.isPackaged ? path.join(process.resourcesPath, 'docs') : path.join(__dirname, '..', '..', 'docs'),
    isPackaged: app.isPackaged,
    customDataDir: !!customDir,
  });
  loadReportFonts(path.join(__dirname, '..', 'fonts'));
  try {
    core = new AppCore(dataDir, platformFor(() => mainWindow), () => new Date(), { extractWorkerFile: path.join(__dirname, 'extract-worker.mjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) });
    core.onLocked = (key) => {
      const id = Number(key.replace('wc-', ''));
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.id === id) w.webContents.send('session:locked');
    };
    core.startup();
    setupCloud(core);
  } catch (e) {
    appendLog(paths, `startup failed: ${(e as Error).stack}`);
    dialog.showErrorBox('تعذر فتح البيانات', `تعذر فتح قاعدة بيانات المكتب.\n${(e as Error).message}\n\nالمجلد: ${dataDir}`);
    releaseDataLock();
    app.exit(1);
    return;
  }
  hardenSession();
  registerAppProtocol();
  registerIpc();
  createWindow();
  startScheduler();
});

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.on('window-all-closed', () => {
  // على ماك يبقى التطبيق في شريط Dock كالمعتاد بعد إغلاق النافذة، ويُغلق بـ Command+Q
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (core && !mainWindow) createWindow();
  else mainWindow?.show();
});

app.on('before-quit', () => {
  try {
    core?.shutdown();
  } catch {
    /* */
  }
  releaseDataLock();
});
