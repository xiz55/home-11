// طابور استخراج النصوص: يعمل بالتتابع ويحدّث حالة كل نسخة مستند.
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import type { AppPaths } from '../paths';
import { appendLog, attachmentPath } from '../paths';
import { normalizeArabic } from '../../shared/text';

type Extractor = (file: string, ext: string) => Promise<{ status: 'done' | 'none' | 'unsupported'; text: string | null }>;

export class ExtractionQueue {
  private queue: string[] = [];
  private running = false;
  private worker: Worker | null = null;
  private pending = new Map<string, (r: { ok: boolean; status?: string; text?: string | null; error?: string }) => void>();

  constructor(
    private getDb: () => Db,
    private paths: AppPaths,
    private workerFile: string | null,
    private inline?: Extractor,
  ) {}

  enqueue(versionId: string) {
    this.queue.push(versionId);
    void this.pump();
  }

  enqueuePending() {
    for (const r of this.getDb().all<{ id: string }>("SELECT id FROM document_versions WHERE extraction_status IN ('pending', 'failed')")) this.queue.push(r.id);
    void this.pump();
  }

  private extract(file: string, ext: string): Promise<{ ok: boolean; status?: string; text?: string | null; error?: string }> {
    if (this.inline || !this.workerFile) {
      return (this.inline ?? (async () => ({ status: 'unsupported' as const, text: null })))(file, ext).then(
        (r) => ({ ok: true, ...r }),
        (e) => ({ ok: false, error: (e as Error).message }),
      );
    }
    if (!this.worker) {
      this.worker = new Worker(this.workerFile);
      this.worker.on('message', (m: { id: string; ok: boolean; status?: string; text?: string | null; error?: string }) => {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      });
      this.worker.on('error', (err) => {
        for (const cb of this.pending.values()) cb({ ok: false, error: err.message });
        this.pending.clear();
        this.worker = null;
      });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        void this.worker?.terminate();
        this.worker = null;
        resolve({ ok: false, error: 'انتهت مهلة الاستخراج' });
      }, 120_000);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.worker!.postMessage({ id, file, ext });
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const vid = this.queue.shift()!;
        let db: Db;
        try {
          db = this.getDb();
        } catch {
          continue;
        }
        const v = db.get<{ stored_name: string; ext: string; extraction_status: string }>('SELECT stored_name, ext, extraction_status FROM document_versions WHERE id = ?', [vid]);
        if (!v || (v.extraction_status !== 'pending' && v.extraction_status !== 'failed')) continue;
        const r = await this.extract(attachmentPath(this.paths, v.stored_name), v.ext);
        try {
          db = this.getDb();
          if (r.ok) db.run('UPDATE document_versions SET extraction_status = ?, extracted_text = ?, extracted_norm = ? WHERE id = ?', [r.status, r.text ?? null, r.text ? normalizeArabic(r.text) : null, vid]);
          else {
            appendLog(this.paths, `extraction failed for ${vid}: ${r.error ?? ''}`);
            db.run("UPDATE document_versions SET extraction_status = 'failed' WHERE id = ?", [vid]);
          }
        } catch {
          /* قاعدة البيانات أُغلقت (استعادة) — تُعاد المحاولة عند التشغيل التالي */
        }
      }
    } finally {
      this.running = false;
    }
  }

  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  stop() {
    void this.worker?.terminate();
    this.worker = null;
  }
}
