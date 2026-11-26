// مزامنة ملفات المرفقات: رفع النسخ المحلية إلى المخزن الخاص بروابط مؤقتة، وتنزيلها عند الطلب أو مسبقًا.
// لا تُعلَّم «مكتملة» قبل أن يتحقق الخادم من حجمها وبصمتها. الحالة دائمة في sync_blobs وتستأنف بعد إعادة التشغيل.
import type { Db } from '../main/db/db';
import { getState } from './local';

export interface BlobApi {
  call(req: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** مخزن الملفات المحلي (مجلد المرفقات على سطح المكتب، أو مجلد التطبيق على الآيفون). */
export interface BlobStore {
  has(storedName: string): boolean;
  read(storedName: string): Uint8Array | Promise<Uint8Array>;
  write(storedName: string, bytes: Uint8Array): void | Promise<void>;
  remove?(storedName: string): void | Promise<void>;
}

export type BlobState = 'pending_upload' | 'uploading' | 'uploaded' | 'remote' | 'downloading' | 'local' | 'failed';

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

interface VersionRow {
  id: string;
  stored_name: string;
  sha256: string;
  size: number;
  ext: string;
}

export class BlobSync {
  constructor(
    private db: () => Db,
    private api: BlobApi,
    private store: BlobStore,
    private fetchImpl: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {}

  private officeId() {
    const o = getState(this.db(), 'office_id');
    if (!o) throw new Error('sync not configured');
    return o;
  }

  private set(versionId: string, state: BlobState, extra: { error?: string | null; incAttempt?: boolean } = {}) {
    this.db().run(
      `INSERT INTO sync_blobs (version_id, state, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET state = excluded.state, attempts = sync_blobs.attempts + ?, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [versionId, state, extra.incAttempt ? 1 : 0, extra.error ?? null, this.now().toISOString(), extra.incAttempt ? 1 : 0],
    );
  }

  state(versionId: string): { state: BlobState; pinned: boolean; lastError: string | null } | null {
    const r = this.db().get<{ state: BlobState; pinned: number; last_error: string | null }>('SELECT state, pinned, last_error FROM sync_blobs WHERE version_id = ?', [versionId]);
    return r ? { state: r.state, pinned: !!r.pinned, lastError: r.last_error } : null;
  }

  /** يصنف النسخ الجديدة: الملف موجود محليًا ← بانتظار الرفع؛ غير موجود ← على الخادم فقط. */
  scan() {
    const db = this.db();
    const rows = db.all<VersionRow & { st: string | null }>(
      'SELECT v.id, v.stored_name, v.sha256, v.size, v.ext, b.state AS st FROM document_versions v LEFT JOIN sync_blobs b ON b.version_id = v.id',
    );
    for (const r of rows) {
      const has = this.store.has(r.stored_name);
      if (!r.st) this.set(r.id, has ? 'pending_upload' : 'remote');
      else if (r.st === 'remote' && has) this.set(r.id, 'local');
      else if ((r.st === 'local' || r.st === 'uploaded') && !has) this.set(r.id, 'remote');
    }
  }

  private version(versionId: string): VersionRow {
    const v = this.db().get<VersionRow>('SELECT id, stored_name, sha256, size, ext FROM document_versions WHERE id = ?', [versionId]);
    if (!v) throw new Error('version not found');
    return v;
  }

  /** يرفع كل الملفات المعلقة (يستأنف بعد الانقطاع بإعادة رفع الملف كاملًا بالمفتاح نفسه — لا تكرار). */
  async uploadPending(maxAttempts = 8): Promise<{ uploaded: number; failed: number }> {
    this.scan();
    const pending = this.db().all<{ version_id: string }>("SELECT version_id FROM sync_blobs WHERE state IN ('pending_upload','uploading','failed') AND attempts < ? ORDER BY updated_at", [maxAttempts]);
    let uploaded = 0;
    let failed = 0;
    for (const p of pending) {
      try {
        await this.upload(p.version_id);
        uploaded++;
      } catch (e) {
        failed++;
        this.set(p.version_id, 'failed', { error: String((e as Error).message).slice(0, 300), incAttempt: true });
      }
    }
    return { uploaded, failed };
  }

  async upload(versionId: string) {
    const v = this.version(versionId);
    const office = this.officeId();
    this.set(versionId, 'uploading');
    const req = await this.api.call({ action: 'upload-url', office_id: office, version_id: v.id, sha256: v.sha256, size: v.size, ext: v.ext });
    if (req.status !== 200) throw new Error(`upload-url ${req.status}: ${JSON.stringify(req.body)}`);
    if (req.body.status !== 'verified') {
      const bytes = await this.store.read(v.stored_name);
      if (bytes.byteLength !== v.size || (await sha256Hex(bytes)) !== v.sha256) throw new Error('local file does not match its record');
      const put = await this.fetchImpl(String(req.body.url), { method: 'PUT', headers: req.body.headers as Record<string, string>, body: bytes as Uint8Array<ArrayBuffer> });
      if (!put.ok) throw new Error(`upload failed ${put.status}`);
      const done = await this.api.call({ action: 'complete', office_id: office, version_id: v.id });
      if (done.status !== 200 || done.body.status !== 'verified') throw new Error(`verification failed: ${JSON.stringify(done.body)}`);
    }
    this.set(versionId, 'uploaded');
  }

  /** ينزّل نسخة ويتحقق من بصمتها قبل حفظها. */
  async download(versionId: string): Promise<void> {
    const v = this.version(versionId);
    if (this.store.has(v.stored_name)) {
      this.set(versionId, 'local');
      return;
    }
    this.set(versionId, 'downloading');
    try {
      const r = await this.api.call({ action: 'download-url', office_id: this.officeId(), version_id: v.id });
      if (r.status === 409) throw new Error('الملف لم يكتمل رفعه من الجهاز الذي أضافه بعد. سيتوفر بعد مزامنة ذلك الجهاز.');
      if (r.status === 403) throw new Error('لا تملك صلاحية تنزيل هذا الملف.');
      if (r.status !== 200) throw new Error(`download-url ${r.status}`);
      const res = await this.fetchImpl(String(r.body.url));
      if (!res.ok) throw new Error(`download failed ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== v.size || (await sha256Hex(bytes)) !== v.sha256) throw new Error('الملف المنزّل لا يطابق بصمته المسجلة؛ لم يُحفظ.');
      await this.store.write(v.stored_name, bytes);
      this.set(versionId, 'local');
    } catch (e) {
      this.set(versionId, 'remote', { error: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }

  /** سطح المكتب: تنزيل كل المرفقات (إن اختار المستخدم ذلك). الآيفون: الملفات المختارة «متاحة دون اتصال» فقط. */
  async downloadAll(onlyPinned: boolean): Promise<{ downloaded: number; failed: number }> {
    this.scan();
    const rows = this.db().all<{ version_id: string }>(`SELECT version_id FROM sync_blobs WHERE state = 'remote' ${onlyPinned ? 'AND pinned = 1' : ''}`);
    let downloaded = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await this.download(r.version_id);
        downloaded++;
      } catch {
        failed++;
      }
    }
    return { downloaded, failed };
  }

  setPinned(versionId: string, pinned: boolean) {
    this.scan();
    this.db().run('UPDATE sync_blobs SET pinned = ? WHERE version_id = ?', [pinned ? 1 : 0, versionId]);
  }

  /** إزالة النسخة المحلية من ملف غير مثبت (لتوفير مساحة الهاتف) — يبقى في الخادم. */
  async evict(versionId: string) {
    const v = this.version(versionId);
    const st = this.state(versionId);
    if (st?.state !== 'local' && st?.state !== 'uploaded') return;
    if (st.state === 'uploaded' || st.state === 'local') {
      await this.store.remove?.(v.stored_name);
      this.set(versionId, 'remote');
    }
  }

  summary() {
    const rows = this.db().all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM sync_blobs GROUP BY state');
    const usage = this.db().get<{ s: number | null }>("SELECT sum(v.size) AS s FROM document_versions v JOIN sync_blobs b ON b.version_id = v.id WHERE b.state IN ('local','uploaded','pending_upload','uploading','failed')")!.s ?? 0;
    return { counts: Object.fromEntries(rows.map((r) => [r.state, r.n])), localBytes: usage };
  }
}
