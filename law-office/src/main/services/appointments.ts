// الاستشارات القانونية والاجتماعات: قسم مستقل عن القضايا. صاحب الموعد جهة اتصال في سجل العملاء الموحد (جدول clients)
// فلا يتكرر الشخص إذا فُتحت له قضية لاحقًا. حالة الموعد مستقلة عن حالة السداد، والإلغاء لا يلغي المبالغ تلقائيًا.
import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { fmtAmount } from '../../shared/money';
import { addDays, fmtDateTime, riyadhToUtcIso, todayRiyadh, utcIsoToRiyadh } from '../../shared/dates';
import { likeEscape, searchTokens } from '../../shared/text';
import {
  APPT_METHODS,
  CONSULT_STATUSES,
  MEETING_STATUSES,
  OPINION_STATUSES,
  SVC_TXN_KINDS,
  type ApptMethod,
  type ClientKind,
  type ConsultStatus,
  type FeeMode,
  type MeetingItemKind,
  type MeetingStatus,
  type OpinionStatus,
  type PayStatus,
  type Priority,
  type SvcTxnKind,
} from '../../shared/constants';
import { canAccessCase, clientAccess, grantClient, hasPerm, isOwner, requireCase, requireClient, requirePerm, requireUser } from './access';
import { logActivity } from './activity';
import { readSetting } from './settings';
import { reservedNumber } from './numbering';
import { clearReminders, syncTaskReminder } from './reminders';
import { contractTotals } from './finance';
import { findSimilarClients, nextClientNo } from './clients';

// ———————————————— الصلاحيات ————————————————

export type ApptTable = 'consultations' | 'meetings';

/** شرط SQL للمواعيد المرئية للمستخدم. المالك ومن يملك «الاطلاع على الكل» يرون الجميع. */
export function apptScope(ctx: Ctx, table: ApptTable, alias: string): { sql: string; params: Record<string, unknown> } {
  const u = requireUser(ctx);
  if (u.role === 'owner' || hasPerm(ctx, 'consultations.viewAll')) return { sql: '1=1', params: {} };
  return {
    sql: `(${alias}.responsible_user_id = :appt_me OR ${alias}.created_by = :appt_me
      OR (${alias}.case_id IS NOT NULL AND ${alias}.case_id IN (SELECT case_id FROM user_case_access WHERE user_id = :appt_me))
      OR (${alias}.client_id IS NOT NULL AND ${alias}.client_id IN (SELECT client_id FROM user_client_access WHERE user_id = :appt_me)))`,
    params: { appt_me: u.id },
  };
}

interface ApptBase {
  id: string;
  ref_no: string;
  client_id: string | null;
  case_id: string | null;
  title: string;
  responsible_user_id: string | null;
  created_by: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

function canSee(ctx: Ctx, table: ApptTable, row: ApptBase): boolean {
  const u = requireUser(ctx);
  if (u.role === 'owner' || hasPerm(ctx, 'consultations.viewAll')) return true;
  if (row.responsible_user_id === u.id || row.created_by === u.id) return true;
  if (row.case_id && canAccessCase(ctx, row.case_id)) return true;
  if (row.client_id && clientAccess(ctx, row.client_id) === 'full') return true;
  void table;
  return false;
}

export function requireConsultation(ctx: Ctx, id: string) {
  const r = ctx.db.get<ApptBase & Record<string, unknown>>('SELECT * FROM consultations WHERE id = ?', [id]);
  if (!r) throw notFound('الاستشارة');
  if (!canSee(ctx, 'consultations', r)) throw forbidden('لا تملك صلاحية الاطلاع على هذه الاستشارة');
  return r;
}

export function requireMeeting(ctx: Ctx, id: string) {
  const r = ctx.db.get<ApptBase & Record<string, unknown>>('SELECT * FROM meetings WHERE id = ?', [id]);
  if (!r) throw notFound('الاجتماع');
  if (!canSee(ctx, 'meetings', r)) throw forbidden('لا تملك صلاحية الاطلاع على هذا الاجتماع');
  return r;
}

function requireManage(ctx: Ctx) {
  requirePerm(ctx, 'consultations.manage', 'لا تملك صلاحية إضافة الاستشارات والاجتماعات أو تعديلها');
}

// ———————————————— أدوات مشتركة ————————————————

function nextRef(ctx: Ctx, prefix: 'CON' | 'MTG', table: ApptTable): string {
  const year = todayRiyadh(ctx.now()).slice(0, 4);
  const key = `${prefix.toLowerCase()}_no_${year}`;
  const reserved = reservedNumber(ctx, key);
  if (reserved !== null) return `${prefix}-${year}/${String(reserved).padStart(4, '0')}`;
  ctx.db.run('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', [key]);
  for (;;) {
    ctx.db.run('UPDATE counters SET value = value + 1 WHERE name = ?', [key]);
    const n = ctx.db.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [key])!.value;
    const ref = `${prefix}-${year}/${String(n).padStart(4, '0')}`;
    if (!ctx.db.get(`SELECT id FROM ${table} WHERE ref_no = ?`, [ref])) return ref;
  }
}

function validateUser(ctx: Ctx, userId: string | null, field = 'responsibleUserId') {
  if (!userId) return;
  const u = ctx.db.get<{ active: number }>('SELECT active FROM users WHERE id = ?', [userId]);
  if (!u || !u.active) throw new AppError('VALIDATION', 'المستخدم المختار غير موجود أو موقوف', { [field]: 'اختر مستخدمًا نشطًا' });
}

export interface NewContact {
  kind: ClientKind;
  name: string;
  phone: string;
  email: string | null;
}

/**
 * يعيد معرّف جهة الاتصال: عميل موجود أو شخص/شركة جديدة. لا دمج تلقائي؛ إن وُجد جوال مطابق يُرفض الحفظ
 * ويُعاد السجل المطابق ليختار المستخدم السجل الصحيح أو يؤكد أنه شخص مختلف.
 */
