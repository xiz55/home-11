// بديل متوافق مع node:sqlite (DatabaseSync) فوق sql.js (SQLite مُترجم إلى WebAssembly).
// يُستخدم في نسخة الآيفون (Capacitor) حيث لا يوجد node:sqlite، فيعمل منطق البرنامج نفسه دون إعادة كتابة.
// قاعدة البيانات تعمل في الذاكرة وتُحفظ كاملة في ملف الجهاز بعد كل معاملة مكتملة (فورًا أو بتأجيل قصير).
// ملاحظة sql.js: export() يغلق القاعدة ويعيد فتحها، فتُفقد الإعدادات والدوال والجمل المجهزة؛ يعيدها هذا الغلاف تلقائيًا.
import type { Database as SqlJsDatabase, SqlJsStatic, Statement, SqlValue } from 'sql.js';

export interface SqliteFileIO {
  read(file: string): Uint8Array | null;
  write(file: string, bytes: Uint8Array): void;
}

let SQL: SqlJsStatic | null = null;
let io: SqliteFileIO | null = null;
/** 0 = حفظ فوري بعد كل معاملة مكتملة؛ أكبر من 0 = تأجيل بالمللي ثانية (يُجمع الحفظ). */
let saveDelayMs = 0;
const open = new Set<DatabaseSync>();

export function configureSqlite(opts: { SQL: SqlJsStatic; io: SqliteFileIO; saveDelayMs?: number }) {
  SQL = opts.SQL;
  io = opts.io;
  saveDelayMs = opts.saveDelayMs ?? 0;
}

/** يحفظ كل القواعد المفتوحة التي فيها تغييرات (يُستدعى عند انتقال التطبيق للخلفية). */
export function flushAll() {
  for (const d of open) d.flush();
}

type BindInput = SqlValue[] | Record<string, SqlValue>;

function toSql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SqlValue;
}

/** أسماء المعاملات المسماة كما تظهر في نص الجملة (مع البادئة)، بعد تجاهل النصوص والتعليقات. */
function namedParams(sql: string): string[] {
  const clean = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const m of clean.matchAll(/[:@$][A-Za-z_][A-Za-z0-9_]*/g)) out.add(m[0]);
  return [...out];
}

class StatementSync {
  private stmt: Statement | null = null;
  private gen = -1;
  private names: string[] | null = null;
  constructor(
    private owner: DatabaseSync,
    readonly sourceSQL: string,
  ) {
    this.isWrite = !StatementSync.READ_RE.test(sourceSQL);
    this.prepare();
  }

  private prepare(): Statement {
    if (!this.stmt || this.gen !== this.owner.generation) {
      this.stmt = this.owner.sql().prepare(this.sourceSQL);
      this.gen = this.owner.generation;
    }
    return this.stmt;
  }

  private readonly isWrite: boolean;
  private static readonly READ_RE = /^\s*(SELECT|EXPLAIN|PRAGMA\s+\w+\s*(\(\s*\w*\s*\))?\s*;?\s*$)/i;

  setAllowUnknownNamedParameters(_v: boolean) {}
  setReadBigInts(_v: boolean) {}

  private bind(args: unknown[]): BindInput | undefined {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof Uint8Array)) {
      const o = args[0] as Record<string, unknown>;
      this.names ??= namedParams(this.sourceSQL);
      const b: Record<string, SqlValue> = {};
      for (const n of this.names) {
        const bare = n.slice(1);
        if (bare in o) b[n] = toSql(o[bare]);
        else if (n in o) b[n] = toSql(o[n]);
      }
      return b;
    }
    if (args.length === 0) return undefined;
    return args.map(toSql);
  }

  private exec<T>(args: unknown[], fn: (s: Statement) => T): T {
    const s = this.prepare();
    try {
      s.reset();
      const b = this.bind(args);
      if (b !== undefined) s.bind(b);
      const r = fn(s);
      return r;
    } finally {
      s.reset();
      this.owner.afterStatement(this.isWrite);
    }
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    if (/^\s*VACUUM\s+INTO/i.test(this.sourceSQL)) {
      this.owner.vacuumInto(String(args[0]));
      return undefined;
    }
    return this.exec(args, (s) => (s.step() ? (s.getAsObject() as Record<string, unknown>) : undefined));
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    return this.exec(args, (s) => {
      const rows: Record<string, unknown>[] = [];
      while (s.step()) rows.push(s.getAsObject() as Record<string, unknown>);
      return rows;
    });
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    if (/^\s*VACUUM\s+INTO/i.test(this.sourceSQL)) {
      this.owner.vacuumInto(String(args[0]));
      return { changes: 0, lastInsertRowid: 0 };
    }
    return this.exec(args, (s) => {
      while (s.step()) {
        /* استهلاك أي صفوف RETURNING */
      }
      const db = this.owner.sql();
      const changes = db.getRowsModified();
      const rid = db.exec('SELECT last_insert_rowid() AS r')[0]?.values[0]?.[0];
      return { changes, lastInsertRowid: Number(rid ?? 0) };
    });
  }
}

