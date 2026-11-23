import type { Ctx } from '../context';
import { uuid } from '../context';
import type { Db } from '../db/db';
import { DEFAULT_SETTINGS, LOOKUP_LISTS, LOOKUP_LIST_KEYS, type LookupListKey, type SettingKey, type SettingsShape } from '../../shared/constants';
import { requireOwner, requireUser } from './access';
import { logActivity } from './activity';
import { AppError } from '../errors';

export function seedDefaults(db: Db, nowIso: string): void {
  db.tx(() => {
    for (const key of LOOKUP_LIST_KEYS) {
      const list = LOOKUP_LISTS[key];
      list.defaults.forEach((label, i) => {
        db.run(
          'INSERT OR IGNORE INTO lookups (id, list_key, label, sort_order, active, is_system, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
          [uuid(), key, label, i * 10, nowIso],
        );
      });
    }
  });
}

export function readSetting<K extends SettingKey>(db: Db, key: K): SettingsShape[K] {
  const r = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!r) return DEFAULT_SETTINGS[key];
  try {
    return JSON.parse(r.value) as SettingsShape[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export function writeSetting<K extends SettingKey>(db: Db, key: K, value: SettingsShape[K], nowIso: string): void {
  db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), nowIso],
  );
}

export function allSettings(db: Db): SettingsShape {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (r.key in out) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        /* نُبقي الافتراضي */
      }
    }
  }
  return out as SettingsShape;
}

const PUBLIC_KEYS: SettingKey[] = [
  'office.name',
  'office.phone',
  'office.email',
  'office.address',
  'office.license',
  'security.idleLockMinutes',
  'reminders.hearingOffsets',
  'reminders.taskTime',
  'reminders.enabled',
];

export function getSettings(ctx: Ctx) {
  const u = requireUser(ctx);
  const all = allSettings(ctx.db);
  if (u.role === 'owner') return all;
  const out: Partial<SettingsShape> = {};
  for (const k of PUBLIC_KEYS) (out as Record<string, unknown>)[k] = all[k];
  return out;
}

export function updateSettings(ctx: Ctx, patch: Partial<SettingsShape>) {
  requireOwner(ctx);
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      if (v === undefined) continue;
      writeSetting(ctx.db, k as SettingKey, v as never, now);
    }
    logActivity(ctx, { action: 'update', entityType: 'settings', summary: 'تعديل الإعدادات: ' + Object.keys(patch).join('، ') });
  });
  return allSettings(ctx.db);
}

export interface LookupRow {
  id: string;
  list_key: LookupListKey;
  label: string;
  sort_order: number;
  active: number;
  is_system: number;
}

export function listLookups(ctx: Ctx, listKey?: LookupListKey | null) {
  requireUser(ctx);
  if (listKey)
    return ctx.db.all<LookupRow>('SELECT * FROM lookups WHERE list_key = ? ORDER BY sort_order, label', [listKey]);
  return ctx.db.all<LookupRow>('SELECT * FROM lookups ORDER BY list_key, sort_order, label');
}

export function addLookup(ctx: Ctx, input: { listKey: LookupListKey; label: string }) {
  requireOwner(ctx);
  const exists = ctx.db.get('SELECT id FROM lookups WHERE list_key = ? AND label = ?', [input.listKey, input.label]);
  if (exists) throw new AppError('VALIDATION', 'القيمة موجودة مسبقًا في القائمة', { label: 'القيمة موجودة مسبقًا' });
  const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM lookups WHERE list_key = ?', [input.listKey]);
  const id = uuid();
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO lookups (id, list_key, label, sort_order, active, is_system, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)',
      [id, input.listKey, input.label, (max?.m ?? 0) + 10, ctx.now().toISOString()],
    );
    logActivity(ctx, { action: 'create', entityType: 'lookup', entityId: id, summary: `إضافة «${input.label}» إلى ${LOOKUP_LISTS[input.listKey].label}` });
  });
  return { id };
}

export function updateLookup(ctx: Ctx, input: { id: string; label?: string; active?: boolean; sortOrder?: number }) {
  requireOwner(ctx);
  const row = ctx.db.get<LookupRow>('SELECT * FROM lookups WHERE id = ?', [input.id]);
  if (!row) throw new AppError('NOT_FOUND', 'القيمة غير موجودة');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE lookups SET label = ?, active = ?, sort_order = ? WHERE id = ?', [
      input.label ?? row.label,
      input.active === undefined ? row.active : input.active ? 1 : 0,
      input.sortOrder ?? row.sort_order,
      input.id,
    ]);
    logActivity(ctx, { action: 'update', entityType: 'lookup', entityId: input.id, summary: `تعديل قيمة القائمة «${row.label}»` });
  });
  return { ok: true };
}
