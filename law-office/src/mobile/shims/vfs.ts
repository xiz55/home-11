// نظام ملفات افتراضي متزامن (بديل node:fs على الآيفون) فوق مخزن دائم غير متزامن (ملفات التطبيق عبر Capacitor).
// - العمليات المتزامنة تعدّل نسخة في الذاكرة، ثم تُكتب إلى المخزن الدائم بالترتيب في طابور (flush ينتظر اكتمالها).
// - الملفات الصغيرة (قاعدة البيانات والإعدادات) تُحمّل عند بدء التطبيق؛ الملفات الكبيرة (المرفقات والنسخ والتصدير)
//   تُعرف بحجمها فقط وتُحمّل عند الطلب (load) ثم تُفرّغ من الذاكرة بعد حفظها.
import { Buffer } from 'buffer';

export interface Backend {
  list(): Promise<{ path: string; dir: boolean; size: number; mtime: number }[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

interface FileNode {
  size: number;
  mtime: number;
  data: Uint8Array | null; // null = غير محمّل في الذاكرة (موجود في المخزن الدائم)
}

const files = new Map<string, FileNode>();
const dirs = new Set<string>(['/']);
let backend: Backend | null = null;
let chain: Promise<void> = Promise.resolve();
let lazy: (p: string) => boolean = () => false;
export let lastPersistError: string | null = null;
const writeListeners = new Set<(p: string) => void>();

const norm = (p: string) => {
  const parts: string[] = [];
  for (const s of String(p).replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return '/' + parts.join('/');
};
const parent = (p: string) => (p === '/' ? '/' : norm(p.slice(0, p.lastIndexOf('/')) || '/'));
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function err(code: string, msg: string, p: string): Error {
  return Object.assign(new Error(`${code}: ${msg}, '${p}'`), { code, path: p });
}

function persist(op: () => Promise<void>) {
  chain = chain.then(op).catch((e) => {
    lastPersistError = String((e as Error)?.message ?? e);
  });
}

/** يُستدعى مرة عند بدء التطبيق: يقرأ شجرة الملفات، ويحمّل الملفات الصغيرة فقط. */
export async function mountVfs(b: Backend, opts: { isLazy: (p: string) => boolean }) {
  backend = b;
  lazy = (p) => opts.isLazy(norm(p));
  files.clear();
  dirs.clear();
  dirs.add('/');
  for (const e of await b.list()) {
    const p = norm(e.path);
    if (e.dir) {
      addDirs(p);
      continue;
    }
    addDirs(parent(p));
    files.set(p, { size: e.size, mtime: e.mtime, data: lazy(p) ? null : await b.read(p) });
  }
}

/** انتظار اكتمال كل الكتابات المعلقة (قبل انتقال التطبيق للخلفية، وبعد التصدير). */
export function flushVfs(): Promise<void> {
  return chain;
}

/** تحميل محتوى ملف كبير إلى الذاكرة قبل قراءته بشكل متزامن. */
export async function loadFile(p: string): Promise<void> {
  const n = files.get(norm(p));
  if (!n || n.data) return;
  await chain;
  n.data = await backend!.read(norm(p));
}

/** تفريغ محتوى ملف كبير من الذاكرة (يبقى في المخزن الدائم). */
export function unloadFile(p: string) {
  const k = norm(p);
  const n = files.get(k);
  if (n && n.data && lazy(k)) n.data = null;
}

export function onFileWritten(cb: (p: string) => void) {
  writeListeners.add(cb);
  return () => writeListeners.delete(cb);
}

function addDirs(p: string) {
  const chain: string[] = [];
  for (let d = norm(p); !dirs.has(d); d = parent(d)) chain.push(d);
  for (const d of chain.reverse()) dirs.add(d);
}

function bytesOf(data: unknown, enc?: string): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, (enc as BufferEncoding) ?? 'utf8'));
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new TypeError('unsupported data');
}

function contentOf(p: string): Uint8Array {
  const n = files.get(p);
  if (!n) throw err('ENOENT', 'no such file or directory', p);
  if (!n.data) throw err('EAGAIN', 'file content not loaded (call loadFile first)', p);
  return n.data;
}

