// تفعيل المزامنة على جهاز: إنشاء مكتب سحابي من بيانات قائمة (رفع أول)، أو الانضمام لمكتب موجود (تنزيل أول).
import type { Db } from '../main/db/db';
import { SYNC_TABLES, keyCols, type SyncTable } from './tables';
import { installSyncTriggers, setState, getState } from './local';
import type { RpcTransport } from './transport';

/** يضع كل الصفوف المحلية الحالية في الطابور (الرفع الأول عند نقل بيانات مكتب قائم). الترتيب: الآباء قبل الأبناء. */
export function enqueueAll(db: Db): number {
  let n = 0;
  db.tx(() => {
    for (const t of SYNC_TABLES) {
      const cols = keyCols(t);
      for (const r of db.all<Record<string, unknown>>(`SELECT ${cols.join(', ')} FROM ${t}`)) {
        const rid = cols.map((c) => String(r[c])).join('|');
        if (t === 'settings' && ['backup.lastBackupAt', 'backup.lastBackupPath', 'backup.lastAutoSnapshotAt', 'integration.enabled', 'integration.enabledAt'].includes(rid)) continue;
        db.run("INSERT INTO sync_outbox (tbl, rid, op) VALUES (?, ?, 'upsert')", [t, rid]);
        n++;
      }
    }
  });
  return n;
}

/** إحصاء السجلات المحلية لكل جدول (للمقارنة بعد النقل). */
export function localCounts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of SYNC_TABLES) out[t] = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n;
  return out;
}

/** ينشئ مكتبًا سحابيًا لصاحب المكتب ويجهز رفع بياناته الحالية. يُستدعى مرة واحدة من جهاز واحد فقط. */
export async function createCloudOffice(db: Db, t: RpcTransport, input: { officeName: string; localOwnerId: string; displayName: string }) {
  if (getState(db, 'office_id')) throw new Error('هذا الجهاز مرتبط بمكتب سحابي بالفعل');
  const officeId = await t.rpc<string>('app_create_office', { p_name: input.officeName, p_local_owner: input.localOwnerId, p_display_name: input.displayName });
  // الأرقام المرجعية الحالية تُحجز في الخادم حتى لا يتكرر رقم موجود
  for (const c of db.all<{ name: string; value: number }>('SELECT name, value FROM counters')) {
    if (/^(case_no_|con_no_|mtg_no_|client_no)/.test(c.name)) await t.rpc('app_bump_counter', { p_office: officeId, p_name: c.name, p_min: c.value });
  }
  db.tx(() => {
    setState(db, 'office_id', officeId);
    setState(db, 'mode', 'origin');
    installSyncTriggers(db);
    enqueueAll(db);
  });
  return officeId;
}

/** ينضم جهاز (ببيانات فارغة) لمكتب سحابي قائم. لا يرفع بيانات محلية سابقة، ولا يدمج بالتخمين. */
export function joinCloudOffice(db: Db, officeId: string) {
  const hasData = SYNC_TABLES.some((tb: SyncTable) => tb !== 'settings' && tb !== 'lookups' && (db.get<{ n: number }>(`SELECT count(*) AS n FROM ${tb}`)?.n ?? 0) > 0);
  if (hasData)
    throw new Error('توجد بيانات محلية على هذا الجهاز. لا تُدمج تلقائيًا مع المكتب السحابي؛ انقلها من الجهاز المعتمد أو استخدم مساحة بيانات جديدة.');
  db.tx(() => {
    // القوائم والإعدادات الافتراضية المحلية تُستبدل بنسخة المكتب
    db.run('DELETE FROM lookups');
    db.run("DELETE FROM settings WHERE key NOT LIKE 'backup.%' AND key NOT LIKE 'integration.%'");
    setState(db, 'office_id', officeId);
    setState(db, 'mode', 'joined');
    installSyncTriggers(db);
  });
}

/** يفرّغ بيانات المكتب المحلية من هذا الجهاز ليستلم نسخة جهاز المكتب كاملة.
 * لا يُستدعى إلا بعد نسخة احتياطية كاملة (تتولاها شاشة الربط). ملفات المرفقات على القرص لا تُحذف. */
export function clearLocalOfficeData(db: Db) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      for (const t of [...SYNC_TABLES].reverse()) if (t !== 'settings') db.run(`DELETE FROM ${t}`);
      db.run('DELETE FROM sync_outbox');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
