// واجهة «خادم المكتب» على الشبكة (تعمل على جهاز المكتب فقط، وتستمع على 127.0.0.1؛ الوصول من خارج المكتب
// عبر Tailscale Funnel الذي يمرّر اتصال HTTPS المشفّر إلى هذا المنفذ).
// - /             واجهة البرنامج نفسها للرابط الآمن (الآيفون)
// - /api/web/*    دخول الرابط الآمن: كلمة المرور، ورمز البريد للجهاز الجديد ثم كل 15 يومًا
// - /api/dispatch أوامر البرنامج نفسها بصلاحيات المستخدم (عدا أوامر سطح المكتب)
// - /api/link/*   ربط جهاز صاحب المكتب (الماك) للمزامنة
// - /api/sync/*   المزامنة (محرك المزامنة نفسه)، /api/blob/* الملفات بروابط موقعة قصيرة الأجل
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppCore } from '../main/core';
import { attachmentPath } from '../main/paths';
import * as authSvc from '../main/services/auth';
import { HubStore, hubGet, hubSet } from './store';
import { RateLimiter, createDevice, deviceByToken, issueCode, renewTrust, touchDevice, verifyCode, type Mailer } from './auth';

export interface HubDeps {
  core: AppCore;
  store: HubStore;
  mailer: Mailer;
  webDir: string | null;
  now?: () => Date;
  officeName?: () => string;
}

const COOKIE = 'lo_dev';
const MAX_JSON = 60 * 1024 * 1024; // المرفقات حتى ~40MB بترميز base64
const BLOB_TTL = 300;
// أوامر تعمل على جهاز المكتب نفسه (نوافذ حوار، فتح ملفات، نسخ احتياطي، ربط) — غير متاحة عبر الرابط
// الدخول نفسه عبر الرابط يمر بمسار /api/web/login (كلمة المرور + رمز البريد)، فلا تُقبل أوامر الدخول والاستعادة هنا
const WEB_DENY = /^(system|backup|integration|cloud|hub)\.|^auth\.(setupOwner|login|recover|regenerateRecoveryCode)$|^documents\.(pickFile|open|showInFolder|export)$|^reports\.(print|savePdf|officeExport)$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** ترميز الحقول الثنائية في JSON (المرفقات): Uint8Array ⇄ {"__b64": "..."} */
export function encodeBytes(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encodeBytes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, encodeBytes(x)]));
  return v;
}
export function decodeBytes(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { __b64?: unknown }).__b64 === 'string' && Object.keys(v).length === 1) return new Uint8Array(Buffer.from((v as { __b64: string }).__b64, 'base64'));
  if (Array.isArray(v)) return v.map(decodeBytes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, decodeBytes(x)]));
  return v;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
  ) {
    super(message);
  }
}

function cookieOf(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, 'الحجم أكبر من المسموح');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBody(req, MAX_JSON);
  try {
    const v = JSON.parse(b.toString('utf8') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'طلب غير صالح');
  }
}