function resolveContact(ctx: Ctx, input: { clientId: string | null; newContact: NewContact | null; confirmNewContact: boolean }): string {
  if (input.clientId) {
    requireClient(ctx, input.clientId, 'basic');
    return input.clientId;
  }
  const nc = input.newContact;
  if (!nc) throw new AppError('VALIDATION', 'اختر عميلًا موجودًا أو سجّل صاحب الموعد', { clientId: 'اختر صاحب الموعد أو سجّله' });
  if (!hasPerm(ctx, 'clients.create') && !hasPerm(ctx, 'consultations.manage')) throw forbidden('لا تملك صلاحية تسجيل جهات اتصال جديدة');
  if (!input.confirmNewContact) {
    const all = ctx.db.all<{ id: string; name: string; phone: string | null; kind: string; status: string }>('SELECT id, name, phone, kind, status FROM clients');
    const digits = nc.phone.replace(/\D/g, '');
    const samePhone = digits.length >= 7 ? all.filter((c) => (c.phone ?? '').replace(/\D/g, '').endsWith(digits.slice(-9))) : [];
    const similar = findSimilarClients(ctx, { name: nc.name, phone: null, idNumber: null, excludeId: null });
    if (samePhone.length) {
      // نُظهر السجلات المطابقة بالجوال حتى لو لم يكن للمستخدم وصول كامل لها، دون تفاصيل إضافية — لتجنب تكرار الشخص
      throw new AppError('DUPLICATE', 'يوجد سجل بالجوال نفسه. اختر السجل الصحيح أو أكّد أنه شخص مختلف.', { 'newContact.phone': 'جوال مطابق لسجل موجود' }, {
        matches: samePhone.slice(0, 5).map((c) => ({ id: c.id, name: c.name, phone: c.phone, kind: c.kind, reason: 'phone', selectable: clientAccess(ctx, c.id) !== 'none' })),
        similarNames: similar.slice(0, 5),
      });
    }
  }
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.run(
    `INSERT INTO clients (id, client_no, kind, name, phone, email, status, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [id, nextClientNo(ctx), nc.kind, nc.name, nc.phone, nc.email, ctx.user!.id, now, ctx.user!.id, now],
  );
  if (!isOwner(ctx)) grantClient(ctx, ctx.user!.id, id);
  logActivity(ctx, { action: 'create', entityType: 'client', entityId: id, clientId: id, summary: `تسجيل جهة اتصال (من الاستشارات والاجتماعات): ${nc.name}` });
  return id;
}

function recordChanges(ctx: Ctx, entityType: 'consultation' | 'meeting', entityId: string, changes: { field: string; old: unknown; new: unknown }[], reason: string | null) {
  const now = ctx.now().toISOString();
  for (const c of changes) {
    if (String(c.old ?? '') === String(c.new ?? '')) continue;
    ctx.db.run('INSERT INTO appointment_changes (id, entity_type, entity_id, field, old_value, new_value, reason, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      uuid(),
      entityType,
      entityId,
      c.field,
      c.old === null || c.old === undefined ? null : String(c.old),
      c.new === null || c.new === undefined ? null : String(c.new),
      reason,
      ctx.user!.id,
      now,
    ]);
  }
}

// ———————————————— التعارض ————————————————

export interface ConflictItem {
  kind: 'hearing' | 'consultation' | 'meeting';
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

/** مواعيد أخرى للمسؤول نفسه تتداخل مع الفترة. الجلسة تُعامل كفترة بطول الإعداد «مدة حجز الجلسة» لأن وقت نهايتها غير مسجل. */
export function findConflicts(ctx: Ctx, input: { responsibleUserId: string | null; startsAt: string; endsAt: string; excludeKind?: 'consultation' | 'meeting'; excludeId?: string | null }): ConflictItem[] {
  requireUser(ctx);
  if (!input.responsibleUserId) return [];
  const out: ConflictItem[] = [];
  const p = { uid: input.responsibleUserId, s: input.startsAt, e: input.endsAt, ex: input.excludeId ?? '' };
  for (const r of ctx.db.all<ApptBase>(
    `SELECT * FROM consultations WHERE responsible_user_id = :uid AND status NOT IN ('cancelled','no_show') AND starts_at < :e AND ends_at > :s ${input.excludeKind === 'consultation' ? 'AND id != :ex' : ''}`,
    p,
  ))
    out.push({ kind: 'consultation', id: r.id, label: canSee(ctx, 'consultations', r) ? `استشارة ${r.ref_no}: ${r.title}` : 'استشارة أخرى للمسؤول نفسه', startsAt: r.starts_at, endsAt: r.ends_at });
  for (const r of ctx.db.all<ApptBase>(
    `SELECT * FROM meetings WHERE responsible_user_id = :uid AND status NOT IN ('cancelled','postponed') AND starts_at < :e AND ends_at > :s ${input.excludeKind === 'meeting' ? 'AND id != :ex' : ''}`,
    p,
  ))
    out.push({ kind: 'meeting', id: r.id, label: canSee(ctx, 'meetings', r) ? `اجتماع ${r.ref_no}: ${r.title}` : 'اجتماع آخر للمسؤول نفسه', startsAt: r.starts_at, endsAt: r.ends_at });
  const block = Math.max(15, readSetting(ctx.db, 'appointments.hearingBlockMinutes')) * 60_000;
  const sMs = new Date(input.startsAt).getTime();
  const eMs = new Date(input.endsAt).getTime();
  for (const h of ctx.db.all<{ id: string; starts_at: string; case_id: string; title: string; file_no: string }>(
    `SELECT h.id, h.starts_at, h.case_id, c.title, c.file_no FROM hearings h JOIN cases c ON c.id = h.case_id
     WHERE h.status = 'scheduled' AND (c.responsible_user_id = :uid) AND h.starts_at < :e AND h.starts_at > :early`,
    { uid: input.responsibleUserId, e: input.endsAt, early: new Date(sMs - block).toISOString() },
  )) {
    const hs = new Date(h.starts_at).getTime();
    if (hs < eMs && hs + block > sMs)
      out.push({ kind: 'hearing', id: h.id, label: canAccessCase(ctx, h.case_id) ? `جلسة قضائية: ${h.title} (${h.file_no})` : 'جلسة قضائية للمسؤول نفسه', startsAt: h.starts_at, endsAt: new Date(hs + block).toISOString() });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function checkConflicts(ctx: Ctx, c: Parameters<typeof findConflicts>[1], confirmed: boolean): ConflictItem[] {
  const conflicts = findConflicts(ctx, c);
  if (conflicts.length && !confirmed) {
    throw new AppError(
      'CONFLICT',
      `يتعارض هذا الموعد مع ${conflicts.length === 1 ? 'موعد آخر' : conflicts.length + ' مواعيد أخرى'} للمسؤول نفسه. راجع التعارض وأكّد الاستمرار إن رغبت.`,
      undefined,
      { conflicts },
    );
  }
  return conflicts;
}

// ———————————————— المالية (سجل واحد لكل استشارة/اجتماع) ————————————————

export interface SvcFinance {
  mode: FeeMode;
  due: number | null;
  paid: number;
  refunded: number;
  discounts: number;
  netPaid: number;
  remaining: number | null;
  credited: number;
  status: PayStatus;
}

export function svcFinance(ctx: Ctx, kind: 'consultation' | 'meeting', id: string, asOf?: string | null): SvcFinance {
  let mode: FeeMode;
  let due: number | null;
  if (kind === 'consultation') {
    const r = ctx.db.get<{ fee_mode: FeeMode; fee_amount: number | null }>('SELECT fee_mode, fee_amount FROM consultations WHERE id = ?', [id])!;
    mode = r.fee_mode;
    due = r.fee_mode === 'paid' ? r.fee_amount : r.fee_mode === 'free' ? 0 : null;
  } else {
    const r = ctx.db.get<{ fee_amount: number | null }>('SELECT fee_amount FROM meetings WHERE id = ?', [id])!;
    mode = r.fee_amount ? 'paid' : 'free';
    due = r.fee_amount ?? 0;
  }
  const col = kind === 'consultation' ? 'consultation_id' : 'meeting_id';
  const sums = ctx.db.all<{ kind: SvcTxnKind; s: number }>(
    `SELECT kind, sum(amount) AS s FROM service_txns WHERE ${col} = ? AND voided = 0 ${asOf ? 'AND txn_on <= ?' : ''} GROUP BY kind`,
    asOf ? [id, asOf] : [id],
  );
  const get = (k: SvcTxnKind) => sums.find((x) => x.kind === k)?.s ?? 0;
  const paid = get('payment');
  const refunded = get('refund');
  const discounts = get('discount');
  const netPaid = paid - refunded;
  const credited =
    kind === 'consultation'
      ? ctx.db.get<{ s: number | null }>("SELECT sum(amount) AS s FROM contract_adjustments WHERE consultation_id = ? AND kind = 'consultation_credit' AND voided = 0", [id])!.s ?? 0
      : 0;
  let remaining: number | null = null;
  let status: PayStatus;
  if (due === null) {
    status = netPaid > 0 ? 'partial' : 'not_set';
  } else {
    remaining = due - discounts - netPaid;
    if (mode === 'free' && netPaid <= 0) status = 'free';
    else if (remaining < 0) status = 'overpaid';
    else if (remaining === 0) status = due === 0 && netPaid === 0 ? 'free' : 'paid';
    else status = netPaid > 0 ? 'partial' : 'unpaid';
  }
  return { mode, due, paid, refunded, discounts, netPaid, remaining, credited, status };
}

function listTxns(ctx: Ctx, col: 'consultation_id' | 'meeting_id', id: string) {
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT t.*, u.display_name AS by_name, (SELECT d.id FROM documents d WHERE d.service_txn_id = t.id AND d.archived_at IS NULL LIMIT 1) AS receipt_document_id
       FROM service_txns t LEFT JOIN users u ON u.id = t.created_by WHERE t.${col} = ? ORDER BY t.txn_on DESC, t.created_at DESC`,
      [id],
    )
    .map((t) => ({
      id: String(t.id),
      kind: t.kind as SvcTxnKind,
      amount: Number(t.amount),
      txnOn: String(t.txn_on),
      method: t.method as string | null,
      referenceNo: t.reference_no as string | null,
      reason: t.reason as string | null,
      notes: t.notes as string | null,
      voided: !!t.voided,
      voidReason: t.void_reason as string | null,
      byName: t.by_name as string | null,
      receiptDocumentId: t.receipt_document_id as string | null,
    }));
}

export function createServiceTxn(
  ctx: Ctx,
  input: { consultationId: string | null; meetingId: string | null; kind: SvcTxnKind; amount: number; txnOn: string; method: string | null; referenceNo: string | null; reason: string | null; notes: string | null },
) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تسجيل الدفعات');
  if (!!input.consultationId === !!input.meetingId) throw new AppError('VALIDATION', 'حدد الاستشارة أو الاجتماع');
  if ((input.kind === 'refund' || input.kind === 'discount') && !input.reason) throw new AppError('VALIDATION', 'اذكر سبب الاسترداد أو التسوية', { reason: 'السبب مطلوب' });
  let clientId: string | null;
  let label: string;
  if (input.consultationId) {
    const c = requireConsultation(ctx, input.consultationId);
    clientId = c.client_id;
    label = `الاستشارة ${c.ref_no}`;
    if ((c as unknown as { fee_mode: string }).fee_mode === 'unset' && input.kind !== 'payment') throw new AppError('VALIDATION', 'حدد مبلغ الاستشارة أولًا');
  } else {
    const m = requireMeeting(ctx, input.meetingId!);
    if (!(m as unknown as { fee_amount: number | null }).fee_amount) throw new AppError('VALIDATION', 'الاجتماع غير مدفوع. أضف له مقابلًا ماليًا أولًا لتسجيل دفعة عليه.');
    clientId = m.client_id;
    label = `الاجتماع ${m.ref_no}`;
  }
  if (input.kind === 'refund') {
    const f = svcFinance(ctx, input.consultationId ? 'consultation' : 'meeting', (input.consultationId ?? input.meetingId)!);
    if (input.amount > f.netPaid) throw new AppError('VALIDATION', `مبلغ الاسترداد أكبر من صافي المبالغ المستلمة (${fmtAmount(f.netPaid)})`, { amount: 'أكبر من المستلم' });
  }
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO service_txns (id, consultation_id, meeting_id, client_id, kind, amount, txn_on, method, reference_no, reason, notes, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.consultationId, input.meetingId, clientId, input.kind, input.amount, input.txnOn, input.method, input.referenceNo, input.reason, input.notes, ctx.user!.id, now, ctx.user!.id, now],
    );
    logActivity(ctx, {
      action: 'create',
      entityType: input.consultationId ? 'consultation' : 'meeting',
      entityId: input.consultationId ?? input.meetingId,
      clientId,
      summary: `${SVC_TXN_KINDS[input.kind].label} ${fmtAmount(input.amount)} على ${label} بتاريخ ${input.txnOn}${input.reason ? ' — السبب: ' + input.reason : ''}`,
    });
  });
  return { id, finance: svcFinance(ctx, input.consultationId ? 'consultation' : 'meeting', (input.consultationId ?? input.meetingId)!) };
}