export class DatabaseSync {
  private db: SqlJsDatabase;
  generation = 0;
  private txDepth = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fns: [string, (...a: unknown[]) => unknown][] = [];
  private pragmas: string[] = [];
  private readonly readOnly: boolean;
  private closed = false;

  constructor(
    private file: string,
    opts: { readOnly?: boolean; enableForeignKeyConstraints?: boolean } = {},
  ) {
    if (!SQL || !io) throw new Error('sqlite shim not configured');
    this.readOnly = !!opts.readOnly;
    const bytes = file === ':memory:' ? null : io.read(file);
    if (this.readOnly && !bytes) throw new Error(`unable to open database file: ${file}`);
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    if (opts.enableForeignKeyConstraints !== false) this.pragma('PRAGMA foreign_keys = ON');
    open.add(this);
  }

  /** @internal */
  sql(): SqlJsDatabase {
    if (this.closed) throw new Error('database is not open');
    return this.db;
  }

  private pragma(p: string) {
    this.pragmas.push(p);
    this.db.exec(p);
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this, sql);
  }

  exec(sql: string): void {
    const t = sql.trim();
    // الإعدادات التي تُفقد بعد export() تُحفظ لإعادة تطبيقها
    if (/^PRAGMA\s+(foreign_keys|busy_timeout)\b/i.test(t) && !/;\s*\S/.test(t)) {
      this.pragma(t);
      return;
    }
    if (/^PRAGMA\s+(journal_mode|synchronous)\b/i.test(t)) return; // لا معنى لها في قاعدة بالذاكرة
    if (/^BEGIN\b/i.test(t)) this.txDepth = 1;
    else if (/^SAVEPOINT\b/i.test(t)) this.txDepth++;
    this.db.exec(sql);
    if (/^(COMMIT|END)\b/i.test(t) || /^ROLLBACK\s*;?$/i.test(t)) this.txDepth = 0;
    else if (/^RELEASE\b/i.test(t)) this.txDepth = Math.max(0, this.txDepth - 1);
    if (!/^(SELECT|ROLLBACK)\b/i.test(t)) this.dirty = true;
    this.maybeSave();
  }

  function(name: string, optsOrFn: unknown, maybeFn?: (...a: unknown[]) => unknown) {
    const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as (...a: unknown[]) => unknown;
    this.fns.push([name, fn]);
    this.db.create_function(name, fn as never);
  }

  /** @internal بعد كل جملة: تسجيل التغيير وحفظه إن لم تكن داخل معاملة. */
  afterStatement(isWrite: boolean) {
    if (isWrite) this.dirty = true;
    this.maybeSave();
  }

  private maybeSave() {
    if (this.readOnly || !this.dirty || this.txDepth > 0 || this.file === ':memory:') return;
    if (saveDelayMs <= 0) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), saveDelayMs);
  }

  private snapshot(): Uint8Array {
    const bytes = this.db.export();
    // export() أعاد فتح القاعدة: نعيد الدوال والإعدادات ونبطل الجمل المجهزة القديمة
    this.generation++;
    for (const [n, f] of this.fns) this.db.create_function(n, f as never);
    for (const p of this.pragmas) this.db.exec(p);
    return bytes;
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.readOnly || !this.dirty || this.txDepth > 0 || this.file === ':memory:') return;
    io!.write(this.file, this.snapshot());
    this.dirty = false;
  }

  vacuumInto(target: string) {
    if (this.txDepth > 0) throw new Error('cannot VACUUM from within a transaction');
    io!.write(target, this.snapshot());
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    open.delete(this);
    this.db.close();
  }

  get isOpen() {
    return !this.closed;
  }
}

export type { StatementSync };
