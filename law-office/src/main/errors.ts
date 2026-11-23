import type { FieldErrors } from '../shared/schemas';

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'LOCKED'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'STORAGE'
  | 'INTEGRITY'
  | 'CANCELLED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fields?: FieldErrors,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'العنصر') => new AppError('NOT_FOUND', `${what} غير موجود`);
export const forbidden = (msg = 'لا تملك صلاحية تنفيذ هذا الإجراء') => new AppError('FORBIDDEN', msg);
export const invalid = (fields: FieldErrors, msg = 'تحقق من الحقول المظللة') =>
  new AppError('VALIDATION', msg, fields);

export function mapFsError(e: unknown): AppError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return new AppError('STORAGE', 'مساحة القرص غير كافية لإكمال العملية. لم يُحفظ شيء.');
  if (code === 'EACCES' || code === 'EPERM')
    return new AppError('STORAGE', 'تعذر الوصول إلى الملف أو المجلد (صلاحيات نظام التشغيل أو أن الملف مفتوح في برنامج آخر).');
  if (code === 'ENOENT') return new AppError('STORAGE', 'الملف غير موجود في المسار المحدد.');
  if (code === 'EBUSY') return new AppError('STORAGE', 'الملف مستخدم من برنامج آخر حاليًا. أغلقه ثم أعد المحاولة.');
  if (e instanceof AppError) return e;
  return new AppError('STORAGE', 'تعذر إكمال عملية الملفات: ' + ((e as Error)?.message ?? 'خطأ غير معروف'));
}