export function voidServiceTxn(ctx: Ctx, input: { id: string; reason: string }) {
  requirePerm(ctx, 'fees.manage');
  const t = ctx.db.get<{ consultation_id: string | null; meeting_id: string | null; client_id: string | null; amount: number; kind: SvcTxnKind; voided: number }>('SELECT * FROM service_txns WHERE id = ?', [input.id]);
  if (!t) throw notFound('الحركة المالية');
  if (t.consultation_id) requireConsultation(ctx, t.consultation_id);
  else requireMeeting(ctx, t.meeting_id!);
  if (t.voided) return { ok: true };
  if (t.kind === 'payment' && t.consultation_id) {
    const f = svcFinance(ctx, 'consultation', t.consultation_id);
    if (f.credited > 0 && f.netPaid - t.amount < f.credited)
      throw new AppError('CONFLICT', 'هذه الدفعة محتسبة ضمن أتعاب قضية (تسوية مرتبطة). ألغِ التسوية من عقد القضية أولًا.');
  }
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE service_txns SET voided = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.reason, now, ctx.user!.id, ctx.user!.id, now, input.id]);
    logActivity(ctx, { action: 'void', entityType: t.consultation_id ? 'consultation' : 'meeting', entityId: t.consultation_id ?? t.meeting_id, clientId: t.client_id, summary: `إلغاء ${SVC_TXN_KINDS[t.kind].label} ${fmtAmount(t.amount)}: ${input.reason}` });
  });
  return { ok: true };
}

// ———————————————— التنبيهات ————————————————

function offsetLabel(off: number) {
  return off >= 1440 && off % 1440 === 0 ? `قبل ${off / 1440 === 1 ? 'يوم' : off / 1440 + ' أيام'}` : off >= 60 && off % 60 === 0 ? `قبل ${off / 60} ساعة` : `قبل ${off} دقيقة`;
}

export function syncApptReminders(ctx: Ctx, kind: 'consultation' | 'meeting', id: string) {
  clearReminders(ctx, kind, id);
  if (!readSetting(ctx.db, 'reminders.enabled')) return;
  const table = kind === 'consultation' ? 'consultations' : 'meetings';
  const r = ctx.db.get<{ starts_at: string; status: string; title: string; ref_no: string; case_id: string | null }>(`SELECT starts_at, status, title, ref_no, case_id FROM ${table} WHERE id = ?`, [id]);
  if (!r || !['pending', 'confirmed'].includes(r.status)) return;
  const t = new Date(r.starts_at).getTime();
  for (const off of [...new Set(readSetting(ctx.db, 'reminders.hearingOffsets'))]) {
    const remindAt = new Date(t - off * 60_000);
    if (remindAt.getTime() <= ctx.now().getTime()) continue;
    ctx.db.run('INSERT INTO reminders (id, entity_type, entity_id, case_id, remind_at, event_at, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      uuid(),
      kind,
      id,
      r.case_id,
      remindAt.toISOString(),
      r.starts_at,
      `${kind === 'consultation' ? 'استشارة' : 'اجتماع'} ${r.ref_no}: ${r.title} — ${fmtDateTime(r.starts_at)} — تذكير ${offsetLabel(off)}`,
      ctx.now().toISOString(),
    ]);
  }
}

// ———————————————— الاستشارات ————————————————

export interface ConsultationInput {
  clientId: string | null;
  newContact: NewContact | null;
  confirmNewContact: boolean;
  caseId: string | null;
  title: string;
  category: string | null;
  description: string | null;
  questions: string | null;
  method: ApptMethod;
  date: string;
  time: string;
  durationMin: number;
  location: string | null;
  meetingLink: string | null;
  responsibleUserId: string | null;
  feeMode: FeeMode;
  feeAmount: number | null;
  status: ConsultStatus;
  statusReason: string | null;
  writtenRequired: boolean;
  internalNotes: string | null;
  confirmConflicts: boolean;
}

function validateConsultation(ctx: Ctx, i: ConsultationInput, clientId: string) {
  const errs: Record<string, string> = {};
  if (i.feeMode === 'paid' && (i.feeAmount === null || i.feeAmount <= 0)) errs.feeAmount = 'أدخل مبلغ الاستشارة، أو اختر «مجانية»';
  if ((i.status === 'cancelled' || i.status === 'no_show') && !i.statusReason) errs.statusReason = 'اذكر السبب';
  if (i.caseId) {
    const c = requireCase(ctx, i.caseId);
    if (c.client_id !== clientId) errs.caseId = 'القضية لا تتبع صاحب الاستشارة';
  }
  validateUser(ctx, i.responsibleUserId);
  if (Object.keys(errs).length) throw new AppError('VALIDATION', 'تحقق من بيانات الاستشارة', errs);
}

function feeParams(ctx: Ctx, i: ConsultationInput, existing?: { fee_mode: FeeMode; fee_amount: number | null }) {
  // من لا يملك صلاحية إدارة الأتعاب لا يغيّر المبلغ (يبقى كما هو أو «غير محدد»)
  if (!hasPerm(ctx, 'fees.manage')) return { fee_mode: existing?.fee_mode ?? 'unset', fee_amount: existing?.fee_amount ?? null };
  return { fee_mode: i.feeMode, fee_amount: i.feeMode === 'paid' ? i.feeAmount : i.feeMode === 'free' ? 0 : null };
}

export function createConsultation(ctx: Ctx, input: ConsultationInput) {
  requireManage(ctx);
  const startsAt = riyadhToUtcIso(input.date, input.time);
  const endsAt = new Date(new Date(startsAt).getTime() + input.durationMin * 60_000).toISOString();
  let id = '';
  let ref = '';
  let conflicts: ConflictItem[] = [];
  ctx.db.tx(() => {
    const clientId = resolveContact(ctx, input);
    validateConsultation(ctx, input, clientId);
    conflicts = checkConflicts(ctx, { responsibleUserId: input.responsibleUserId, startsAt, endsAt }, input.confirmConflicts);
    id = uuid();
    ref = nextRef(ctx, 'CON', 'consultations');
    const now = ctx.now().toISOString();
    const fee = feeParams(ctx, input);
    ctx.db.run(
      `INSERT INTO consultations (id, ref_no, client_id, case_id, title, category, description, questions, method, starts_at, duration_min, ends_at, location, meeting_link,
         responsible_user_id, fee_mode, fee_amount, status, status_reason, written_required, internal_notes, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :ref, :client_id, :case_id, :title, :category, :description, :questions, :method, :starts_at, :duration, :ends_at, :location, :link,
         :resp, :fee_mode, :fee_amount, :status, :status_reason, :written, :notes, :uid, :now, :uid, :now)`,
      {
        id,
        ref,
        client_id: clientId,
        case_id: input.caseId,
        title: input.title,
        category: input.category,
        description: input.description,
        questions: input.questions,
        method: input.method,
        starts_at: startsAt,
        duration: input.durationMin,
        ends_at: endsAt,
        location: input.location,
        link: input.meetingLink,
        resp: input.responsibleUserId,
        ...fee,
        status: input.status,
        status_reason: input.statusReason,
        written: input.writtenRequired,
        notes: input.internalNotes,
        uid: ctx.user!.id,
        now,
      },
    );
    syncApptReminders(ctx, 'consultation', id);
    logActivity(ctx, {
      action: 'create',
      entityType: 'consultation',
      entityId: id,
      clientId,
      caseId: input.caseId,
      summary: `إضافة استشارة ${ref}: ${input.title} (${APPT_METHODS[input.method].label}) — ${fmtDateTime(startsAt)}${fee.fee_mode === 'free' ? ' — مجانية' : fee.fee_amount ? ' — ' + fmtAmount(fee.fee_amount) : ''}${conflicts.length ? ' — مع تأكيد تعارض موعد' : ''}`,
    });
  });
  return { id, refNo: ref, conflicts };
}