function putFile(p: string, data: Uint8Array, opts: { exclusive?: boolean } = {}) {
  if (opts.exclusive && files.has(p)) throw err('EEXIST', 'file already exists', p);
  if (!dirs.has(parent(p))) throw err('ENOENT', 'no such file or directory', p);
  if (dirs.has(p)) throw err('EISDIR', 'illegal operation on a directory', p);
  files.set(p, { size: data.byteLength, mtime: Date.now(), data });
  const copy = data;
  persist(async () => {
    await backend!.write(p, copy);
    // الملفات الكبيرة تُفرّغ من الذاكرة بعد حفظها
    const n = files.get(p);
    if (n && n.data === copy && lazy(p)) n.data = null;
    for (const l of writeListeners) l(p);
  });
}

class Stats {
  constructor(
    private kind: 'file' | 'dir',
    readonly size: number,
    readonly mtimeMs: number,
  ) {}
  get mtime() {
    return new Date(this.mtimeMs);
  }
  get birthtime() {
    return new Date(this.mtimeMs);
  }
  isFile() {
    return this.kind === 'file';
  }
  isDirectory() {
    return this.kind === 'dir';
  }
  isSymbolicLink() {
    return false;
  }
}

class Dirent {
  constructor(
    readonly name: string,
    private dir: boolean,
  ) {}
  isFile() {
    return !this.dir;
  }
  isDirectory() {
    return this.dir;
  }
}

export function existsSync(p: string) {
  const k = norm(p);
  return files.has(k) || dirs.has(k);
}

export function statSync(p: string, opts?: { throwIfNoEntry?: boolean }) {
  const k = norm(p);
  const f = files.get(k);
  if (f) return new Stats('file', f.size, f.mtime);
  if (dirs.has(k)) return new Stats('dir', 0, 0);
  if (opts?.throwIfNoEntry === false) return undefined;
  throw err('ENOENT', 'no such file or directory', k);
}
export const lstatSync = statSync;

export function mkdirSync(p: string, opts?: { recursive?: boolean }) {
  const k = norm(p);
  if (dirs.has(k)) {
    if (opts?.recursive) return undefined;
    throw err('EEXIST', 'file already exists', k);
  }
  if (!opts?.recursive && !dirs.has(parent(k))) throw err('ENOENT', 'no such file or directory', k);
  addDirs(k);
  persist(() => backend!.mkdir(k));
  return k;
}

export function readdirSync(p: string, opts?: { withFileTypes?: boolean }) {
  const k = norm(p);
  if (!dirs.has(k)) throw err('ENOENT', 'no such file or directory', k);
  const prefix = k === '/' ? '/' : k + '/';
  const names = new Map<string, boolean>();
  for (const d of dirs) if (d !== k && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) names.set(d.slice(prefix.length), true);
  for (const f of files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) names.set(f.slice(prefix.length), false);
  const sorted = [...names.keys()].sort();
  return opts?.withFileTypes ? sorted.map((n) => new Dirent(n, names.get(n)!)) : sorted;
}

export function readFileSync(p: string, opts?: string | { encoding?: string }) {
  const k = norm(p);
  const data = contentOf(k);
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return enc ? b.toString(enc as BufferEncoding) : Buffer.from(b);
}

export function writeFileSync(p: string, data: unknown, opts?: string | { encoding?: string; flag?: string; mode?: number }) {
  const enc = typeof opts === 'string' ? opts : opts?.encoding;
  const flag = typeof opts === 'object' ? opts?.flag : undefined;
  putFile(norm(p), bytesOf(data, enc), { exclusive: flag === 'wx' });
}

export function appendFileSync(p: string, data: unknown) {
  const k = norm(p);
  const add = bytesOf(data);
  const prev = files.has(k) ? contentOf(k) : new Uint8Array(0);
  const out = new Uint8Array(prev.byteLength + add.byteLength);
  out.set(prev);
  out.set(add, prev.byteLength);
  putFile(k, out);
}

