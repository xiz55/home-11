// تقرير التحقق من نقل بيانات المكتب: يقارن ما على هذا الجهاز بما على الخادم — عدد السجلات لكل جدول،
// وبصمة قائمة المعرّفات (للتأكد من بقاء المعرّفات والأرقام نفسها دون تكرار أو فقد)، ومجموع الدفعات.
// يمكن تشغيله أي عدد من المرات؛ لا يغيّر أي بيانات.
import { createHash } from 'node:crypto';
import type { Db } from '../main/db/db';
import { SYNC_TABLES, LOCAL_SETTING_KEYS, keyCols } from './tables';

export interface Fingerprint {
  tables: Record<string, { n: number; hash: string }>;
  payments_total: number;
}

export function localFingerprint(db: Db): Fingerprint {
  const tables: Fingerprint['tables'] = {};
  for (const t of SYNC_TABLES) {
    const cols = keyCols(t);
    let rows = db.all<Record<string, unknown>>(`SELECT ${cols.join(', ')} FROM ${t}`);
    if (t === 'settings') rows = rows.filter((r) => !LOCAL_SETTING_KEYS.has(String(r.key)));
    if (!rows.length) continue;
    const rids = rows.map((r) => cols.map((c) => String(r[c])).join('|'));
    // ترتيب نقاط الترميز — يطابق ترتيب collate "C" على ترميز UTF-8 في الخادم
    rids.sort((a, b) => {
      const A = [...a];
      const B = [...b];
      for (let i = 0; i < Math.min(A.length, B.length); i++) {
        const d = A[i].codePointAt(0)! - B[i].codePointAt(0)!;
        if (d) return d;
      }
      return A.length - B.length;
    });
    tables[t] = { n: rows.length, hash: createHash('sha256').update(rids.join(','), 'utf8').digest('hex') as string };
  }
  const p = db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM payments WHERE voided = 0')!;
  return { tables, payments_total: Number(p.s ?? 0) };
}

export interface MigrationReport {
  ok: boolean;
  rows: { table: string; local: number; server: number; idsMatch: boolean }[];
  paymentsLocal: number;
  paymentsServer: number;
}

export function compareFingerprints(local: Fingerprint, server: Fingerprint): MigrationReport {
  const names = [...new Set([...Object.keys(local.tables), ...Object.keys(server.tables)])].sort();
  const rows = names.map((t) => {
    const l = local.tables[t] ?? { n: 0, hash: '' };
    const s = server.tables[t] ?? { n: 0, hash: '' };
    return { table: t, local: l.n, server: s.n, idsMatch: l.hash === s.hash };
  });
  const paymentsServer = Number(server.payments_total ?? 0);
  return {
    ok: rows.every((r) => r.local === r.server && r.idsMatch) && paymentsServer === local.payments_total,
    rows,
    paymentsLocal: local.payments_total,
    paymentsServer,
  };
}