export function updateConsultation(ctx: Ctx, input: ConsultationInput & { id: string; changeReason: string | null }) {
  requireManage(ctx);
  const old = requireConsultation(ctx, input.id) as unknown as Record<string, unknown> & ApptBase & { fee_mode: FeeMode; fee_amount: number | null; method: string; duration_min: number };
  const clientId = old.client_id!;
  if (input.clientId && input.clientId !== clientId) throw new AppError('VALIDATION', 'لا يمكن نقل الاستشارة لشخص آخر بعد تسجيلها', { clientId: 'صاحب الاستشارة ثابت' });
  validateConsultation(ctx, input, clientId);
  const startsAt = riyadhToUtcIso(input.date, input.time);
  const endsAt = new Date(new Date(startsAt).getTime() + input.durationMin * 60_000).toISOString();
  const timeChanged = startsAt !== old.starts_at || endsAt !== old.ends_at || input.responsibleUserId !== old.responsible_user_id;
  const active = !['cancelled', 'no_show'].includes(input.status);
  const conflicts = timeChanged && active ? checkConflicts(ctx, { responsibleUserId: input.responsibleUserId, startsAt, endsAt, excludeKind: 'consultation', excludeId: input.id }, input.confirmConflicts) : [];
  const fee = feeParams(ctx, input, old);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE consultations SET case_id = :case_id, title = :title, category = :category, description = :description, questions = :questions, method = :method,
         starts_at = :starts_at, duration_min = :duration, ends_at = :ends_at, location = :location, meeting_link = :link, responsible_user_id = :resp,
         fee_mode = :fee_mode, fee_amount = :fee_amount, status = :status, status_reason = :status_reason, written_required = :written, internal_notes = :notes,
         updated_by = :uid, updated_at = :now WHERE id = :id`,
      {
        id: input.id,
        case_id: input.caseId,
        title: input.title,
        category: input.category,
        description: input.description,
        questions: input.questions,
        method: input.method,
        starts_at: startsAt,
        duration: input.durationMin,
        ends_at: endsAt,
        location: input.location,
        link: input.meetingLink,
        resp: input.responsibleUserId,
        ...fee,
        status: input.status,
        status_reason: input.statusReason,
        written: input.writtenRequired,
        notes: input.internalNotes,
        uid: ctx.user!.id,
        now: ctx.now().toISOString(),
      },
    );
    recordChanges(
      ctx,
      'consultation',
      input.id,
      [
        { field: 'الموعد', old: fmtDateTime(old.starts_at), new: fmtDateTime(startsAt) },
        { field: 'المدة بالدقائق', old: old.duration_min, new: input.durationMin },
        { field: 'الحالة', old: CONSULT_STATUSES[old.status as ConsultStatus]?.label, new: CONSULT_STATUSES[input.status].label },
        { field: 'الطريقة', old: APPT_METHODS[old.method as ApptMethod]?.label, new: APPT_METHODS[input.method].label },
        { field: 'المسؤول', old: userName(ctx, old.responsible_user_id), new: userName(ctx, input.responsibleUserId) },
        { field: 'المبلغ', old: old.fee_mode === 'free' ? 'مجانية' : fmtAmount(old.fee_amount), new: fee.fee_mode === 'free' ? 'مجانية' : fmtAmount(fee.fee_amount) },
      ],
      input.changeReason ?? input.statusReason,
    );
    syncApptReminders(ctx, 'consultation', input.id);
    logActivity(ctx, {
      action: old.status !== input.status ? 'status' : timeChanged ? 'reschedule' : 'update',
      entityType: 'consultation',
      entityId: input.id,
      clientId,
      caseId: input.caseId,
      summary: `تعديل الاستشارة ${old.ref_no}${old.status !== input.status ? ' — الحالة: ' + CONSULT_STATUSES[input.status].label : ''}${timeChanged ? ' — الموعد: ' + fmtDateTime(startsAt) : ''}${conflicts.length ? ' — مع تأكيد تعارض موعد' : ''}`,
    });
  });
  return { ok: true, conflicts };
}

function userName(ctx: Ctx, id: string | null | undefined): string | null {
  if (!id) return null;
  return ctx.db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [id])?.display_name ?? null;
}

const CONSULT_SELECT = `SELECT k.*, cl.name AS client_name, cl.kind AS client_kind, cl.phone AS client_phone, cl.email AS client_email,
  ru.display_name AS responsible_name, ca.file_no AS case_file_no, ca.title AS case_title
  FROM consultations k JOIN clients cl ON cl.id = k.client_id LEFT JOIN users ru ON ru.id = k.responsible_user_id LEFT JOIN cases ca ON ca.id = k.case_id`;

function mapConsultation(ctx: Ctx, r: Record<string, string | number | null>, canFees: boolean) {
  const s = utcIsoToRiyadh(String(r.starts_at));
  const e = utcIsoToRiyadh(String(r.ends_at));
  const opinion = ctx.db.get<{ n: number; latest_status: string | null; delivered_on: string | null }>(
    `SELECT count(*) AS n, (SELECT status FROM consultation_opinions WHERE consultation_id = :id ORDER BY updated_at DESC LIMIT 1) AS latest_status,
       (SELECT max(delivered_on) FROM consultation_opinions WHERE consultation_id = :id) AS delivered_on FROM consultation_opinions WHERE consultation_id = :id`,
    { id: r.id },
  )!;
  return {
    id: String(r.id),
    refNo: String(r.ref_no),
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    clientKind: r.client_kind as ClientKind,
    clientPhone: r.client_phone as string | null,
    clientEmail: r.client_email as string | null,
    clientAccessible: clientAccess(ctx, String(r.client_id)) !== 'none',
    caseId: r.case_id as string | null,
    caseFileNo: r.case_file_no as string | null,
    caseTitle: r.case_title as string | null,
    title: String(r.title),
    category: r.category as string | null,
    description: r.description as string | null,
    questions: r.questions as string | null,
    method: r.method as ApptMethod,
    startsAt: String(r.starts_at),
    endsAt: String(r.ends_at),
    date: s.date,
    time: s.time,
    endTime: e.time,
    durationMin: Number(r.duration_min),
    location: r.location as string | null,
    meetingLink: r.meeting_link as string | null,
    responsibleUserId: r.responsible_user_id as string | null,
    responsibleName: r.responsible_name as string | null,
    status: r.status as ConsultStatus,
    statusReason: r.status_reason as string | null,
    writtenRequired: !!r.written_required,
    internalNotes: r.internal_notes as string | null,
    opinionCount: opinion.n,
    opinionStatus: opinion.latest_status as OpinionStatus | null,
    deliveredOn: opinion.delivered_on,
    amountsHidden: !canFees,
    finance: canFees ? svcFinance(ctx, 'consultation', String(r.id)) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export type ConsultationView = ReturnType<typeof mapConsultation>;

export interface ApptListInput {
  q?: string | null;
  from?: string | null;
  to?: string | null;
  responsibleUserId?: string | null;
  method?: ApptMethod | null;
  status?: string | null;
  payStatus?: PayStatus | null;
  clientId?: string | null;
  caseId?: string | null;
}

export function listConsultations(ctx: Ctx, input: ApptListInput) {
  requireUser(ctx);
  const scope = apptScope(ctx, 'consultations', 'k');
  const where = [scope.sql];
  const p: Record<string, unknown> = { ...scope.params };
  if (input.from) {
    where.push('k.starts_at >= :from');
    p.from = riyadhToUtcIso(input.from, '00:00');
  }
  if (input.to) {
    where.push('k.starts_at < :to');
    p.to = riyadhToUtcIso(addDays(input.to, 1), '00:00');
  }
  for (const [col, key, v] of [
    ['k.responsible_user_id', 'resp', input.responsibleUserId],
    ['k.method', 'method', input.method],
    ['k.status', 'status', input.status],
    ['k.client_id', 'clientId', input.clientId],
    ['k.case_id', 'caseId', input.caseId],
  ] as const) {
    if (v) {
      where.push(`${col} = :${key}`);
      p[key] = v;
    }
  }
  searchTokens(input.q ?? '').forEach((t, i) => {
    where.push(
      `(arnorm(k.title) LIKE :q${i} ESCAPE '\\' OR arnorm(cl.name) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(cl.phone,'')) LIKE :q${i} ESCAPE '\\' OR arnorm(k.ref_no) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(k.category,'')) LIKE :q${i} ESCAPE '\\')`,
    );
    p[`q${i}`] = `%${likeEscape(t)}%`;
  });
  const canFees = hasPerm(ctx, 'fees.view');
  let rows = ctx.db.all<Record<string, string | number | null>>(`${CONSULT_SELECT} WHERE ${where.join(' AND ')} ORDER BY k.starts_at DESC LIMIT 3000`, p).map((r) => mapConsultation(ctx, r, canFees));
  if (input.payStatus) {
    if (!canFees) throw forbidden('التصفية بحالة السداد تتطلب صلاحية الاطلاع على الأتعاب');
    rows = rows.filter((r) => r.finance?.status === input.payStatus);
  }
  return rows;
}

export function getConsultation(ctx: Ctx, input: { id: string }) {
  requireConsultation(ctx, input.id);
  const canFees = hasPerm(ctx, 'fees.view');
  const r = ctx.db.get<Record<string, string | number | null>>(`${CONSULT_SELECT} WHERE k.id = ?`, [input.id])!;
  const c = mapConsultation(ctx, r, canFees);
  return {
    consultation: c,
    opinions: listOpinions(ctx, input.id),
    transactions: canFees ? listTxns(ctx, 'consultation_id', input.id) : [],
    credits: canFees
      ? ctx.db
          .all<{ id: string; contract_id: string; title: string; amount: number; adjusted_on: string; reason: string; voided: number }>(
            `SELECT a.id, a.contract_id, k.title, a.amount, a.adjusted_on, a.reason, a.voided FROM contract_adjustments a JOIN contracts k ON k.id = a.contract_id WHERE a.consultation_id = ? ORDER BY a.adjusted_on`,
            [input.id],
          )
          .map((a) => ({ id: a.id, contractId: a.contract_id, contractTitle: a.title, amount: a.amount, adjustedOn: a.adjusted_on, reason: a.reason, voided: !!a.voided }))
      : [],
    changes: apptChanges(ctx, 'consultation', input.id),
    meetings: ctx.db
      .all<{ id: string; ref_no: string; title: string; starts_at: string; status: string }>('SELECT id, ref_no, title, starts_at, status FROM meetings WHERE consultation_id = ? ORDER BY starts_at', [input.id])
      .map((m) => ({ id: m.id, refNo: m.ref_no, title: m.title, startsAt: m.starts_at, status: m.status as MeetingStatus })),
    tasks: ctx.db
      .all<{ id: string; title: string; status: string; due_date: string | null }>('SELECT id, title, status, due_date FROM tasks WHERE consultation_id = ? ORDER BY due_date', [input.id])
      .map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.due_date })),
    activity: apptActivity(ctx, 'consultation', input.id),
  };
}

function apptChanges(ctx: Ctx, kind: 'consultation' | 'meeting', id: string) {
  return ctx.db
    .all<{ id: string; field: string; old_value: string | null; new_value: string | null; reason: string | null; changed_at: string; by_name: string | null }>(
      `SELECT a.*, u.display_name AS by_name FROM appointment_changes a LEFT JOIN users u ON u.id = a.changed_by WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.changed_at DESC`,
      [kind, id],
    )
    .map((c) => ({ id: c.id, field: c.field, oldValue: c.old_value, newValue: c.new_value, reason: c.reason, changedAt: c.changed_at, byName: c.by_name }));
}

function apptActivity(ctx: Ctx, kind: 'consultation' | 'meeting', id: string) {
  const canFees = hasPerm(ctx, 'fees.view');
  return ctx.db
    .all<{ id: string; at: string; username: string | null; action: string; summary: string; entity_type: string }>(
      `SELECT id, at, username, action, summary, entity_type FROM activity_log WHERE (entity_type = ? AND entity_id = ?)
         OR (entity_type = 'document' AND entity_id IN (SELECT id FROM documents WHERE ${kind === 'consultation' ? 'consultation_id' : 'meeting_id'} = ?))
       ORDER BY at DESC LIMIT 300`,
      [kind, id, id],
    )
    // الحركات المالية تظهر في السجل لمن يملك صلاحية الأتعاب فقط
    .filter((a) => canFees || !/ر\.س/.test(a.summary))
    .map((a) => ({ id: a.id, at: a.at, username: a.username, action: a.action, summary: a.summary }));
}

/** ربط الاستشارة بقضية (للشخص نفسه) دون تكرار بياناته أو مبالغه؛ ويمكن احتساب مبلغها المسدد من أتعاب القضية كتسوية مرتبطة. */
export function linkConsultationCase(ctx: Ctx, input: { id: string; caseId: string | null; credit: { contractId: string; amount: number; reason: string; adjustedOn: string } | null }) {
  requireManage(ctx);
  const c = requireConsultation(ctx, input.id);
  if (input.caseId) {
    const k = requireCase(ctx, input.caseId);
    if (k.client_id !== c.client_id) throw new AppError('VALIDATION', 'القضية لا تتبع صاحب الاستشارة. افتح القضية لنفس الشخص حتى لا يتكرر.', { caseId: 'اختيار غير صالح' });
  }
  ctx.db.tx(() => {
    ctx.db.run('UPDATE consultations SET case_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.caseId, ctx.user!.id, ctx.now().toISOString(), input.id]);
    recordChanges(ctx, 'consultation', input.id, [{ field: 'القضية المرتبطة', old: c.case_id ? caseLabel(ctx, c.case_id) : null, new: input.caseId ? caseLabel(ctx, input.caseId) : null }], null);
    logActivity(ctx, { action: 'update', entityType: 'consultation', entityId: input.id, clientId: c.client_id, caseId: input.caseId, summary: input.caseId ? `ربط الاستشارة ${c.ref_no} بالقضية ${caseLabel(ctx, input.caseId)}` : `فك ربط الاستشارة ${c.ref_no} بالقضية` });
    if (input.credit) creditConsultationToContract(ctx, { consultationId: input.id, ...input.credit });
  });
  return { ok: true };
}

function caseLabel(ctx: Ctx, caseId: string) {
  const k = ctx.db.get<{ file_no: string; title: string }>('SELECT file_no, title FROM cases WHERE id = ?', [caseId]);
  return k ? `${k.file_no} — ${k.title}` : caseId;
}

/** تسوية صريحة: يُحتسب ما سُدّد للاستشارة ضمن أتعاب عقد القضية (يُنقص المتبقي على العقد) دون أن يُحسب المبلغ المحصل مرتين. */
export function creditConsultationToContract(ctx: Ctx, input: { consultationId: string; contractId: string; amount: number; reason: string; adjustedOn: string }) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تسجيل التسويات المالية');
  const c = requireConsultation(ctx, input.consultationId);
  const k = ctx.db.get<{ client_id: string; title: string }>('SELECT client_id, title FROM contracts WHERE id = ?', [input.contractId]);
  if (!k || k.client_id !== c.client_id) throw new AppError('VALIDATION', 'العقد لا يتبع صاحب الاستشارة', { contractId: 'اختر عقد القضية' });
  const f = svcFinance(ctx, 'consultation', input.consultationId);
  const available = f.netPaid - f.credited;
  if (input.amount > available) throw new AppError('VALIDATION', `المبلغ أكبر من المسدد غير المحتسب للاستشارة (${fmtAmount(Math.max(available, 0))})`, { amount: 'المبلغ أكبر من المتاح' });
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO contract_adjustments (id, contract_id, client_id, kind, amount, adjusted_on, reason, consultation_id, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, 'consultation_credit', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.contractId, k.client_id, input.amount, input.adjustedOn, input.reason, input.consultationId, ctx.user!.id, now, ctx.user!.id, now],
    );
    logActivity(ctx, {
      action: 'create',
      entityType: 'contract_adjustment',
      entityId: id,
      clientId: k.client_id,
      summary: `احتساب ${fmtAmount(input.amount)} المسددة للاستشارة ${c.ref_no} من أتعاب «${k.title}» (تسوية مرتبطة — لا يُحسب المبلغ مرتين): ${input.reason}`,
    });
  });
  return { id, totals: contractTotals(ctx, input.contractId) };
}

// ———————————————— الاستشارة المكتوبة ————————————————

function listOpinions(ctx: Ctx, consultationId: string) {
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT o.*, u.display_name AS updated_by_name FROM consultation_opinions o LEFT JOIN users u ON u.id = o.updated_by WHERE o.consultation_id = ? ORDER BY o.created_at`,
      [consultationId],
    )
    .map((o) => ({
      id: String(o.id),
      title: String(o.title),
      opinionDate: o.opinion_date as string | null,
      authorName: o.author_name as string | null,
      status: o.status as OpinionStatus,
      body: o.body as string | null,
      revision: Number(o.revision),
      documentId: o.document_id as string | null,
      deliveredOn: o.delivered_on as string | null,
      deliveryMethod: o.delivery_method as string | null,
      deliveryNotes: o.delivery_notes as string | null,
      deliveryProofDocumentId: o.delivery_proof_document_id as string | null,
      updatedAt: String(o.updated_at),
      updatedByName: o.updated_by_name as string | null,
      revisions: ctx.db
        .all<{ id: string; revision: number; status: string; title: string; note: string | null; saved_at: string; by_name: string | null; len: number }>(
          `SELECT r.id, r.revision, r.status, r.title, r.note, r.saved_at, u.display_name AS by_name, length(coalesce(r.body,'')) AS len FROM opinion_revisions r LEFT JOIN users u ON u.id = r.saved_by
           WHERE r.opinion_id = ? ORDER BY r.revision DESC`,
          [o.id],
        )
        .map((r) => ({ id: r.id, revision: r.revision, status: r.status as OpinionStatus, title: r.title, note: r.note, savedAt: r.saved_at, byName: r.by_name, length: r.len })),
    }));
}

