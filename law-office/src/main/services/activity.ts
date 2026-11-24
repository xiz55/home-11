import type { Ctx } from '../context';
import { uuid } from '../context';
import { requireOwner } from './access';

export interface ActivityEntry {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  caseId?: string | null;
  clientId?: string | null;
  summary: string;
  details?: unknown;
}

export const ACTION_LABELS: Record<string, string> = {
  create: 'إضافة',
  update: 'تعديل',
  archive: 'أرشفة',
  unarchive: 'إلغاء أرشفة',
  status: 'تغيير حالة',
  close: 'إقفال',
  reopen: 'إعادة فتح',
  delete: 'حذف',
  void: 'إلغاء',
  restore: 'استعادة',
  backup: 'نسخ احتياطي',
  export: 'تصدير',
  login: 'تسجيل دخول',
  logout: 'تسجيل خروج',
  login_failed: 'محاولة دخول فاشلة',
  password: 'كلمة المرور',
  permissions: 'صلاحيات',
  submission: 'تسجيل تقديم',
  version: 'نسخة جديدة',
  integration: 'التكامل',
  reschedule: 'تعديل موعد',
  report: 'إنشاء تقرير',
};

export function logActivity(ctx: Ctx, e: ActivityEntry, userOverride?: { id: string | null; username: string } | null): void {
  const u = userOverride === undefined ? ctx.user : userOverride;
  ctx.db.run(
    `INSERT INTO activity_log (id, at, user_id, username, action, entity_type, entity_id, case_id, client_id, summary, details)
     VALUES (:id, :at, :uid, :uname, :action, :et, :eid, :caseId, :clientId, :summary, :details)`,
    {
      id: uuid(),
      at: ctx.now().toISOString(),
      uid: u?.id ?? null,
      uname: u?.username ?? null,
      action: e.action,
      et: e.entityType ?? null,
      eid: e.entityId ?? null,
      caseId: e.caseId ?? null,
      clientId: e.clientId ?? null,
      summary: e.summary,
      details: e.details === undefined ? null : JSON.stringify(e.details),
    },
  );
}

export function listActivity(
  ctx: Ctx,
  input: { caseId?: string | null; userId?: string | null; limit?: number; before?: string | null },
) {
  requireOwner(ctx);
  const where: string[] = ['1=1'];
  const p: Record<string, unknown> = { limit: Math.min(input.limit ?? 200, 1000) };
  if (input.caseId) {
    where.push('a.case_id = :caseId');
    p.caseId = input.caseId;
  }
  if (input.userId) {
    where.push('a.user_id = :userId');
    p.userId = input.userId;
  }
  if (input.before) {
    where.push('a.at < :before');
    p.before = input.before;
  }
  return ctx.db.all<{
    id: string;
    at: string;
    username: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    case_id: string | null;
    summary: string;
  }>(
    `SELECT a.id, a.at, a.username, a.action, a.entity_type, a.entity_id, a.case_id, a.summary
     FROM activity_log a WHERE ${where.join(' AND ')} ORDER BY a.at DESC LIMIT :limit`,
    p,
  );
}
