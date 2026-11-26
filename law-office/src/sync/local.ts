// الجانب المحلي من المزامنة: مشغلات تسجيل التغييرات في طابور دائم، وتطبيق سجلات الخادم على SQLite.
import type { Db } from '../main/db/db';
import { FIN_FIELDS, LOCAL_DEFAULTS, LOCAL_FIELDS, LOCAL_SETTING_KEYS, SYNC_TABLES, baseTable, keyCols, ridOf, rowToRecords, type RecordPart, type SyncTable } from './tables';

const ridExpr = (t: string, alias: 'NEW' | 'OLD') => keyCols(t).map((k) => `${alias}.${k}`).join(" || '|' || ");

/** يثبّت مشغلات التقاط التغييرات (لا تعمل أثناء تطبيق تغييرات الخادم). */
export function installSyncTriggers(db: Db) {
  for (const t of SYNC_TABLES) {
    const guard = `(SELECT applying FROM sync_flags WHERE id = 1) = 0`;
    const skip = t === 'settings' ? ` AND NEW.key NOT IN (${[...LOCAL_SETTING_KEYS].map((k) => `'${k}'`).join(',')})` : '';
    const skipOld = t === 'settings' ? ` AND OLD.key NOT IN (${[...LOCAL_SETTING_KEYS].map((k) => `'${k}'`).join(',')})` : '';
    db.exec(`
CREATE TRIGGER IF NOT EXISTS sync_${t}_ins AFTER INSERT ON ${t} WHEN ${guard}${skip}
BEGIN INSERT INTO sync_outbox (tbl, rid, op) VALUES ('${t}', ${ridExpr(t, 'NEW')}, 'upsert'); END;
CREATE TRIGGER IF NOT EXISTS sync_${t}_upd AFTER UPDATE ON ${t} WHEN ${guard}${skip}
BEGIN INSERT INTO sync_outbox (tbl, rid, op) VALUES ('${t}', ${ridExpr(t, 'NEW')}, 'upsert'); END;
CREATE TRIGGER IF NOT EXISTS sync_${t}_del AFTER DELETE ON ${t} WHEN ${guard}${skipOld}
BEGIN INSERT INTO sync_outbox (tbl, rid, op) VALUES ('${t}', ${ridExpr(t, 'OLD')}, 'delete'); END;`);
  }
}

export function removeSyncTriggers(db: Db) {
  for (const t of SYNC_TABLES) for (const s of ['ins', 'upd', 'del']) db.exec(`DROP TRIGGER IF EXISTS sync_${t}_${s}`);
}

export function getState(db: Db, key: string): string | null {
  return db.get<{ value: string | null }>('SELECT value FROM sync_state WHERE key = ?', [key])?.value ?? null;
}
export function setState(db: Db, key: string, value: string | null) {
  if (value === null) db.run('DELETE FROM sync_state WHERE key = ?', [key]);
  else db.run('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

/** تشغيل دالة مع تعطيل التقاط التغييرات (لتطبيق بيانات الخادم دون إعادة إرسالها). */
export function applying<T>(db: Db, fn: () => T): T {
  db.run('UPDATE sync_flags SET applying = 1 WHERE id = 1');
  try {
    return fn();
  } finally {
    db.run('UPDATE sync_flags SET applying = 0 WHERE id = 1');
  }
}

const colCache = new Map<string, Set<string>>();
export function columnsOf(db: Db, t: string): Set<string> {
  const k = `${db.file}:${t}`;
  let c = colCache.get(k);
  if (!c) {
    c = new Set(db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((r) => r.name));
    colCache.set(k, c);
  }
  return c;
}

export function readRow(db: Db, t: SyncTable, rid: string): Record<string, unknown> | undefined {
  const keys = keyCols(t);
  const vals = rid.split('|');
  return db.get(`SELECT * FROM ${t} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`, vals);
}

/** يقرأ السجلات المحلية الحالية لصف (أساسي + مالي). */
export function localRecords(db: Db, t: SyncTable, rid: string): RecordPart[] | null {
  const row = readRow(db, t, rid);
  return row ? rowToRecords(t, row) : null;
}

/** يطبق سجلًا من الخادم على الجدول المحلي: إدراج أو تحديث للحقول الموجودة فقط، أو حذف. */
export function applyRecord(db: Db, tbl: string, rid: string, data: Record<string, unknown> | null, deleted: boolean) {
  const t = baseTable(tbl);
  if (!(SYNC_TABLES as readonly string[]).includes(t)) return;
  if (t === 'settings' && LOCAL_SETTING_KEYS.has(rid)) return;
  const keys = keyCols(t);
  const keyVals = rid.split('|');
  const where = keys.map((k) => `${k} = ?`).join(' AND ');
  const isFin = tbl.endsWith('$fin');
  if (deleted) {
    if (!isFin) db.run(`DELETE FROM ${t} WHERE ${where}`, keyVals);
    return;
  }
  if (!data) return;
  const cols = columnsOf(db, t);
  const drop = new Set(LOCAL_FIELDS[t] ?? []);
  const fin = new Set(FIN_FIELDS[t] ?? []);
  const entries = Object.entries(data).filter(([k]) => cols.has(k) && !drop.has(k) && (isFin ? fin.has(k) : !fin.has(k)));
  const exists = !!db.get(`SELECT 1 AS x FROM ${t} WHERE ${where}`, keyVals);
  if (exists) {
    const upd = entries.filter(([k]) => !keys.includes(k));
    if (upd.length) db.run(`UPDATE ${t} SET ${upd.map(([k]) => `${k} = ?`).join(', ')} WHERE ${where}`, [...upd.map(([, v]) => toSql(v)), ...keyVals]);
    return;
  }
  if (isFin) return; // السجل الأساسي لم يصل بعد؛ يُطبق المالي عند وصوله (تُعاد قراءته من sync_meta)
  const row: Record<string, unknown> = { ...(LOCAL_DEFAULTS[t] ?? {}) };
  keys.forEach((k, i) => (row[k] = keyVals[i]));
  for (const [k, v] of entries) row[k] = v;
  // الحقول المالية المحفوظة سابقًا (إن وصل السجل المالي قبل الأساسي)
  const finMeta = db.get<{ base: string | null }>('SELECT base FROM sync_meta WHERE tbl = ? AND rid = ?', [`${t}$fin`, rid]);
  if (finMeta?.base) for (const [k, v] of Object.entries(JSON.parse(finMeta.base))) if (cols.has(k)) row[k] = v;
  const names = Object.keys(row).filter((k) => cols.has(k));
  db.run(`INSERT INTO ${t} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => toSql(row[k])));
}

function toSql(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export { ridOf };
