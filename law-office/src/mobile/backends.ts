// مخازن الملفات الدائمة لنسخة الآيفون:
// - CapacitorBackend: ملفات التطبيق في Library/NoCloud (خارج نسخ iCloud الاحتياطية للجهاز، ومحمية بتشفير بيانات iOS).
// - IdbBackend: IndexedDB — لاختبار النسخة نفسها في متصفح فقط، وليس للاستخدام الفعلي.
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Buffer } from 'buffer';
import type { Backend } from './shims/vfs';

const ROOT = 'lawoffice';
const rel = (p: string) => `${ROOT}${p}`;

export class CapacitorBackend implements Backend {
  private dir = Directory.LibraryNoCloud;

  async list() {
    const out: { path: string; dir: boolean; size: number; mtime: number }[] = [];
    const walk = async (p: string) => {
      let r;
      try {
        r = await Filesystem.readdir({ path: rel(p), directory: this.dir });
      } catch {
        return;
      }
      for (const f of r.files) {
        const child = `${p === '/' ? '' : p}/${f.name}`;
        if (f.type === 'directory') {
          out.push({ path: child, dir: true, size: 0, mtime: Number(f.mtime ?? 0) });
          await walk(child);
        } else out.push({ path: child, dir: false, size: Number(f.size ?? 0), mtime: Number(f.mtime ?? 0) });
      }
    };
    await Filesystem.mkdir({ path: ROOT, directory: this.dir, recursive: true }).catch(() => undefined);
    await walk('/');
    return out;
  }
  async read(p: string) {
    const r = await Filesystem.readFile({ path: rel(p), directory: this.dir });
    return typeof r.data === 'string' ? new Uint8Array(Buffer.from(r.data, 'base64')) : new Uint8Array(await (r.data as Blob).arrayBuffer());
  }
  async write(p: string, data: Uint8Array) {
    // كتابة ذرية: ملف مؤقت ثم إعادة تسمية
    const tmp = `${rel(p)}.part`;
    await Filesystem.writeFile({ path: tmp, directory: this.dir, data: Buffer.from(data).toString('base64'), recursive: true });
    await Filesystem.deleteFile({ path: rel(p), directory: this.dir }).catch(() => undefined);
    await Filesystem.rename({ from: tmp, to: rel(p), directory: this.dir, toDirectory: this.dir });
  }
  async remove(p: string) {
    await Filesystem.deleteFile({ path: rel(p), directory: this.dir }).catch(() => undefined);
  }
  async rmdir(p: string) {
    await Filesystem.rmdir({ path: rel(p), directory: this.dir, recursive: true }).catch(() => undefined);
  }
  async mkdir(p: string) {
    await Filesystem.mkdir({ path: rel(p), directory: this.dir, recursive: true }).catch(() => undefined);
  }
  async rename(a: string, b: string) {
    await Filesystem.rename({ from: rel(a), to: rel(b), directory: this.dir, toDirectory: this.dir });
  }
  /** رابط ملف حقيقي على الجهاز (للمشاركة/الفتح بتطبيق آخر). */
  async uri(p: string) {
    return (await Filesystem.getUri({ path: rel(p), directory: this.dir })).uri;
  }
}

export class IdbBackend implements Backend {
  private db: Promise<IDBDatabase>;
  constructor(name = 'lawoffice-test-fs') {
    this.db = new Promise((ok, bad) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('f');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await this.db;
    return new Promise((ok, bad) => {
      const t = db.transaction('f', mode);
      const req = fn(t.objectStore('f'));
      t.oncomplete = () => ok(req ? (req.result as T) : (undefined as T));
      t.onerror = () => bad(t.error);
    });
  }
  async list() {
    const keys = (await this.tx('readonly', (s) => s.getAllKeys())) as string[];
    const out: { path: string; dir: boolean; size: number; mtime: number }[] = [];
    for (const k of keys) {
      if (k.startsWith('d:')) out.push({ path: k.slice(2), dir: true, size: 0, mtime: 0 });
      else {
        const v = (await this.tx('readonly', (s) => s.get(k))) as Uint8Array;
        out.push({ path: k.slice(2), dir: false, size: v.byteLength, mtime: 0 });
      }
    }
    return out;
  }
  async read(p: string) {
    const v = (await this.tx('readonly', (s) => s.get(`f:${p}`))) as Uint8Array | undefined;
    if (!v) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async write(p: string, data: Uint8Array) {
    await this.tx('readwrite', (s) => void s.put(data, `f:${p}`));
  }
  async remove(p: string) {
    await this.tx('readwrite', (s) => void s.delete(`f:${p}`));
  }
  async rmdir(p: string) {
    const keys = (await this.tx('readonly', (s) => s.getAllKeys())) as string[];
    await this.tx('readwrite', (s) => {
      for (const k of keys) if (k.slice(2) === p || k.slice(2).startsWith(p + '/')) s.delete(k);
    });
  }
  async mkdir(p: string) {
    await this.tx('readwrite', (s) => void s.put(new Uint8Array(0), `d:${p}`));
  }
  async rename(a: string, b: string) {
    const keys = (await this.tx('readonly', (s) => s.getAllKeys())) as string[];
    for (const k of keys) {
      const p = k.slice(2);
      if (p !== a && !p.startsWith(a + '/')) continue;
      const v = await this.tx('readonly', (s) => s.get(k));
      await this.tx('readwrite', (s) => {
        s.delete(k);
        s.put(v, k.slice(0, 2) + b + p.slice(a.length));
      });
    }
  }
}