function requireOpinion(ctx: Ctx, id: string) {
  const o = ctx.db.get<{ id: string; consultation_id: string; title: string; status: OpinionStatus; body: string | null; revision: number; document_id: string | null; updated_at: string }>(
    'SELECT * FROM consultation_opinions WHERE id = ?',
    [id],
  );
  if (!o) throw notFound('الاستشارة المكتوبة');
  const c = requireConsultation(ctx, o.consultation_id);
  return { o, c };
}

function validateOpinionDoc(ctx: Ctx, consultationId: string, documentId: string | null, field: string) {
  if (!documentId) return;
  const d = ctx.db.get<{ consultation_id: string | null }>('SELECT consultation_id FROM documents WHERE id = ?', [documentId]);
  if (!d || d.consultation_id !== consultationId) throw new AppError('VALIDATION', 'المستند لا يتبع هذه الاستشارة', { [field]: 'اختر مستندًا مرفقًا بالاستشارة' });
}

export function createOpinion(ctx: Ctx, input: { consultationId: string; title: string; opinionDate: string | null; authorName: string | null; body: string | null; documentId: string | null; status: OpinionStatus }) {
  requireManage(ctx);
  const c = requireConsultation(ctx, input.consultationId);
  if (input.status === 'delivered') throw new AppError('VALIDATION', 'التسليم يُسجل بزر «تسجيل التسليم» مع التاريخ والطريقة', { status: 'اختر حالة أخرى' });
  if (!input.body && !input.documentId) throw new AppError('VALIDATION', 'اكتب نص الاستشارة أو أرفق ملفها (PDF أو Word)', { body: 'أدخل النص أو أرفق ملفًا' });
  validateOpinionDoc(ctx, input.consultationId, input.documentId, 'documentId');
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO consultation_opinions (id, consultation_id, title, opinion_date, author_name, status, body, revision, document_id, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [id, input.consultationId, input.title, input.opinionDate, input.authorName, input.status, input.body, input.documentId, ctx.user!.id, now, ctx.user!.id, now],
    );
    ctx.db.run('INSERT INTO opinion_revisions (id, opinion_id, revision, status, title, body, note, saved_by, saved_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)', [uuid(), id, input.status, input.title, input.body, 'النسخة الأولى', ctx.user!.id, now]);
    logActivity(ctx, { action: 'create', entityType: 'consultation', entityId: input.consultationId, clientId: c.client_id, summary: `إضافة استشارة مكتوبة للاستشارة ${c.ref_no}: ${input.title} (${OPINION_STATUSES[input.status].label})` });
  });
  return { id };
}