export function createHubServer(d: HubDeps): http.Server {
  const now = d.now ?? (() => new Date());
  const core = d.core;
  const db = () => core.db;
  const limiter = new RateLimiter();
  let blobSecret = hubGet(db(), 'blob_secret');
  if (!blobSecret) {
    blobSecret = randomBytes(32).toString('base64url');
    hubSet(db(), 'blob_secret', blobSecret);
  }
  const sign = (method: string, vid: string, exp: number) => createHmac('sha256', blobSecret!).update(`${method}|${vid}|${exp}`).digest('base64url');
  const checkSig = (method: string, vid: string, exp: string | null, sig: string | null) => {
    if (!exp || !sig || Number(exp) < Math.floor(now().getTime() / 1000)) return false;
    const a = Buffer.from(sign(method, vid, Number(exp)));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** يتحقق من كلمة المرور بقواعد البرنامج نفسها (الإيقاف المؤقت بعد المحاولات الخاطئة). */
  async function checkPassword(username: string, password: string): Promise<{ userId: string; role: string }> {
    const tmp = `hub-check-${randomBytes(8).toString('hex')}`;
    const r = await core.dispatch(tmp, 'auth.login', { username, password });
    const s = core.sessions.get(tmp);
    core.sessions.delete(tmp);
    if (!r.ok || !s) throw new HttpError(401, r.ok ? 'تعذر الدخول' : r.error.message, r.ok ? 'ERROR' : r.error.code);
    const u = authSvc.loadSessionUser(core.systemCtx(), s.userId);
    if (!u) throw new HttpError(401, 'الحساب غير نشط');
    return { userId: u.id, role: u.role };
  }

  function startWebSession(deviceId: string, userId: string) {
    core.sessions.set(`web-${deviceId}`, { userId, lastActivity: now().getTime(), locked: false, dirty: false });
  }

  function setCookie(res: http.ServerResponse, token: string) {
    // صالح 15 يومًا بعد آخر تحقق برمز؛ HttpOnly فلا تقرؤه الصفحة، وSecure (الرابط عبر HTTPS)
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${15 * 86400}`);
  }

  function webDevice(req: http.IncomingMessage) {
    const dev = deviceByToken(db(), now(), cookieOf(req, COOKIE));
    return dev && dev.kind === 'web' ? dev : null;
  }

  function syncDevice(req: http.IncomingMessage) {
    const h = String(req.headers.authorization ?? '');
    const dev = deviceByToken(db(), now(), h.startsWith('Bearer ') ? h.slice(7) : null);
    if (!dev || dev.kind !== 'sync') throw new HttpError(401, 'جهاز غير مرتبط أو أُلغي ربطه', 'REVOKED');
    const u = authSvc.loadSessionUser(core.systemCtx(), dev.user_id);
    if (!u || u.role !== 'owner') throw new HttpError(401, 'الحساب غير نشط', 'REVOKED');
    touchDevice(db(), now(), dev.id);
    return dev;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://hub');
    const p = url.pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // ———— دخول الرابط الآمن ————
    if (p === '/api/web/login' && req.method === 'POST') {
      if (!limiter.allow(`login:${clientIp(req)}`)) throw new HttpError(429, 'محاولات كثيرة. انتظر ربع ساعة ثم أعد المحاولة.');
      const b = await readJson(req);
      const { userId } = await checkPassword(String(b.username ?? ''), String(b.password ?? ''));
      const known = webDevice(req);
      if (known && known.user_id === userId && known.trusted) {
        touchDevice(db(), now(), known.id);
        startWebSession(known.id, userId);
        return json(200, { ok: true });
      }
      try {
        const c = await issueCode(db(), d.mailer, now(), userId, 'web', { deviceName: String(b.deviceName ?? 'متصفح').slice(0, 80), known: known?.user_id === userId ? known.id : null });
        return json(200, { codeRequired: true, ...c });
      } catch (e) {
        const m = (e as Error).message;
        if (m === 'NO_EMAIL') throw new HttpError(409, 'لم يُضبط بريد إلكتروني لهذا المستخدم لاستقبال رمز التحقق. يضبطه صاحب المكتب من جهاز المكتب.');
        if (m === 'TOO_MANY_CODES') throw new HttpError(429, 'طُلبت رموز كثيرة. انتظر ربع ساعة.');
        throw new HttpError(502, 'تعذر إرسال رمز التحقق بالبريد. تحقق من إعداد البريد على جهاز المكتب.');
      }
    }
    if (p === '/api/web/verify' && req.method === 'POST') {
      if (!limiter.allow(`verify:${clientIp(req)}`)) throw new HttpError(429, 'محاولات كثيرة. انتظر ربع ساعة.');
      const b = await readJson(req);
      let v;
      try {
        v = verifyCode(db(), now(), String(b.challengeId ?? ''), String(b.code ?? ''), 'web');
      } catch (e) {
        throw new HttpError(401, (e as Error).message);
      }
      const known = typeof v.meta.known === 'string' ? (v.meta.known as string) : null;
      let deviceId: string;
      if (known && webDevice(req)?.id === known) {
        renewTrust(db(), now(), known);
        deviceId = known;
      } else {
        const dev = createDevice(db(), now(), v.userId, 'web', String(v.meta.deviceName ?? 'متصفح'), 'web');
        setCookie(res, dev.token);
        deviceId = dev.id;
      }
      startWebSession(deviceId, v.userId);
      return json(200, { ok: true });
    }
    if (p === '/api/web/state' && req.method === 'GET') {
      const dev = webDevice(req);
      return json(200, { device: !!dev, session: !!(dev && core.sessions.get(`web-${dev.id}`)), officeName: d.officeName?.() ?? '' });
    }
    if (p === '/api/dispatch' && req.method === 'POST') {
      const dev = webDevice(req);
      // جهاز انتهت مدة إعفائه (15 يومًا) أو لا جلسة له: يعود لشاشة الدخول (كلمة المرور، والرمز عند الحاجة)
      if (!dev || !dev.trusted || !core.sessions.get(`web-${dev.id}`)) return json(200, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'سجّل الدخول من جديد.' } });
      const b = await readJson(req);
      const channel = String(b.channel ?? '');
      if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(channel)) throw new HttpError(400, 'قناة غير مسموحة');
      if (WEB_DENY.test(channel)) return json(200, { ok: false, error: { code: 'UNSUPPORTED', message: 'هذه العملية متاحة على جهاز المكتب والماك فقط.' } });
      touchDevice(db(), now(), dev.id);
      const r = await core.dispatch(`web-${dev.id}`, channel, decodeBytes(b.payload ?? {}));
      if (channel === 'auth.logout') core.sessions.delete(`web-${dev.id}`);
      return json(200, encodeBytes(r));
    }
    const fileM = p.match(/^\/api\/file\/([0-9a-f-]{36})$/);
    if (fileM && req.method === 'GET') {
      const dev = webDevice(req);
      if (!dev || !dev.trusted || !core.sessions.get(`web-${dev.id}`)) throw new HttpError(401, 'سجّل الدخول من جديد.');
      const r = await core.dispatch(`web-${dev.id}`, 'documents.readBytes', { versionId: fileM[1] });
      if (!r.ok) throw new HttpError(403, r.error.message);
      const f = r.data as { bytes: Uint8Array; mime: string; name: string };
      res.writeHead(200, {
        'content-type': f.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'cache-control': 'no-store',
      });
      return res.end(Buffer.from(f.bytes));
    }

    // ———— ربط جهاز صاحب المكتب للمزامنة ————
    if (p === '/api/link/start' && req.method === 'POST') {
      if (!limiter.allow(`link:${clientIp(req)}`)) throw new HttpError(429, 'محاولات كثيرة. انتظر ربع ساعة.');
      const b = await readJson(req);
      const u = await checkPassword(String(b.username ?? ''), String(b.password ?? ''));
      if (u.role !== 'owner') throw new HttpError(403, 'ربط جهاز للمزامنة متاح لحساب صاحب المكتب. يمكن للمستشار استخدام الرابط الآمن.');
      try {
        const c = await issueCode(db(), d.mailer, now(), u.userId, 'link', { deviceName: String(b.deviceName ?? 'جهاز').slice(0, 80), platform: String(b.platform ?? '').slice(0, 20) });
        return json(200, c);
      } catch (e) {
        const m = (e as Error).message;
        if (m === 'NO_EMAIL') throw new HttpError(409, 'لم يُضبط بريد إلكتروني لصاحب المكتب على جهاز المكتب.');
        if (m === 'TOO_MANY_CODES') throw new HttpError(429, 'طُلبت رموز كثيرة. انتظر ربع ساعة.');
        throw new HttpError(502, 'تعذر إرسال رمز التحقق بالبريد.');
      }
    }
    if (p === '/api/link/verify' && req.method === 'POST') {
      if (!limiter.allow(`verify:${clientIp(req)}`)) throw new HttpError(429, 'محاولات كثيرة. انتظر ربع ساعة.');
      const b = await readJson(req);
      let v;
      try {
        v = verifyCode(db(), now(), String(b.challengeId ?? ''), String(b.code ?? ''), 'link');
      } catch (e) {
        throw new HttpError(401, (e as Error).message);
      }
      const dev = createDevice(db(), now(), v.userId, 'sync', String(v.meta.deviceName ?? 'جهاز'), String(v.meta.platform ?? ''));
      return json(200, { token: dev.token, deviceId: dev.id, officeId: d.store.officeId(), officeName: d.officeName?.() ?? '', localUserId: v.userId });
    }

    // ———— المزامنة ————
    if (p.startsWith('/api/sync/') && req.method === 'POST') {
      const dev = syncDevice(req);
      const b = await readJson(req);
      if (p === '/api/sync/status') return json(200, d.store.status(dev.user_id, now()));
      if (p === '/api/sync/pull') return json(200, d.store.pull(Number(b.since ?? 0), Number(b.limit ?? 500)));
      if (p === '/api/sync/push') return json(200, d.store.push(Array.isArray(b.changes) ? (b.changes as never) : [], now()));
      if (p === '/api/sync/reserve') {
        try {
          return json(200, d.store.reserveNumbers(String(b.name ?? ''), Number(b.count ?? 25)));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (p === '/api/sync/devices') return json(200, db().all('SELECT id, kind, name, platform, created_at, last_seen, revoked_at FROM hub_devices ORDER BY last_seen DESC'));
      throw new HttpError(404, 'غير موجود');
    }
    if (p === '/api/blobs' && req.method === 'POST') {
      syncDevice(req);
      const b = await readJson(req);
      const vid = String(b.version_id ?? '');
      const v = db().get<{ stored_name: string; sha256: string; size: number }>('SELECT stored_name, sha256, size FROM document_versions WHERE id = ?', [vid]);
      if (!v) return json(422, { error: 'السجل لم يصل بعد' });
      const file = attachmentPath(core.paths, v.stored_name);
      const have = fs.existsSync(file) && fs.statSync(file).size === v.size;
      const exp = Math.floor(now().getTime() / 1000) + BLOB_TTL;
      if (b.action === 'upload-url') {
        if (String(b.sha256) !== v.sha256 || Number(b.size) !== v.size) return json(422, { error: 'بيانات الملف لا تطابق سجله' });
        if (have) return json(200, { status: 'verified' });
        return json(200, { url: `/api/blob/put/${vid}?exp=${exp}&sig=${sign('PUT', vid, exp)}`, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (b.action === 'complete') return json(have ? 200 : 409, { status: have ? 'verified' : 'missing' });
      if (b.action === 'download-url') {
        if (!have) return json(409, { error: 'الملف غير موجود على جهاز المكتب بعد' });
        return json(200, { url: `/api/blob/get/${vid}?exp=${exp}&sig=${sign('GET', vid, exp)}` });
      }
      throw new HttpError(400, 'إجراء غير معروف');
    }
    const blobM = p.match(/^\/api\/blob\/(put|get)\/([0-9a-f-]{36})$/);
    if (blobM) {
      const [, op, vid] = blobM;
      const method = op === 'put' ? 'PUT' : 'GET';
      if (req.method !== method || !checkSig(method, vid, url.searchParams.get('exp'), url.searchParams.get('sig'))) throw new HttpError(403, 'رابط منتهي أو غير صالح');
      const v = db().get<{ stored_name: string; sha256: string; size: number }>('SELECT stored_name, sha256, size FROM document_versions WHERE id = ?', [vid]);
      if (!v) throw new HttpError(404, 'غير موجود');
      const file = attachmentPath(core.paths, v.stored_name);
      if (op === 'get') {
        if (!fs.existsSync(file)) throw new HttpError(404, 'غير موجود');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': String(v.size) });
        return fs.createReadStream(file).pipe(res);
      }
      const body = await readBody(req, v.size + 1);
      // لا يُقبل ملف لا يطابق حجم سجله وبصمته
      if (body.length !== v.size || createHash('sha256').update(body).digest('hex') !== v.sha256) throw new HttpError(422, 'الملف لا يطابق بصمة سجله');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(`${file}.part`, body);
        fs.renameSync(`${file}.part`, file);
      }
      res.writeHead(200);
      return res.end();
    }

    // ———— واجهة الرابط الآمن (ملفات ثابتة) ————
    if (req.method === 'GET' && d.webDir && !p.startsWith('/api/')) {
      const rel = decodeURIComponent(p).replace(/^\/+/, '');
      const full = path.resolve(d.webDir, rel || 'index.html');
      const inside = full.startsWith(path.resolve(d.webDir) + path.sep) || full === path.resolve(d.webDir, 'index.html');
      const file = inside && fs.existsSync(full) && fs.statSync(full).isFile() ? full : path.join(d.webDir, 'index.html');
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    throw new HttpError(404, 'غير موجود');
  }

  return http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'خطأ داخلي في خادم المكتب', code: e instanceof HttpError ? e.code : 'INTERNAL' }));
    });
  });
}