export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }) {
  const k = norm(p);
  if (files.has(k)) {
    files.delete(k);
    persist(() => backend!.remove(k));
    return;
  }
  if (dirs.has(k)) {
    const prefix = k + '/';
    const inside = [...files.keys()].some((f) => f.startsWith(prefix)) || [...dirs].some((d) => d.startsWith(prefix));
    if (inside && !opts?.recursive) throw err('ENOTEMPTY', 'directory not empty', k);
    for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
    for (const d of [...dirs]) if (d === k || d.startsWith(prefix)) dirs.delete(d);
    persist(() => backend!.rmdir(k));
    return;
  }
  if (!opts?.force) throw err('ENOENT', 'no such file or directory', k);
}
export function unlinkSync(p: string) {
  const k = norm(p);
  if (!files.has(k)) throw err('ENOENT', 'no such file or directory', k);
  rmSync(k);
}
export function rmdirSync(p: string, opts?: { recursive?: boolean }) {
  rmSync(p, { recursive: opts?.recursive });
}

export function renameSync(a: string, b: string) {
  const from = norm(a);
  const to = norm(b);
  if (files.has(from)) {
    if (!dirs.has(parent(to))) throw err('ENOENT', 'no such file or directory', to);
    files.set(to, files.get(from)!);
    files.delete(from);
    persist(() => backend!.rename(from, to));
    return;
  }
  if (dirs.has(from)) {
    const prefix = from + '/';
    for (const [f, n] of [...files]) if (f.startsWith(prefix)) {
      files.delete(f);
      files.set(to + f.slice(from.length), n);
    }
    for (const d of [...dirs]) if (d === from || d.startsWith(prefix)) {
      dirs.delete(d);
      dirs.add(to + d.slice(from.length));
    }
    addDirs(parent(to));
    persist(() => backend!.rename(from, to));
    return;
  }
  throw err('ENOENT', 'no such file or directory', from);
}

export function copyFileSync(a: string, b: string, flags = 0) {
  const to = norm(b);
  if (flags & constants.COPYFILE_EXCL && files.has(to)) throw err('EEXIST', 'file already exists', to);
  putFile(to, new Uint8Array(contentOf(norm(a))));
}

export function chmodSync() {}
export function statfsSync(): never {
  throw err('ENOSYS', 'statfs not available', '/');
}

// ———— واصفات الملفات (للنسخ والتحقق من التوقيع) ————
const fds = new Map<number, { path: string; buf: Uint8Array; dirty: boolean; pos: number }>();
let nextFd = 100;

export function openSync(p: string, flags = 'r') {
  const k = norm(p);
  let buf: Uint8Array;
  if (flags.startsWith('w')) {
    if (flags === 'wx' && files.has(k)) throw err('EEXIST', 'file already exists', k);
    if (!dirs.has(parent(k))) throw err('ENOENT', 'no such file or directory', k);
    buf = new Uint8Array(0);
  } else buf = contentOf(k);
  const fd = nextFd++;
  fds.set(fd, { path: k, buf, dirty: flags.startsWith('w'), pos: 0 });
  return fd;
}

export function readSync(fd: number, target: Uint8Array, offset: number, length: number, position: number | null) {
  const f = fds.get(fd);
  if (!f) throw err('EBADF', 'bad file descriptor', String(fd));
  const start = position ?? f.pos;
  const n = Math.max(0, Math.min(length, f.buf.byteLength - start));
  target.set(f.buf.subarray(start, start + n), offset);
  if (position === null || position === undefined) f.pos = start + n;
  return n;
}

export function writeSync(fd: number, data: Uint8Array | string) {
  const f = fds.get(fd);
  if (!f) throw err('EBADF', 'bad file descriptor', String(fd));
  const add = bytesOf(data);
  const out = new Uint8Array(f.buf.byteLength + add.byteLength);
  out.set(f.buf);
  out.set(add, f.buf.byteLength);
  f.buf = out;
  f.dirty = true;
  return add.byteLength;
}

export function fsyncSync(fd: number) {
  const f = fds.get(fd);
  if (f?.dirty) {
    putFile(f.path, f.buf);
    f.dirty = false;
  }
}

export function closeSync(fd: number) {
  fsyncSync(fd);
  fds.delete(fd);
}