/** حفظ نسخة معدلة: النص السابق يبقى في سجل النسخ. المستشارة المسلّمة لا يُعدل نصها؛ تُضاف استشارة مكتوبة جديدة بدلًا من ذلك. */
export function updateOpinion(
  ctx: Ctx,
  input: { id: string; title: string; opinionDate: string | null; authorName: string | null; body: string | null; documentId: string | null; status: OpinionStatus; note: string | null; baseRevision: number },
) {
  requireManage(ctx);
  const { o, c } = requireOpinion(ctx, input.id);
  if (o.status === 'delivered') throw new AppError('CONFLICT', 'هذه الاستشارة المكتوبة سُلّمت للمستفيد، ولا يُعدل نصها. أضف نسخة معدلة جديدة كاستشارة مكتوبة مستقلة.');
  if (input.status === 'delivered') throw new AppError('VALIDATION', 'التسليم يُسجل بزر «تسجيل التسليم»', { status: 'اختر حالة أخرى' });
  if (o.revision !== input.baseRevision) throw new AppError('CONFLICT', 'عُدّلت هذه الاستشارة المكتوبة من مكان آخر بعد فتحها. أعد فتحها لتجنب فقد التعديلات.');
  if (!input.body && !input.documentId) throw new AppError('VALIDATION', 'اكتب نص الاستشارة أو أرفق ملفها', { body: 'أدخل النص أو أرفق ملفًا' });
  validateOpinionDoc(ctx, o.consultation_id, input.documentId, 'documentId');
  const now = ctx.now().toISOString();
  const next = o.revision + 1;
  ctx.db.tx(() => {
    ctx.db.run('UPDATE consultation_opinions SET title = ?, opinion_date = ?, author_name = ?, body = ?, document_id = ?, status = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = ?', [
      input.title,
      input.opinionDate,
      input.authorName,
      input.body,
      input.documentId,
      input.status,
      next,
      ctx.user!.id,
      now,
      input.id,
    ]);
    ctx.db.run('INSERT INTO opinion_revisions (id, opinion_id, revision, status, title, body, note, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uuid(), input.id, next, input.status, input.title, input.body, input.note, ctx.user!.id, now]);
    logActivity(ctx, {
      action: o.status !== input.status ? 'status' : 'version',
      entityType: 'consultation',
      entityId: o.consultation_id,
      clientId: c.client_id,
      summary: `حفظ النسخة ${next} من الاستشارة المكتوبة «${input.title}» (${OPINION_STATUSES[input.status].label}) — النسخ السابقة محفوظة`,
    });
  });
  return { ok: true, revision: next };
}

export function getOpinionRevision(ctx: Ctx, input: { id: string }) {
  const r = ctx.db.get<{ opinion_id: string; revision: number; status: string; title: string; body: string | null; note: string | null; saved_at: string }>('SELECT * FROM opinion_revisions WHERE id = ?', [input.id]);
  if (!r) throw notFound('النسخة');
  requireOpinion(ctx, r.opinion_id);
  return { revision: r.revision, status: r.status as OpinionStatus, title: r.title, body: r.body, note: r.note, savedAt: r.saved_at };
}

/** تسجيل التسليم يدويًا — الحفظ أو الاعتماد لا يعني التسليم. */
export function recordOpinionDelivery(ctx: Ctx, input: { id: string; deliveredOn: string; deliveryMethod: string; notes: string | null; proofDocumentId: string | null }) {
  requireManage(ctx);
  const { o, c } = requireOpinion(ctx, input.id);
  validateOpinionDoc(ctx, o.consultation_id, input.proofDocumentId, 'proofDocumentId');
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE consultation_opinions SET status = 'delivered', delivered_on = ?, delivery_method = ?, delivery_notes = ?, delivery_proof_document_id = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?",
      [input.deliveredOn, input.deliveryMethod, input.notes, input.proofDocumentId, ctx.user!.id, now, input.id],
    );
    ctx.db.run('INSERT INTO opinion_revisions (id, opinion_id, revision, status, title, body, note, saved_by, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      uuid(),
      input.id,
      o.revision + 1,
      'delivered',
      o.title,
      o.body,
      `تسجيل التسليم بتاريخ ${input.deliveredOn} — ${input.deliveryMethod}`,
      ctx.user!.id,
      now,
    ]);
    logActivity(ctx, { action: 'submission', entityType: 'consultation', entityId: o.consultation_id, clientId: c.client_id, summary: `تسليم الاستشارة المكتوبة «${o.title}» للمستفيد بتاريخ ${input.deliveredOn} (${input.deliveryMethod})` });
  });
  return { ok: true };
}

// ———————————————— الاجتماعات ————————————————

export interface Participant {
  name: string;
  role: string | null;
}

export interface MeetingInput {
  title: string;
  purpose: string | null;
  clientId: string | null;
  newContact: NewContact | null;
  confirmNewContact: boolean;
  caseId: string | null;
  consultationId: string | null;
  participants: Participant[];
  responsibleUserId: string | null;
  method: ApptMethod;
  date: string;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingLink: string | null;
  agenda: string | null;
  status: MeetingStatus;
  statusReason: string | null;
  minutes: string | null;
  feeAmount: number | null;
  confirmConflicts: boolean;
}

function meetingTimes(i: MeetingInput) {
  const startsAt = riyadhToUtcIso(i.date, i.startTime);
  const endsAt = riyadhToUtcIso(i.date, i.endTime);
  if (endsAt <= startsAt) throw new AppError('VALIDATION', 'وقت النهاية يجب أن يكون بعد وقت البداية', { endTime: 'بعد وقت البداية' });
  return { startsAt, endsAt };
}

function validateMeetingLinks(ctx: Ctx, i: MeetingInput, clientId: string | null) {
  if ((i.status === 'cancelled' || i.status === 'postponed') && !i.statusReason) throw new AppError('VALIDATION', 'اذكر السبب', { statusReason: 'اذكر السبب' });
  if (i.caseId) {
    const c = requireCase(ctx, i.caseId);
    if (clientId && c.client_id !== clientId) throw new AppError('VALIDATION', 'القضية لا تتبع الشخص أو الشركة المختارة', { caseId: 'اختيار غير صالح' });
  }
  if (i.consultationId) {
    const k = requireConsultation(ctx, i.consultationId);
    if (clientId && k.client_id !== clientId) throw new AppError('VALIDATION', 'الاستشارة لا تتبع الشخص أو الشركة المختارة', { consultationId: 'اختيار غير صالح' });
  }
  validateUser(ctx, i.responsibleUserId);
}

function meetingFee(ctx: Ctx, i: MeetingInput, existing?: number | null) {
  if (!hasPerm(ctx, 'fees.manage')) return existing ?? null;
  return i.feeAmount && i.feeAmount > 0 ? i.feeAmount : null;
}

export function createMeeting(ctx: Ctx, input: MeetingInput) {
  requireManage(ctx);
  const { startsAt, endsAt } = meetingTimes(input);
  let id = '';
  let ref = '';
  let conflicts: ConflictItem[] = [];
  ctx.db.tx(() => {
    let clientId = input.clientId || input.newContact ? resolveContact(ctx, input) : null;
    if (!clientId && input.caseId) clientId = requireCase(ctx, input.caseId).client_id;
    if (!clientId && input.consultationId) clientId = requireConsultation(ctx, input.consultationId).client_id;
    validateMeetingLinks(ctx, input, clientId);
    conflicts = checkConflicts(ctx, { responsibleUserId: input.responsibleUserId, startsAt, endsAt }, input.confirmConflicts);
    id = uuid();
    ref = nextRef(ctx, 'MTG', 'meetings');
    const now = ctx.now().toISOString();
    const fee = meetingFee(ctx, input);
    ctx.db.run(
      `INSERT INTO meetings (id, ref_no, title, purpose, client_id, case_id, consultation_id, participants, responsible_user_id, method, starts_at, ends_at, location, meeting_link,
         agenda, status, status_reason, minutes, fee_amount, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :ref, :title, :purpose, :client_id, :case_id, :consultation_id, :participants, :resp, :method, :starts_at, :ends_at, :location, :link,
         :agenda, :status, :status_reason, :minutes, :fee, :uid, :now, :uid, :now)`,
      {
        id,
        ref,
        title: input.title,
        purpose: input.purpose,
        client_id: clientId,
        case_id: input.caseId,
        consultation_id: input.consultationId,
        participants: JSON.stringify(input.participants),
        resp: input.responsibleUserId,
        method: input.method,
        starts_at: startsAt,
        ends_at: endsAt,
        location: input.location,
        link: input.meetingLink,
        agenda: input.agenda,
        status: input.status,
        status_reason: input.statusReason,
        minutes: input.minutes,
        fee,
        uid: ctx.user!.id,
        now,
      },
    );
    syncApptReminders(ctx, 'meeting', id);
    logActivity(ctx, {
      action: 'create',
      entityType: 'meeting',
      entityId: id,
      clientId,
      caseId: input.caseId,
      summary: `إضافة اجتماع ${ref}: ${input.title} — ${fmtDateTime(startsAt)}${fee ? ' — مقابل مالي ' + fmtAmount(fee) : ''}${conflicts.length ? ' — مع تأكيد تعارض موعد' : ''}`,
    });
  });
  return { id, refNo: ref, conflicts };
}

