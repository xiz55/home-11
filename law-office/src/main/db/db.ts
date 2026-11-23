// غلاف رقيق فوق node:sqlite (المضمّن في Electron/Node) — لا يحتاج وحدة أصلية تُبنى لكل نظام.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { normalizeArabic } from '../../shared/text';

export type Params = Record<string, unknown> | unknown[] | undefined;
type SqlValue = null | number | bigint | string | Uint8Array;

function bindValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

function bindParams(p: Params): unknown[] {
  if (p === undefined) return [];
  if (Array.isArray(p)) return p.map(bindValue);
  const o: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(p)) o[k] = bindValue(v);
  return [o];
}

export interface OpenOptions {
  readOnly?: boolean;
}

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  private cache = new Map<string, StatementSync>();
  readonly file: string;

  constructor(file: string, opts: OpenOptions = {}) {
    this.file = file;
    this.raw = new DatabaseSync(file, {
      readOnly: !!opts.readOnly,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    } as ConstructorParameters<typeof DatabaseSync>[1]);
    if (!opts.readOnly) {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = FULL');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    // دالة تطبيع عربية للبحث دون تعديل النص المحفوظ
    this.raw.function('arnorm', { deterministic: true }, (v: unknown) =>
      normalizeArabic(v === null || v === undefined ? '' : String(v)),
    );
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      // نسمح بتمرير معاملات مسماة إضافية (مثل معاملات نطاق الصلاحيات) دون خطأ
      (s as StatementSync & { setAllowUnknownNamedParameters?: (v: boolean) => void }).setAllowUnknownNamedParameters?.(true);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
    return this.stmt(sql).get(...(bindParams(params) as [])) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
    return this.stmt(sql).all(...(bindParams(params) as [])) as T[];
  }

  run(sql: string, params?: Params): { changes: number } {
    const r = this.stmt(sql).run(...(bindParams(params) as []));
    return { changes: Number(r.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** معاملة ذرية؛ تدعم التداخل عبر SAVEPOINT. */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const r = fn();
        if (r instanceof Promise) throw new Error('tx callback must be synchronous');
        this.raw.exec('COMMIT');
        return r;
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* تجاهل */
        }
        throw e;
      } finally {
        this.depth--;
      }
    }
    const sp = `sp_${this.depth}`;
    this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.raw.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${sp}`);
      this.raw.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.close();
    } catch {
      /* مغلقة مسبقًا */
    }
  }
}