// ———— تدفقات مبسطة (تكفي لنسخ ملف إلى مستودع البرنامج) ————
type Handler = (...a: unknown[]) => void;
class Emitter {
  private h = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) {
    this.h.set(ev, [...(this.h.get(ev) ?? []), fn]);
    return this;
  }
  once(ev: string, fn: Handler) {
    const w: Handler = (...a) => {
      this.h.set(ev, (this.h.get(ev) ?? []).filter((x) => x !== w));
      fn(...a);
    };
    return this.on(ev, w);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of this.h.get(ev) ?? []) fn(...a);
    return true;
  }
}

export class WriteStream extends Emitter {
  private parts: Uint8Array[] = [];
  bytesWritten = 0;
  constructor(
    readonly path: string,
    private opts: { flags?: string } = {},
  ) {
    super();
    const k = norm(path);
    if (opts.flags === 'wx' && files.has(k)) queueMicrotask(() => this.emit('error', err('EEXIST', 'file already exists', k)));
  }
  write(chunk: Uint8Array | string, cb?: () => void) {
    const b = bytesOf(chunk);
    this.parts.push(b);
    this.bytesWritten += b.byteLength;
    cb?.();
    return true;
  }
  end(chunk?: Uint8Array | string, cb?: () => void) {
    if (chunk) this.write(chunk);
    try {
      const out = new Uint8Array(this.bytesWritten);
      let o = 0;
      for (const p of this.parts) {
        out.set(p, o);
        o += p.byteLength;
      }
      putFile(norm(this.path), out, { exclusive: this.opts.flags === 'wx' });
      queueMicrotask(() => {
        this.emit('finish');
        this.emit('close');
        cb?.();
      });
    } catch (e) {
      queueMicrotask(() => this.emit('error', e));
    }
    return this;
  }
  destroy() {
    this.parts = [];
    return this;
  }
  close(cb?: () => void) {
    cb?.();
  }
}

export class ReadStream extends Emitter {
  constructor(readonly path: string) {
    super();
    queueMicrotask(() => this.start());
  }
  private dest: WriteStream | null = null;
  private start() {
    try {
      const data = Buffer.from(contentOf(norm(this.path)));
      const CH = 1 << 20;
      for (let i = 0; i < data.byteLength; i += CH) {
        const c = data.subarray(i, i + CH);
        this.emit('data', c);
        this.dest?.write(c);
      }
      this.emit('end');
      this.emit('close');
      this.dest?.end();
    } catch (e) {
      this.emit('error', e);
    }
  }
  pipe(dest: WriteStream) {
    this.dest = dest;
    return dest;
  }
  destroy() {
    return this;
  }
}

export function createWriteStream(p: string, opts?: { flags?: string }) {
  return new WriteStream(p, opts);
}
export function createReadStream(p: string) {
  return new ReadStream(p);
}

export const constants = { COPYFILE_EXCL: 1, F_OK: 0, R_OK: 4, W_OK: 2 };

export const promises = {
  async readFile(p: string, opts?: string | { encoding?: string }) {
    await loadFile(p);
    return readFileSync(p, opts);
  },
  async writeFile(p: string, data: unknown) {
    writeFileSync(p, data);
  },
  async rm(p: string, opts?: { recursive?: boolean; force?: boolean }) {
    rmSync(p, opts);
  },
  async mkdir(p: string, opts?: { recursive?: boolean }) {
    return mkdirSync(p, opts);
  },
  async stat(p: string) {
    return statSync(p);
  },
  async readdir(p: string) {
    return readdirSync(p);
  },
  async rename(a: string, b: string) {
    renameSync(a, b);
  },
  async copyFile(a: string, b: string) {
    await loadFile(a);
    copyFileSync(a, b);
  },
};

export { Stats, base as _basename };

const fs = {
  existsSync, statSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, unlinkSync, rmdirSync,
  renameSync, copyFileSync, chmodSync, statfsSync, openSync, readSync, writeSync, fsyncSync, closeSync, createWriteStream, createReadStream,
  constants, promises, Stats, WriteStream, ReadStream,
};
export default fs;