export function updateMeeting(ctx: Ctx, input: MeetingInput & { id: string; changeReason: string | null }) {
  requireManage(ctx);
  const old = requireMeeting(ctx, input.id) as unknown as ApptBase & { fee_amount: number | null; method: string; minutes: string | null };
  let clientId = old.client_id;
  const { startsAt, endsAt } = meetingTimes(input);
  ctx.db.tx(() => {
    if (!clientId && (input.clientId || input.newContact)) clientId = resolveContact(ctx, input);
    else if (input.clientId && input.clientId !== clientId) throw new AppError('VALIDATION', 'لا يمكن تغيير الشخص المرتبط بعد تسجيله', { clientId: 'الطرف ثابت' });
    validateMeetingLinks(ctx, input, clientId);
    const timeChanged = startsAt !== old.starts_at || endsAt !== old.ends_at || input.responsibleUserId !== old.responsible_user_id;
    const active = !['cancelled', 'postponed'].includes(input.status);
    const conflicts = timeChanged && active ? checkConflicts(ctx, { responsibleUserId: input.responsibleUserId, startsAt, endsAt, excludeKind: 'meeting', excludeId: input.id }, input.confirmConflicts) : [];
    const fee = meetingFee(ctx, input, old.fee_amount);
    if (!fee && old.fee_amount) {
      const f = svcFinance(ctx, 'meeting', input.id);
      if (f.paid > 0) throw new AppError('CONFLICT', 'على الاجتماع دفعات مسجلة. سجّل الاسترداد أو التسوية بدل حذف المقابل المالي.');
    }
    ctx.db.run(
      `UPDATE meetings SET title = :title, purpose = :purpose, client_id = :client_id, case_id = :case_id, consultation_id = :consultation_id, participants = :participants,
         responsible_user_id = :resp, method = :method, starts_at = :starts_at, ends_at = :ends_at, location = :location, meeting_link = :link, agenda = :agenda,
         status = :status, status_reason = :status_reason, minutes = :minutes, fee_amount = :fee, updated_by = :uid, updated_at = :now WHERE id = :id`,
      {
        id: input.id,
        title: input.title,
        purpose: input.purpose,
        client_id: clientId,
        case_id: input.caseId,
        consultation_id: input.consultationId,
        participants: JSON.stringify(input.participants),
        resp: input.responsibleUserId,
        method: input.method,
        starts_at: startsAt,
        ends_at: endsAt,
        location: input.location,
        link: input.meetingLink,
        agenda: input.agenda,
        status: input.status,
        status_reason: input.statusReason,
        minutes: input.minutes,
        fee,
        uid: ctx.user!.id,
        now: ctx.now().toISOString(),
      },
    );
    recordChanges(
      ctx,
      'meeting',
      input.id,
      [
        { field: 'الموعد', old: fmtDateTime(old.starts_at), new: fmtDateTime(startsAt) },
        { field: 'النهاية', old: fmtDateTime(old.ends_at), new: fmtDateTime(endsAt) },
        { field: 'الحالة', old: MEETING_STATUSES[old.status as MeetingStatus]?.label, new: MEETING_STATUSES[input.status].label },
        { field: 'المسؤول', old: userName(ctx, old.responsible_user_id), new: userName(ctx, input.responsibleUserId) },
        { field: 'المحضر', old: old.minutes ? 'مسجل' : 'غير مسجل', new: input.minutes ? (old.minutes && old.minutes !== input.minutes ? 'معدّل' : 'مسجل') : 'غير مسجل' },
      ],
      input.changeReason ?? input.statusReason,
    );
    syncApptReminders(ctx, 'meeting', input.id);
    logActivity(ctx, {
      action: old.status !== input.status ? 'status' : timeChanged ? 'reschedule' : 'update',
      entityType: 'meeting',
      entityId: input.id,
      clientId,
      caseId: input.caseId,
      summary: `تعديل الاجتماع ${old.ref_no}${old.status !== input.status ? ' — الحالة: ' + MEETING_STATUSES[input.status].label : ''}${timeChanged ? ' — الموعد: ' + fmtDateTime(startsAt) : ''}${conflicts.length ? ' — مع تأكيد تعارض موعد' : ''}`,
    });
  });
  return { ok: true };
}

const MEETING_SELECT = `SELECT m.*, cl.name AS client_name, cl.kind AS client_kind, cl.phone AS client_phone, ru.display_name AS responsible_name,
  ca.file_no AS case_file_no, ca.title AS case_title, k.ref_no AS consultation_ref, k.title AS consultation_title
  FROM meetings m LEFT JOIN clients cl ON cl.id = m.client_id LEFT JOIN users ru ON ru.id = m.responsible_user_id LEFT JOIN cases ca ON ca.id = m.case_id
  LEFT JOIN consultations k ON k.id = m.consultation_id`;

function parseParticipants(s: string | null): Participant[] {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string').map((x) => ({ name: String(x.name), role: x.role ? String(x.role) : null })) : [];
  } catch {
    return [];
  }
}

function mapMeeting(ctx: Ctx, r: Record<string, string | number | null>, canFees: boolean) {
  const s = utcIsoToRiyadh(String(r.starts_at));
  const e = utcIsoToRiyadh(String(r.ends_at));
  const items = ctx.db.get<{ n: number; tasks: number; open_tasks: number }>(
    `SELECT count(*) AS n, count(i.task_id) AS tasks, sum(CASE WHEN t.id IS NOT NULL AND t.status != 'done' THEN 1 ELSE 0 END) AS open_tasks
     FROM meeting_items i LEFT JOIN tasks t ON t.id = i.task_id WHERE i.meeting_id = ?`,
    [r.id],
  )!;
  return {
    id: String(r.id),
    refNo: String(r.ref_no),
    title: String(r.title),
    purpose: r.purpose as string | null,
    clientId: r.client_id as string | null,
    clientName: r.client_name as string | null,
    clientKind: r.client_kind as ClientKind | null,
    clientPhone: r.client_phone as string | null,
    clientAccessible: r.client_id ? clientAccess(ctx, String(r.client_id)) !== 'none' : false,
    caseId: r.case_id as string | null,
    caseFileNo: r.case_file_no as string | null,
    caseTitle: r.case_title as string | null,
    consultationId: r.consultation_id as string | null,
    consultationRef: r.consultation_ref as string | null,
    consultationTitle: r.consultation_title as string | null,
    participants: parseParticipants(r.participants as string | null),
    responsibleUserId: r.responsible_user_id as string | null,
    responsibleName: r.responsible_name as string | null,
    method: r.method as ApptMethod,
    startsAt: String(r.starts_at),
    endsAt: String(r.ends_at),
    date: s.date,
    startTime: s.time,
    endTime: e.time,
    location: r.location as string | null,
    meetingLink: r.meeting_link as string | null,
    agenda: r.agenda as string | null,
    status: r.status as MeetingStatus,
    statusReason: r.status_reason as string | null,
    minutes: r.minutes as string | null,
    hasMinutes: !!(r.minutes && String(r.minutes).trim()),
    itemCount: items.n,
    taskCount: items.tasks,
    openTaskCount: items.open_tasks ?? 0,
    isPaid: !!r.fee_amount,
    amountsHidden: !canFees,
    feeAmount: canFees ? (r.fee_amount as number | null) : null,
    finance: canFees && r.fee_amount ? svcFinance(ctx, 'meeting', String(r.id)) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export type MeetingView = ReturnType<typeof mapMeeting>;

export function listMeetings(ctx: Ctx, input: ApptListInput) {
  requireUser(ctx);
  const scope = apptScope(ctx, 'meetings', 'm');
  const where = [scope.sql];
  const p: Record<string, unknown> = { ...scope.params };
  if (input.from) {
    where.push('m.starts_at >= :from');
    p.from = riyadhToUtcIso(input.from, '00:00');
  }
  if (input.to) {
    where.push('m.starts_at < :to');
    p.to = riyadhToUtcIso(addDays(input.to, 1), '00:00');
  }
  for (const [col, key, v] of [
    ['m.responsible_user_id', 'resp', input.responsibleUserId],
    ['m.method', 'method', input.method],
    ['m.status', 'status', input.status],
    ['m.client_id', 'clientId', input.clientId],
    ['m.case_id', 'caseId', input.caseId],
  ] as const) {
    if (v) {
      where.push(`${col} = :${key}`);
      p[key] = v;
    }
  }
  searchTokens(input.q ?? '').forEach((t, i) => {
    where.push(
      `(arnorm(m.title) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(cl.name,'')) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(cl.phone,'')) LIKE :q${i} ESCAPE '\\' OR arnorm(m.ref_no) LIKE :q${i} ESCAPE '\\' OR arnorm(m.participants) LIKE :q${i} ESCAPE '\\' OR arnorm(coalesce(m.purpose,'')) LIKE :q${i} ESCAPE '\\')`,
    );
    p[`q${i}`] = `%${likeEscape(t)}%`;
  });
  const canFees = hasPerm(ctx, 'fees.view');
  let rows = ctx.db.all<Record<string, string | number | null>>(`${MEETING_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.starts_at DESC LIMIT 3000`, p).map((r) => mapMeeting(ctx, r, canFees));
  if (input.payStatus) {
    if (!canFees) throw forbidden('التصفية بحالة السداد تتطلب صلاحية الاطلاع على الأتعاب');
    rows = rows.filter((r) => (r.finance?.status ?? 'free') === input.payStatus);
  }
  return rows;
}

export function getMeeting(ctx: Ctx, input: { id: string }) {
  requireMeeting(ctx, input.id);
  const canFees = hasPerm(ctx, 'fees.view');
  const r = ctx.db.get<Record<string, string | number | null>>(`${MEETING_SELECT} WHERE m.id = ?`, [input.id])!;
  return {
    meeting: mapMeeting(ctx, r, canFees),
    items: ctx.db
      .all<Record<string, string | number | null>>(
        `SELECT i.*, t.title AS task_title, t.status AS task_status, t.due_date AS task_due, u.display_name AS task_assignee FROM meeting_items i
         LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN users u ON u.id = t.assignee_user_id WHERE i.meeting_id = ? ORDER BY i.sort_order, i.created_at`,
        [input.id],
      )
      .map((i) => ({
        id: String(i.id),
        kind: i.kind as MeetingItemKind,
        text: String(i.text),
        taskId: i.task_id as string | null,
        taskTitle: i.task_title as string | null,
        taskStatus: i.task_status as string | null,
        taskDueDate: i.task_due as string | null,
        taskAssignee: i.task_assignee as string | null,
      })),
    tasks: ctx.db
      .all<{ id: string; title: string; status: string; due_date: string | null; assignee: string | null }>(
        'SELECT t.id, t.title, t.status, t.due_date, u.display_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.meeting_id = ? ORDER BY t.due_date',
        [input.id],
      )
      .map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.due_date, assignee: t.assignee })),
    transactions: canFees ? listTxns(ctx, 'meeting_id', input.id) : [],
    changes: apptChanges(ctx, 'meeting', input.id),
    activity: apptActivity(ctx, 'meeting', input.id),
  };
}

