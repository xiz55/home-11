// محرك المزامنة المشترك: دفع الطابور المحلي، سحب تغييرات الخادم، التعارضات، والأرقام المرجعية.
// لا يعتمد على ساعة الجهاز لترتيب التعديلات: الترتيب من seq/version في الخادم.
import { randomUUID } from 'node:crypto';
import type { Db } from '../main/db/db';
import { SYNC_TABLES, baseTable, type SyncTable } from './tables';
import { applyRecord, applying, getState, localRecords, readRow, setState } from './local';

export interface PushChange {
  op_id: string;
  tbl: string;
  rid: string;
  op: 'upsert' | 'delete';
  data: Record<string, unknown> | null;
  base: Record<string, unknown> | null;
  base_version: number | null;
}
export interface PushResult {
  op_id: string;
  tbl: string;
  rid: string;
  status: 'applied' | 'merged' | 'conflict' | 'deleted' | 'rejected';
  version?: number;
  data?: Record<string, unknown>;
  deleted?: boolean;
  fields?: string[];
  message?: string;
}
export interface PulledRecord {
  tbl: string;
  rid: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
  deleted: boolean;
}
export interface MemberStatus {
  member: { office_id: string; local_user_id: string; role: 'owner' | 'consultant'; permissions: string[]; active: boolean; access_version: number };
  max_seq: number;
  server_time: string;
}

/** طبقة النقل — Supabase في التطبيقات، واتصال PostgreSQL مباشر في الاختبارات. كلاهما يمر بالدوال وسياسات RLS نفسها. */
export interface SyncTransport {
  push(officeId: string, changes: PushChange[]): Promise<PushResult[]>;
  pull(officeId: string, since: number, limit: number): Promise<PulledRecord[]>;
  status(officeId: string): Promise<MemberStatus | null>;
  reserveNumbers(officeId: string, name: string, count: number): Promise<{ from: number; to: number }>;
}

export type SyncPhase = 'idle' | 'pushing' | 'pulling' | 'offline' | 'error' | 'revoked';

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  rejected: number;
  fullResync: boolean;
}

const BATCH = 200;

export class SyncEngine {
  running = false;
  constructor(
    private db: () => Db,
    private transport: SyncTransport,
    private now: () => Date = () => new Date(),
  ) {}

  get officeId(): string {
    const id = getState(this.db(), 'office_id');
    if (!id) throw new Error('sync not configured');
    return id;
  }

  pendingCount(): number {
    const db = this.db();
    const q = db.get<{ n: number }>('SELECT count(DISTINCT tbl || rid) AS n FROM sync_outbox')!.n;
    return q + (db.get('SELECT 1 AS x FROM sync_inflight') ? 1 : 0);
  }

