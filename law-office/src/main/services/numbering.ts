// الأرقام المرجعية في وضع المزامنة: من كتل يحجزها الجهاز مسبقًا من الخادم، فلا يتكرر رقم بين جهازين يعملان دون اتصال.
import type { Ctx } from '../context';
import { AppError } from '../errors';
import { syncEnabled, takeReservedNumber } from '../../sync/engine';

/** يعيد رقمًا محجوزًا في وضع المزامنة، أو null في الوضع المحلي (يستخدم العداد المحلي كما كان). */
export function reservedNumber(ctx: Ctx, name: string): number | null {
  if (!syncEnabled(ctx.db)) return null;
  const n = takeReservedNumber(ctx.db, name);
  if (n === null)
    throw new AppError('CONFLICT', 'لا توجد أرقام مرجعية محجوزة على هذا الجهاز لهذا النوع. اتصل بالإنترنت لحظة ليحجز البرنامج أرقامًا جديدة، ثم أعد المحاولة.');
  return n;
}