export function saveMeetingItem(ctx: Ctx, input: { id: string | null; meetingId: string; kind: MeetingItemKind; text: string }) {
  requireManage(ctx);
  const m = requireMeeting(ctx, input.meetingId);
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ meeting_id: string }>('SELECT meeting_id FROM meeting_items WHERE id = ?', [id]);
      if (!ex || ex.meeting_id !== input.meetingId) throw notFound('البند');
      ctx.db.run('UPDATE meeting_items SET kind = ?, text = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.kind, input.text, ctx.user!.id, now, id]);
    } else {
      id = uuid();
      const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM meeting_items WHERE meeting_id = ?', [input.meetingId]);
      ctx.db.run('INSERT INTO meeting_items (id, meeting_id, kind, text, sort_order, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        input.meetingId,
        input.kind,
        input.text,
        (max?.m ?? 0) + 10,
        ctx.user!.id,
        now,
        ctx.user!.id,
        now,
      ]);
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'meeting', entityId: input.meetingId, clientId: m.client_id, summary: `${input.id ? 'تعديل' : 'إضافة'} بند في محضر الاجتماع ${m.ref_no}: ${input.text.slice(0, 80)}` });
  });
  return { id };
}

export function removeMeetingItem(ctx: Ctx, input: { id: string }) {
  requireManage(ctx);
  const it = ctx.db.get<{ meeting_id: string; text: string; task_id: string | null }>('SELECT meeting_id, text, task_id FROM meeting_items WHERE id = ?', [input.id]);
  if (!it) throw notFound('البند');
  const m = requireMeeting(ctx, it.meeting_id);
  if (it.task_id) throw new AppError('CONFLICT', 'حُوّل هذا البند إلى مهمة؛ لا يُحذف حفاظًا على الربط.');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM meeting_items WHERE id = ?', [input.id]);
    logActivity(ctx, { action: 'delete', entityType: 'meeting', entityId: it.meeting_id, clientId: m.client_id, summary: `حذف بند من محضر الاجتماع ${m.ref_no}: ${it.text.slice(0, 80)}` });
  });
  return { ok: true };
}

/** تحويل قرار أو توصية من المحضر إلى مهمة مرتبطة بالاجتماع مباشرة. */
export function meetingItemToTask(ctx: Ctx, input: { itemId: string; title: string; assigneeUserId: string | null; dueDate: string | null; priority: Priority }) {
  requireManage(ctx);
  const it = ctx.db.get<{ meeting_id: string; text: string; task_id: string | null }>('SELECT meeting_id, text, task_id FROM meeting_items WHERE id = ?', [input.itemId]);
  if (!it) throw notFound('البند');
  const m = requireMeeting(ctx, it.meeting_id);
  if (it.task_id) throw new AppError('CONFLICT', 'حُوّل هذا البند إلى مهمة مسبقًا');
  validateUser(ctx, input.assigneeUserId, 'assigneeUserId');
  if (input.assigneeUserId && !isOwner(ctx) && input.assigneeUserId !== ctx.user!.id) {
    const role = ctx.db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', [input.assigneeUserId])?.role;
    if (role !== 'owner') throw forbidden('إسناد المهام لمستشار آخر متاح لصاحب المكتب فقط');
  }
  const id = uuid();
  const now = ctx.now().toISOString();
  // القضية تُربط بالمهمة فقط إن كانت متاحة للمستخدم؛ الربط الأساسي بالاجتماع
  const caseId = m.case_id && canAccessCase(ctx, m.case_id) ? m.case_id : null;
  const clientId = caseId ? m.client_id : m.client_id && clientAccess(ctx, m.client_id) === 'full' ? m.client_id : null;
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO tasks (id, title, description, client_id, case_id, meeting_id, consultation_id, assignee_user_id, due_date, priority, status, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, input.title, `من محضر الاجتماع ${m.ref_no}: ${it.text}`, clientId, caseId, it.meeting_id, (m as unknown as { consultation_id: string | null }).consultation_id, input.assigneeUserId, input.dueDate, input.priority, ctx.user!.id, now, ctx.user!.id, now],
    );
    ctx.db.run('UPDATE meeting_items SET task_id = ?, updated_by = ?, updated_at = ? WHERE id = ?', [id, ctx.user!.id, now, input.itemId]);
    syncTaskReminder(ctx, id);
    logActivity(ctx, { action: 'create', entityType: 'task', entityId: id, clientId, caseId, summary: `تحويل بند من محضر الاجتماع ${m.ref_no} إلى مهمة: ${input.title}` });
  });
  return { id };
}

// ———————————————— لوحة القسم والتقويم ————————————————

export function appointmentsOverview(ctx: Ctx) {
  requireUser(ctx);
  const today = todayRiyadh(ctx.now());
  const nowIso = ctx.now().toISOString();
  const consult = listConsultations(ctx, {});
  const meetings = listMeetings(ctx, {});
  const isActiveC = (c: ConsultationView) => c.status === 'pending' || c.status === 'confirmed';
  const isActiveM = (m: MeetingView) => m.status === 'pending' || m.status === 'confirmed';
  const canFees = hasPerm(ctx, 'fees.view');
  return {
    today,
    todayItems: [
      ...consult.filter((c) => c.date === today && c.status !== 'cancelled').map((c) => ({ kind: 'consultation' as const, id: c.id, refNo: c.refNo, title: c.title, name: c.clientName, time: c.time, status: c.status as string })),
      ...meetings.filter((m) => m.date === today && m.status !== 'cancelled').map((m) => ({ kind: 'meeting' as const, id: m.id, refNo: m.refNo, title: m.title, name: m.clientName, time: m.startTime, status: m.status as string })),
    ].sort((a, b) => a.time.localeCompare(b.time)),
    counts: {
      today: consult.filter((c) => c.date === today && c.status !== 'cancelled').length + meetings.filter((m) => m.date === today && m.status !== 'cancelled').length,
      upcoming: consult.filter((c) => isActiveC(c) && c.startsAt >= nowIso).length + meetings.filter((m) => isActiveM(m) && m.startsAt >= nowIso).length,
      consultationsDone: consult.filter((c) => c.status === 'done').length,
      consultationsUnpaid: canFees ? consult.filter((c) => c.finance && ['unpaid', 'partial'].includes(c.finance.status)).length : null,
      unpaidAmount: canFees ? consult.reduce((s, c) => s + (c.finance && c.finance.remaining && c.finance.remaining > 0 ? c.finance.remaining : 0), 0) : null,
    },
  };
}

export interface ApptCalendarEvent {
  id: string;
  kind: 'consultation' | 'meeting';
  title: string;
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  refNo: string;
  clientId: string | null;
  clientName: string | null;
  caseId: string | null;
  status: string;
  responsible: string | null;
  method: ApptMethod;
}

export function apptCalendarEvents(ctx: Ctx, input: { from: string; to: string; clientId?: string | null; caseId?: string | null; responsibleUserId?: string | null }): ApptCalendarEvent[] {
  const f = { from: input.from, to: input.to, clientId: input.clientId, caseId: input.caseId, responsibleUserId: input.responsibleUserId };
  const out: ApptCalendarEvent[] = [];
  for (const c of listConsultations(ctx, f))
    out.push({ id: c.id, kind: 'consultation', title: `استشارة: ${c.title}`, date: c.date, time: c.time, startsAt: c.startsAt, endsAt: c.endsAt, refNo: c.refNo, clientId: c.clientId, clientName: c.clientName, caseId: c.caseId, status: c.status, responsible: c.responsibleName, method: c.method });
  for (const m of listMeetings(ctx, f))
    out.push({ id: m.id, kind: 'meeting', title: `اجتماع: ${m.title}`, date: m.date, time: m.startTime, startsAt: m.startsAt, endsAt: m.endsAt, refNo: m.refNo, clientId: m.clientId, clientName: m.clientName, caseId: m.caseId, status: m.status, responsible: m.responsibleName, method: m.method });
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** هل التذكير مرئي للمستخدم؟ (التذكيرات غير المرتبطة بقضية للاستشارات والاجتماعات تتبع صلاحية الموعد). */
export function reminderVisible(ctx: Ctx, entityType: string, entityId: string): boolean {
  if (entityType !== 'consultation' && entityType !== 'meeting') return true;
  const r = ctx.db.get<ApptBase>(`SELECT * FROM ${entityType === 'consultation' ? 'consultations' : 'meetings'} WHERE id = ?`, [entityId]);
  return !!r && canSee(ctx, entityType === 'consultation' ? 'consultations' : 'meetings', r);
}
