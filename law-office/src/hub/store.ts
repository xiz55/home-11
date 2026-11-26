// «خادم المكتب» المحلي: جهاز المكتب هو مصدر الحقيقة. نقل أمين لمنطق الخادم السحابي (sync_push/sync_pull)
// إلى SQLite نفسها على جهاز المكتب: سجل لكل صف بإصدار وترتيب (seq) من الخادم، دمج الحقول المستقلة، حفظ النسختين
// عند تعارض الحقل نفسه، المبالغ المالية لا تُعدّل، الإلغاء لا يُتراجع عنه، المحذوف لا يُعاد، ومعرّف عملية يمنع التكرار.
// أجهزة صاحب المكتب (الماك) تتزامن هنا بمحرك المزامنة نفسه دون تعديل.
import { randomUUID } from 'node:crypto';
import type { Db } from '../main/db/db';
import type { MemberStatus, PulledRecord, PushChange, PushResult } from '../sync/engine';
import { applyRecord, applying, installSyncTriggers, localRecords } from '../sync/local';
import { LINK_TABLES, LOCAL_SETTING_KEYS, SYNC_TABLES, baseTable, keyCols, rowToRecords, setCredentialSync, type SyncTable } from '../sync/tables';

const FIN_LOCKED = new Set(['amount', 'paid_on', 'txn_on', 'adjusted_on', 'kind', 'contract_id', 'client_id', 'consultation_id', 'meeting_id', 'fee_item_id', 'is_advance']);
const FIN_TABLES = new Set(['payments', 'service_txns', 'contract_adjustments']);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function ensureHubSchema(db: Db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS hub_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS hub_records (tbl TEXT NOT NULL, rid TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tbl, rid));
CREATE INDEX IF NOT EXISTS hub_records_seq ON hub_records(seq);
CREATE TABLE IF NOT EXISTS hub_ops (op_id TEXT PRIMARY KEY, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hub_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, platform TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen TEXT, revoked_at TEXT, trusted_until TEXT);
CREATE TABLE IF NOT EXISTS hub_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL, meta TEXT, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS hub_user_email (user_id TEXT PRIMARY KEY, email TEXT NOT NULL);`);
}

export function hubGet(db: Db, key: string): string | null {
  return db.get<{ value: string | null }>('SELECT value FROM hub_state WHERE key = ?', [key])?.value ?? null;
}
export function hubSet(db: Db, key: string, value: string | null) {
  if (value === null) db.run('DELETE FROM hub_state WHERE key = ?', [key]);
  else db.run('INSERT INTO hub_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

export class HubStore {
  constructor(private db: () => Db) {}

  /** تفعيل الخادم: سجل إصدار لكل صف حالي (مرة واحدة)، ومشغلات التقاط تعديلات جهاز المكتب نفسه. */
  enable(): string {
    const db = this.db();
    setCredentialSync(true);
    ensureHubSchema(db);
    let id = hubGet(db, 'office_id');
    if (!id) {
      id = randomUUID();
      db.tx(() => {
        let seq = 0;
        for (const t of SYNC_TABLES) {
          for (const row of db.all<Record<string, unknown>>(`SELECT * FROM ${t}`)) {
            if (t === 'settings' && LOCAL_SETTING_KEYS.has(String(row.key))) continue;
            for (const p of rowToRecords(t, row)) db.run('INSERT OR REPLACE INTO hub_records (tbl, rid, data, version, seq, deleted) VALUES (?, ?, ?, 1, ?, 0)', [p.tbl, p.rid, JSON.stringify(p.data), ++seq]);
          }
        }
        hubSet(db, 'seq', String(seq));
        hubSet(db, 'office_id', id);
      });
      db.run('DELETE FROM sync_outbox');
    }
    installSyncTriggers(db);
    this.stamp();
    return id!;
  }

  officeId(): string {
    const id = hubGet(this.db(), 'office_id');
    if (!id) throw new Error('hub not enabled');
    return id;
  }

  private nextSeq(): number {
    const db = this.db();
    const n = Number(hubGet(db, 'seq') ?? '0') + 1;
    hubSet(db, 'seq', String(n));
    return n;
  }

  /** تعديلات جهاز المكتب نفسه (وواجهة الرابط الآمن) تأخذ إصدارًا وترتيبًا جديدين. */
  stamp() {
    const db = this.db();
    const rows = db.all<{ seq: number; tbl: string; rid: string }>('SELECT seq, tbl, rid FROM sync_outbox ORDER BY seq');
    if (!rows.length) return;
    const maxSeq = rows[rows.length - 1].seq;
    const done = new Set<string>();
    db.tx(() => {
      for (const r of rows) {
        const k = `${r.tbl}§${r.rid}`;
        if (done.has(k)) continue;
        done.add(k);
        const parts = localRecords(db, r.tbl as SyncTable, r.rid);
        if (!parts) {
          for (const tbl of [r.tbl, `${r.tbl}$fin`]) {
            const cur = db.get<{ version: number; deleted: number }>('SELECT version, deleted FROM hub_records WHERE tbl = ? AND rid = ?', [tbl, r.rid]);
            if (cur && !cur.deleted) db.run('UPDATE hub_records SET deleted = 1, version = version + 1, seq = ? WHERE tbl = ? AND rid = ?', [this.nextSeq(), tbl, r.rid]);
          }
          continue;
        }
        for (const p of parts) {
          const cur = db.get<{ data: string; deleted: number }>('SELECT data, deleted FROM hub_records WHERE tbl = ? AND rid = ?', [p.tbl, p.rid]);
          if (cur && !cur.deleted && same(JSON.parse(cur.data), p.data)) continue;
          if (cur) db.run('UPDATE hub_records SET data = ?, deleted = 0, version = version + 1, seq = ? WHERE tbl = ? AND rid = ?', [JSON.stringify(p.data), this.nextSeq(), p.tbl, p.rid]);
          else db.run('INSERT INTO hub_records (tbl, rid, data, version, seq, deleted) VALUES (?, ?, ?, 1, ?, 0)', [p.tbl, p.rid, JSON.stringify(p.data), this.nextSeq()]);
        }
      }
      db.run('DELETE FROM sync_outbox WHERE seq <= ?', [maxSeq]);
    });
  }

  status(localUserId: string, now: Date): MemberStatus {
    this.stamp();
    return {
      member: { office_id: this.officeId(), local_user_id: localUserId, role: 'owner', permissions: [], active: true, access_version: 1 },
      max_seq: Number(hubGet(this.db(), 'seq') ?? '0'),
      server_time: now.toISOString(),
    };
  }

  pull(since: number, limit: number): PulledRecord[] {
    this.stamp();
    return this.db()
      .all<{ tbl: string; rid: string; data: string; version: number; seq: number; deleted: number }>('SELECT * FROM hub_records WHERE seq > ? ORDER BY seq LIMIT ?', [since, Math.min(Math.max(limit, 1), 2000)])
      .map((r) => ({ tbl: r.tbl, rid: r.rid, data: JSON.parse(r.data), version: r.version, seq: r.seq, deleted: !!r.deleted }));
  }

  push(changes: PushChange[], now: Date): PushResult[] {
    this.stamp();
    const db = this.db();
    const out: PushResult[] = [];
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (const ch of changes) {
        const prev = db.get<{ result: string }>('SELECT result FROM hub_ops WHERE op_id = ?', [ch.op_id]);
        if (prev) {
          out.push(JSON.parse(prev.result));
          continue;
        }
        try {
          const res = db.tx(() => this.applyChange(ch));
          db.run('INSERT INTO hub_ops (op_id, result, at) VALUES (?, ?, ?)', [ch.op_id, JSON.stringify(res), now.toISOString()]);
          out.push(res);
        } catch (e) {
          // رفض هذا التغيير وحده؛ لا تُخزن نتيجة الرفض حتى يمكن إعادة المحاولة
          out.push({ op_id: ch.op_id, tbl: ch.tbl, rid: ch.rid, status: 'rejected', message: String((e as Error).message) });
        }
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    return out;
  }

  private write(tbl: string, rid: string, data: Record<string, unknown>, deleted: boolean) {
    const db = this.db();
    applying(db, () => applyRecord(db, tbl, rid, deleted ? null : data, deleted));
  }

  private applyChange(ch: PushChange): PushResult {
    const db = this.db();
    const base = baseTable(ch.tbl);
    if (!(SYNC_TABLES as readonly string[]).includes(base)) throw new Error('unknown table');
    if (ch.rid.split('|').length !== keyCols(base).length) throw new Error('bad record id');
    const cur = db.get<{ data: string; version: number; deleted: number }>('SELECT data, version, deleted FROM hub_records WHERE tbl = ? AND rid = ?', [ch.tbl, ch.rid]);
    const r = (status: PushResult['status'], version: number, data: Record<string, unknown>, deleted: boolean, extra: Partial<PushResult> = {}): PushResult => ({ op_id: ch.op_id, tbl: ch.tbl, rid: ch.rid, status, version, data, deleted, ...extra });
    if (!cur) {
      const data = ch.data ?? {};
      const del = ch.op === 'delete';
      db.run('INSERT INTO hub_records (tbl, rid, data, version, seq, deleted) VALUES (?, ?, ?, 1, ?, ?)', [ch.tbl, ch.rid, JSON.stringify(data), this.nextSeq(), del ? 1 : 0]);
      this.write(ch.tbl, ch.rid, data, del);
      return r('applied', 1, data, del);
    }
    const curData = JSON.parse(cur.data) as Record<string, unknown>;
    if (cur.deleted && ch.op === 'upsert' && LINK_TABLES.has(base)) {
      const data = ch.data ?? {};
      db.run('UPDATE hub_records SET data = ?, deleted = 0, version = version + 1, seq = ? WHERE tbl = ? AND rid = ?', [JSON.stringify(data), this.nextSeq(), ch.tbl, ch.rid]);
      this.write(ch.tbl, ch.rid, data, false);
      return r('applied', cur.version + 1, data, false);
    }
    if (cur.deleted) return r('deleted', cur.version, curData, true);
    if (ch.op === 'delete') {
      db.run('UPDATE hub_records SET deleted = 1, version = version + 1, seq = ? WHERE tbl = ? AND rid = ?', [this.nextSeq(), ch.tbl, ch.rid]);
      this.write(ch.tbl, ch.rid, curData, true);
      return r('applied', cur.version + 1, curData, true);
    }
    const next = ch.data ?? {};
    const baseData = ch.base;
    const merged: Record<string, unknown> = { ...curData };
    const conflicts: string[] = [];
    for (const k of Object.keys(next)) {
      if (baseData && same(next[k], baseData[k])) continue; // الجهاز لم يغيّر هذا الحقل
      if (FIN_TABLES.has(base) && FIN_LOCKED.has(k) && !same(curData[k], next[k]))
        throw new Error(`financial record ${ch.rid} is immutable (field ${k}): correct it with a reversal or adjustment`);
      const serverChanged = baseData && !same(curData[k], baseData[k]) && !same(curData[k], next[k]);
      if (serverChanged) {
        if (k === 'voided' && String(curData[k]) === '1') continue;
        if (k === 'updated_at' || k === 'updated_by') continue;
        conflicts.push(k);
        continue;
      }
      if (k === 'voided' && String(curData[k]) === '1') continue;
      merged[k] = next[k];
    }
    let version = cur.version;
    if (!same(merged, curData)) {
      version++;
      db.run('UPDATE hub_records SET data = ?, version = ?, seq = ? WHERE tbl = ? AND rid = ?', [JSON.stringify(merged), version, this.nextSeq(), ch.tbl, ch.rid]);
      this.write(ch.tbl, ch.rid, merged, false);
    }
    if (conflicts.length) return r('conflict', version, merged, false, { fields: conflicts });
    return r(!baseData || ch.base_version === version - 1 ? 'applied' : 'merged', version, merged, false);
  }

  /** حجز كتلة أرقام مرجعية لجهاز من عدادات جهاز المكتب نفسها — فلا يتكرر رقم بين الأجهزة. */
  reserveNumbers(name: string, count: number): { from: number; to: number } {
    if (!/^(case_no_\d{4}|con_no_\d{4}|mtg_no_\d{4}|client_no)$/.test(name)) throw new Error('bad counter');
    const n = Math.min(Math.max(count, 1), 100);
    const db = this.db();
    return db.tx(() => {
      db.run('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [name]);
      const cur = db.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [name])!.value;
      db.run('UPDATE counters SET value = ? WHERE name = ?', [cur + n, name]);
      return { from: cur + 1, to: cur + n };
    });
  }
}