  /** دورة مزامنة كاملة: إعادة الدفعة المعلقة ← دفع الجديد ← سحب. */
  async sync(): Promise<SyncReport> {
    if (this.running) return { pushed: 0, pulled: 0, conflicts: 0, rejected: 0, fullResync: false };
    this.running = true;
    try {
      const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0, rejected: 0, fullResync: false };
      const st = await this.transport.status(this.officeId);
      if (!st || !st.member?.active) throw new SyncRevokedError();
      const db = this.db();
      const prevAccess = Number(getState(db, 'access_version') ?? '0');
      const prevRole = getState(db, 'role');
      setState(db, 'permissions', JSON.stringify(st.member.permissions));
      setState(db, 'role', st.member.role);
      // دفعة سابقة لم يصل ردها
      const inflight = db.get<{ payload: string; max_seq: number }>('SELECT payload, max_seq FROM sync_inflight WHERE id = 1');
      if (inflight) await this.sendBatch(JSON.parse(inflight.payload), inflight.max_seq, report);
      for (;;) {
        const batch = this.buildBatch();
        if (!batch) break;
        await this.sendBatch(batch.changes, batch.maxSeq, report);
      }
      const full = prevAccess !== st.member.access_version || prevRole !== st.member.role || getState(db, 'last_seq') === null;
      report.fullResync = full && prevAccess !== 0;
      await this.pull(full, report);
      setState(db, 'access_version', String(st.member.access_version));
      setState(db, 'last_sync_at', st.server_time);
      await this.refillNumbers();
      return report;
    } finally {
      this.running = false;
    }
  }

  /** يبني دفعة من الطابور: آخر حالة لكل سجل مع أساسه، ومعرّف عملية فريد ثابت للدفعة. */
  private buildBatch(): { changes: PushChange[]; maxSeq: number } | null {
    const db = this.db();
    const rows = db.all<{ seq: number; tbl: string; rid: string; op: string }>('SELECT seq, tbl, rid, op FROM sync_outbox ORDER BY seq LIMIT ?', [BATCH * 3]);
    if (!rows.length) return null;
    const maxSeq = rows[rows.length - 1].seq;
    // آخر عملية لكل سجل، مع الحفاظ على ترتيب أول ظهور (الآباء قبل الأبناء)
    const order: string[] = [];
    const last = new Map<string, { tbl: string; rid: string; op: string }>();
    for (const r of rows) {
      const k = `${r.tbl}§${r.rid}`;
      if (!last.has(k)) order.push(k);
      last.set(k, r);
    }
    const changes: PushChange[] = [];
    for (const k of order) {
      const { tbl, rid } = last.get(k)!;
      const t = tbl as SyncTable;
      const recs = localRecords(db, t, rid);
      const parts = recs ?? [{ tbl, rid, data: {} }, ...(['consultations', 'meetings', 'contracts'].includes(tbl) ? [{ tbl: `${tbl}$fin`, rid, data: {} }] : [])];
      for (const p of parts) {
        const meta = db.get<{ version: number; base: string | null }>('SELECT version, base FROM sync_meta WHERE tbl = ? AND rid = ?', [p.tbl, p.rid]);
        if (!recs && !meta) continue; // أُنشئ وحُذف محليًا قبل رفعه
        // السجل المالي يُرفع فقط لمن يملك صلاحية إدارة الأتعاب
        if (p.tbl.endsWith('$fin') && !this.canManageFees()) continue;
        if (recs && meta?.base && sameData(p.data, JSON.parse(meta.base))) continue; // لا تغيير فعلي
        changes.push({ op_id: randomUUID(), tbl: p.tbl, rid: p.rid, op: recs ? 'upsert' : 'delete', data: recs ? p.data : null, base: meta?.base ? JSON.parse(meta.base) : null, base_version: meta?.version ?? null });
      }
    }
    if (!changes.length) {
      db.run('DELETE FROM sync_outbox WHERE seq <= ?', [maxSeq]);
      return this.buildBatch();
    }
    db.run('INSERT OR REPLACE INTO sync_inflight (id, payload, max_seq, created_at) VALUES (1, ?, ?, ?)', [JSON.stringify(changes), maxSeq, this.now().toISOString()]);
    return { changes, maxSeq };
  }

  private canManageFees(): boolean {
    const db = this.db();
    if (getState(db, 'role') === 'owner') return true;
    const perms: string[] = JSON.parse(getState(db, 'permissions') ?? '[]');
    return perms.includes('fees.manage') && perms.includes('fees.view');
  }

  private async sendBatch(changes: PushChange[], maxSeq: number, report: SyncReport) {
    const db = this.db();
    const results = await this.transport.push(this.officeId, changes); // خطأ شبكة: تبقى الدفعة في sync_inflight وتُعاد بنفس المعرفات
    const pendingAfter = new Set(db.all<{ k: string }>("SELECT tbl || '§' || rid AS k FROM sync_outbox WHERE seq > ?", [maxSeq]).map((r) => r.k));
    db.tx(() => {
      for (const r of results) {
        const sent = changes.find((c) => c.op_id === r.op_id);
        const mainKey = `${baseTable(r.tbl)}§${r.rid}`;
        if (r.status === 'rejected') {
          report.rejected++;
          db.run('INSERT INTO sync_rejected (tbl, rid, message, at) VALUES (?, ?, ?, ?)', [r.tbl, r.rid, r.message ?? null, this.now().toISOString()]);
          // إعادة الصف المحلي لآخر نسخة معتمدة من الخادم (لا يبقى تعديل مرفوض يوهم بالحفظ)
          const meta = db.get<{ base: string | null }>('SELECT base FROM sync_meta WHERE tbl = ? AND rid = ?', [r.tbl, r.rid]);
          applying(db, () => applyRecord(db, r.tbl, r.rid, meta?.base ? JSON.parse(meta.base) : null, !meta?.base && !r.tbl.endsWith('$fin')));
          continue;
        }
        report.pushed++;
        if (r.deleted || r.status === 'deleted') {
          db.run('DELETE FROM sync_meta WHERE tbl = ? AND rid = ?', [r.tbl, r.rid]);
          if (r.status === 'deleted' && !pendingAfter.has(mainKey)) applying(db, () => applyRecord(db, r.tbl, r.rid, null, true));
          continue;
        }
        db.run('INSERT INTO sync_meta (tbl, rid, version, base) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, rid) DO UPDATE SET version = excluded.version, base = excluded.base', [r.tbl, r.rid, r.version!, JSON.stringify(r.data)]);
        if (r.status === 'conflict') {
          report.conflicts++;
          db.run('INSERT INTO sync_conflicts (id, tbl, rid, fields, server_data, client_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            randomUUID(),
            r.tbl,
            r.rid,
            JSON.stringify(r.fields ?? []),
            JSON.stringify(r.data),
            JSON.stringify(sent?.data ?? {}),
            this.now().toISOString(),
          ]);
        }
        // نسخة الخادم (المدمجة) تُطبق محليًا ما لم يُعدَّل السجل بعد الإرسال
        if ((r.status === 'merged' || r.status === 'conflict') && !pendingAfter.has(mainKey)) applying(db, () => applyRecord(db, r.tbl, r.rid, r.data ?? null, false));
      }
      db.run('DELETE FROM sync_outbox WHERE seq <= ?', [maxSeq]);
      db.run('DELETE FROM sync_inflight WHERE id = 1');
    });
  }

  private async pull(full: boolean, report: SyncReport) {
    const db = this.db();
    let since = full ? 0 : Number(getState(db, 'last_seq') ?? '0');
    const seen = new Set<string>();
    for (;;) {
      const recs = await this.transport.pull(this.officeId, since, 500);
      if (!recs.length) break;
      const pending = new Set(db.all<{ k: string }>("SELECT DISTINCT tbl || '§' || rid AS k FROM sync_outbox").map((r) => r.k));
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.tx(() => {
          for (const r of recs) {
            seen.add(`${r.tbl}§${r.rid}`);
            since = Math.max(since, r.seq);
            const meta = db.get<{ version: number }>('SELECT version FROM sync_meta WHERE tbl = ? AND rid = ?', [r.tbl, r.rid]);
            if (meta && meta.version >= r.version && !full) continue;
            // تعديل محلي معلق: لا يُكتب فوقه؛ سيُدمج عند دفعه
            if (pending.has(`${baseTable(r.tbl)}§${r.rid}`)) continue;
            if (r.deleted) db.run('DELETE FROM sync_meta WHERE tbl = ? AND rid = ?', [r.tbl, r.rid]);
            else db.run('INSERT INTO sync_meta (tbl, rid, version, base) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, rid) DO UPDATE SET version = excluded.version, base = excluded.base', [r.tbl, r.rid, r.version, JSON.stringify(r.data)]);
            applying(db, () => applyRecord(db, r.tbl, r.rid, r.data, r.deleted));
            report.pulled++;
          }
          setState(db, 'last_seq', String(since));
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      if (recs.length < 500) break;
    }
    if (full && getState(db, 'role') !== 'owner') {
      // سجلات لم تعد ضمن نطاق المستخدم (سُحبت صلاحيته): تُزال من نسخته المحلية عند الاتصال
      const pending = new Set(db.all<{ k: string }>("SELECT DISTINCT tbl || '§' || rid AS k FROM sync_outbox").map((r) => r.k));
      const stale = db.all<{ tbl: string; rid: string }>('SELECT tbl, rid FROM sync_meta').filter((m) => !seen.has(`${m.tbl}§${m.rid}`) && !pending.has(`${baseTable(m.tbl)}§${m.rid}`));
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.tx(() => {
          for (const m of stale) {
            applying(db, () => applyRecord(db, m.tbl, m.rid, null, true));
            db.run('DELETE FROM sync_meta WHERE tbl = ? AND rid = ?', [m.tbl, m.rid]);
          }
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  /** حجز كتل أرقام مرجعية مسبقًا ليعمل الجهاز دون اتصال دون تكرار أرقام جهاز آخر. */
  async refillNumbers() {
    const db = this.db();
    const year = this.now().toISOString().slice(0, 4);
    for (const name of [`case_no_${year}`, `con_no_${year}`, `mtg_no_${year}`, 'client_no']) {
      const left = db.get<{ n: number | null }>('SELECT sum(last - next + 1) AS n FROM number_blocks WHERE name = ?', [name])!.n ?? 0;
      if (left >= 10) continue;
      const r = await this.transport.reserveNumbers(this.officeId, name, 25);
      db.run('INSERT INTO number_blocks (name, next, last) VALUES (?, ?, ?)', [name, r.from, r.to]);
    }
  }
}

/** مقارنة قيم السجل دون اعتبار ترتيب المفاتيح (jsonb في الخادم يرتبها). */
export function sameData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

export class SyncRevokedError extends Error {
  constructor() {
    super('access revoked');
  }
}

/** يأخذ الرقم التالي من الكتل المحجوزة (وضع المزامنة)، أو null إن لم تتوفر. */
export function takeReservedNumber(db: Db, name: string): number | null {
  const b = db.get<{ name: string; next: number; last: number }>('SELECT * FROM number_blocks WHERE name = ? ORDER BY next LIMIT 1', [name]);
  if (!b) return null;
  if (b.next >= b.last) db.run('DELETE FROM number_blocks WHERE name = ? AND next = ?', [name, b.next]);
  else db.run('UPDATE number_blocks SET next = next + 1 WHERE name = ? AND next = ?', [name, b.next]);
  return b.next;
}

export function syncEnabled(db: Db): boolean {
  try {
    return !!getState(db, 'office_id');
  } catch {
    return false;
  }
}

export { readRow, SYNC_TABLES };
