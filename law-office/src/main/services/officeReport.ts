// التقرير الشامل الداخلي للمكتب: يجمع العملاء والقضايا والاستشارات والاجتماعات والوضع المالي من السجلات الفعلية فقط.
// كل رقم يُذكر أساسه الزمني. ما لم يُسجل يظهر «غير مسجل» لا صفرًا. الصلاحيات تُطبق على البيانات نفسها قبل أي تجميع،
// فلا تتسرب بيانات عملاء غير مسموح بهم عبر الإجماليات أو ملفات التصدير.
import fs from 'node:fs';
import type { Ctx } from '../context';
import { AppError, forbidden } from '../errors';
import { escapeHtml as e } from '../../shared/text';
import { fmtAmount } from '../../shared/money';
import { addDays, diffDays, fmtDate, fmtDateTime, riyadhToUtcIso, todayRiyadh, utcIsoToRiyadh } from '../../shared/dates';
import {
  ADJUSTMENT_KINDS,
  APPT_METHODS,
  CASE_STATUSES,
  CLIENT_KINDS,
  CLIENT_RELATIONS,
  CONSULT_STATUSES,
  FOLLOW_STATUSES,
  MEETING_STATUSES,
  OPINION_STATUSES,
  PAY_STATUSES,
  SVC_TXN_KINDS,
  labelOf,
  type ClientRelation,
} from '../../shared/constants';
import { caseScope, clientScope, hasPerm, isOwner, requirePerm, requireUser } from './access';
import { apptScope, svcFinance } from './appointments';
import { taskAccessSql } from './tasks';
import { currentStageOf, lastActionOf } from './overview';
import { relationOf } from './clients';
import { readSetting } from './settings';
import { reportFontCssText } from './reports';
import { logActivity } from './activity';
import { buildXlsx, type XCell, type XSheet } from './xlsx';

export const OFFICE_SECTIONS = {
  clients: 'كشف العملاء وبياناتهم',
  cases: 'كشف القضايا',
  consultations: 'كشف الاستشارات',
  meetings: 'كشف الاجتماعات',
  finance: 'التقرير المالي لكل عميل',
  financeDetails: 'تفاصيل الحركات المالية لكل عميل',
  alerts: 'التنبيهات الإدارية',
} as const;
export type OfficeSectionKey = keyof typeof OFFICE_SECTIONS;
export const OFFICE_SECTION_KEYS = Object.keys(OFFICE_SECTIONS) as [OfficeSectionKey, ...OfficeSectionKey[]];

export interface OfficeReportInput {
  mode: 'asOf' | 'period';
  asOf: string | null;
  from: string | null;
  to: string | null;
  clientId: string | null;
  caseType: string | null;
  caseStatus: 'active' | 'closed' | 'archived' | null;
  responsibleUserId: string | null;
  serviceType: 'cases' | 'consultations' | 'meetings' | null;
  payStatus: 'unpaid' | 'partial' | 'paid' | 'overpaid' | null;
  sections: OfficeSectionKey[];
  columns: Partial<Record<OfficeSectionKey, string[]>>;
  includeSensitive: boolean;
  includeDetails: boolean;
  staleDays: number;
  expiringDays: number;
}

type ColKind = 'text' | 'money' | 'date' | 'datetime' | 'number';
export interface Col {
  key: string;
  label: string;
  kind: ColKind;
}
export type CellVal = string | number | null;
export interface Row {
  cells: Record<string, CellVal>;
  link?: { type: 'client' | 'case' | 'consultation' | 'meeting' | 'task' | 'contract'; id: string; clientId?: string | null };
  detail?: string | null;
}
export interface Section {
  key: OfficeSectionKey;
  title: string;
  notes: string[];
  columns: Col[];
  allColumns: Col[];
  rows: Row[];
  groups?: { title: string; link?: Row['link']; rows: Row[] }[];
}
export interface SummaryItem {
  label: string;
  value: number | null;
  money?: boolean;
  basis: string;
}

const NOT_RECORDED = 'غير مسجل';

const cols = (...c: [string, string, ColKind?][]): Col[] => c.map(([key, label, kind]) => ({ key, label, kind: kind ?? 'text' }));

function dateOfIso(iso: string | null | undefined): string | null {
  return iso ? utcIsoToRiyadh(iso).date : null;
}

interface Window {
  from: string | null; // null = منذ البداية
  end: string; // تاريخ نهاية التقرير (شامل)
  endIso: string; // بداية اليوم التالي لنهاية التقرير (حد غير شامل)
  fromIso: string | null;
}

function windowOf(i: OfficeReportInput, today: string): Window {
  if (i.mode === 'period') {
    if (!i.from || !i.to) throw new AppError('VALIDATION', 'حدد بداية الفترة ونهايتها', { from: !i.from ? 'مطلوب' : '', to: !i.to ? 'مطلوب' : '' });
    if (i.to < i.from) throw new AppError('VALIDATION', 'نهاية الفترة قبل بدايتها', { to: 'بعد البداية' });
    return { from: i.from, end: i.to, endIso: riyadhToUtcIso(addDays(i.to, 1), '00:00'), fromIso: riyadhToUtcIso(i.from, '00:00') };
  }
  const end = i.asOf ?? today;
  return { from: null, end, endIso: riyadhToUtcIso(addDays(end, 1), '00:00'), fromIso: null };
}

const inWin = (w: Window, d: string | null | undefined) => !!d && d <= w.end && (!w.from || d >= w.from);
const upTo = (w: Window, d: string | null | undefined) => !!d && d <= w.end;

// ———————————————— جمع البيانات ————————————————

interface ClientRec {
  id: string;
  client_no: string | null;
  kind: string;
  name: string;
  phone: string | null;
  email: string | null;
  rep_name: string | null;
  id_type: string | null;
  id_number: string | null;
  created_at: string;
}
interface CaseRec {
  id: string;
  file_no: string;
  title: string;
  client_id: string;
  case_type: string | null;
  opened_on: string | null;
  created_at: string;
  responsible_user_id: string | null;
  responsible: string | null;
  status: string;
  follow_status: string;
  archived: number;
  archived_at: string | null;
  closed_at: string | null;
  outcome: string | null;
  next_action: string | null;
  next_action_due: string | null;
  updated_at: string;
}

export interface ClientFin {
  contractValue: number;
  feesDue: number;
  consultFees: number;
  consultFeesUnset: number;
  meetingFees: number;
  discounts: number;
  received: number;
  refunds: number;
  netReceived: number;
  collectedInPeriod: number;
  remaining: number;
  credit: number;
  notYetDue: number;
  undated: number;
  expensesCharged: number;
  expensesOutstanding: number;
  conditionalPct: string[];
  movements: Row[];
  status: 'unpaid' | 'partial' | 'paid' | 'overpaid' | 'none';
}

function emptyFin(): ClientFin {
  return {
    contractValue: 0,
    feesDue: 0,
    consultFees: 0,
    consultFeesUnset: 0,
    meetingFees: 0,
    discounts: 0,
    received: 0,
    refunds: 0,
    netReceived: 0,
    collectedInPeriod: 0,
    remaining: 0,
    credit: 0,
    notYetDue: 0,
    undated: 0,
    expensesCharged: 0,
    expensesOutstanding: 0,
    conditionalPct: [],
    movements: [],
    status: 'none',
  };
}

/** يحسب الموقف المالي لعميل حتى نهاية التقرير. كل عقد يُحسب مرة واحدة مهما كان عدد قضاياه، ولا يُوزّع على القضايا. */
function clientFinance(ctx: Ctx, w: Window, clientId: string, consultIds: string[], meetingIds: string[]): ClientFin {
  const f = emptyFin();
  const bal: number[] = [];
  const mv = (date: string, type: string, ref: string, method: string | null, amount: number | null, note: string | null = null, link?: Row['link']) =>
    f.movements.push({ cells: { date, type, ref, method, amount, note }, link });
  const contracts = ctx.db.all<{ id: string; title: string; contract_no: string | null; signed_on: string | null; start_date: string | null; created_at: string; fee_type: string; fixed_amount: number | null; percentage: number | null; percentage_basis: string | null; status: string }>(
    'SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at',
    [clientId],
  );
  for (const k of contracts) {
    const kDate = k.signed_on ?? k.start_date ?? dateOfIso(k.created_at)!;
    if (!upTo(w, kDate) || k.status === 'draft') continue;
    const hasFixed = k.fee_type === 'fixed' || k.fee_type === 'mixed';
    const items = ctx.db.all<{ title: string; amount: number; due_date: string | null; item_kind: string; created_at: string; basis: string | null }>('SELECT * FROM fee_items WHERE contract_id = ?', [k.id]);
    const inst = items.filter((i) => i.item_kind === 'installment');
    const instTotal = inst.reduce((s, i) => s + i.amount, 0);
    const value = hasFixed ? (k.fixed_amount ?? instTotal) : 0;
    f.contractValue += value;
    mv(kDate, 'قيمة عقد', k.title + (k.contract_no ? ` (${k.contract_no})` : ''), null, value, hasFixed ? null : 'لا أتعاب ثابتة', { type: 'contract', id: k.id, clientId });
    let due = 0;
    if (hasFixed) {
      if (!inst.length) due = value;
      else {
        due = inst.filter((i) => i.due_date && i.due_date <= w.end).reduce((s, i) => s + i.amount, 0);
        f.notYetDue += inst.filter((i) => i.due_date && i.due_date > w.end).reduce((s, i) => s + i.amount, 0);
        f.undated += inst.filter((i) => !i.due_date).reduce((s, i) => s + i.amount, 0) + Math.max(value - instTotal, 0);
      }
    }
    const pct = items.filter((i) => i.item_kind === 'percentage' && upTo(w, i.due_date ?? dateOfIso(i.created_at)));
    for (const p of pct) mv(p.due_date ?? dateOfIso(p.created_at)!, 'أتعاب نسبية متحققة', `${k.title}: ${p.title}`, null, p.amount, p.basis);
    due += pct.reduce((s, i) => s + i.amount, 0);
    if ((k.fee_type === 'percentage' || k.fee_type === 'mixed') && !pct.length)
      f.conditionalPct.push(`${k.title}: ${k.percentage ?? '؟'}% — ${k.percentage_basis ?? 'أساس غير مسجل'} (مشروطة؛ لم يُسجل تحققها فلا تُحتسب ضمن المستحق)`);
    f.feesDue += due;
    let paid = 0;
    for (const p of ctx.db.all<{ amount: number; paid_on: string; method: string | null; reference_no: string | null; is_advance: number }>('SELECT * FROM payments WHERE contract_id = ? AND voided = 0 AND paid_on <= ? ORDER BY paid_on', [k.id, w.end])) {
      paid += p.amount;
      f.received += p.amount;
      if (inWin(w, p.paid_on)) f.collectedInPeriod += p.amount;
      mv(p.paid_on, p.is_advance ? 'دفعة مقدمة' : 'دفعة', `${k.title}${p.reference_no ? ' — سند ' + p.reference_no : ''}`, p.method, p.amount);
    }
    let disc = 0;
    for (const a of ctx.db.all<{ kind: string; amount: number; adjusted_on: string; reason: string; method: string | null; reference_no: string | null }>('SELECT * FROM contract_adjustments WHERE contract_id = ? AND voided = 0 AND adjusted_on <= ? ORDER BY adjusted_on', [k.id, w.end])) {
      if (a.kind === 'refund') {
        paid -= a.amount;
        f.refunds += a.amount;
        if (inWin(w, a.adjusted_on)) f.collectedInPeriod -= a.amount;
      } else {
        disc += a.amount;
        f.discounts += a.amount;
      }
      mv(a.adjusted_on, labelOf(ADJUSTMENT_KINDS, a.kind), `${k.title}${a.reference_no ? ' — ' + a.reference_no : ''}`, a.method, a.amount, a.reason);
    }
    bal.push(due - disc - paid);
  }
  for (const id of consultIds) {
    const c = ctx.db.get<{ ref_no: string; title: string; fee_mode: string; fee_amount: number | null; created_at: string; starts_at: string; status: string }>('SELECT * FROM consultations WHERE id = ?', [id])!;
    const cDate = [dateOfIso(c.created_at)!, dateOfIso(c.starts_at)!].sort()[0];
    if (!upTo(w, cDate)) continue;
    const link = { type: 'consultation' as const, id, clientId };
    if (c.fee_mode === 'unset') {
      f.consultFeesUnset++;
      mv(cDate, 'استشارة', `${c.ref_no}: ${c.title}`, null, null, 'المبلغ غير مسجل', link);
    } else {
      const due = c.fee_mode === 'paid' ? c.fee_amount ?? 0 : 0;
      f.consultFees += due;
      mv(cDate, c.fee_mode === 'free' ? 'استشارة مجانية' : 'أتعاب استشارة', `${c.ref_no}: ${c.title}`, null, due, c.status === 'cancelled' ? 'الموعد ملغى (لا يُلغى المبلغ تلقائيًا)' : null, link);
    }
    bal.push(svcBalance(ctx, w, f, 'consultation_id', id, c.fee_mode === 'paid' ? c.fee_amount ?? 0 : 0, c.ref_no, mv));
  }
  for (const id of meetingIds) {
    const m = ctx.db.get<{ ref_no: string; title: string; fee_amount: number | null; created_at: string }>('SELECT * FROM meetings WHERE id = ?', [id])!;
    if (!m.fee_amount || !upTo(w, dateOfIso(m.created_at))) continue;
    f.meetingFees += m.fee_amount;
    mv(dateOfIso(m.created_at)!, 'مقابل اجتماع', `${m.ref_no}: ${m.title}`, null, m.fee_amount, null, { type: 'meeting', id, clientId });
    bal.push(svcBalance(ctx, w, f, 'meeting_id', id, m.fee_amount, m.ref_no, mv));
  }
  for (const x of ctx.db.all<{ amount: number; spent_on: string; recoverable: number; reimbursed_on: string | null; title: string }>('SELECT * FROM expenses WHERE client_id = ? AND spent_on <= ?', [clientId, w.end])) {
    if (x.recoverable) {
      f.expensesCharged += x.amount;
      if (!x.reimbursed_on || x.reimbursed_on > w.end) f.expensesOutstanding += x.amount;
    }
    mv(x.spent_on, x.recoverable ? 'مصروف محمّل على العميل' : 'مصروف على المكتب', x.title, null, x.amount, x.reimbursed_on && x.reimbursed_on <= w.end ? `سُدد في ${x.reimbursed_on}` : null);
  }
  f.netReceived = f.received - f.refunds;
  f.remaining = bal.filter((b) => b > 0).reduce((s, b) => s + b, 0);
  f.credit = -bal.filter((b) => b < 0).reduce((s, b) => s + b, 0);
  f.status = f.credit > 0 ? 'overpaid' : f.remaining > 0 ? (f.netReceived > 0 ? 'partial' : 'unpaid') : f.feesDue + f.consultFees + f.meetingFees > 0 ? 'paid' : 'none';
  f.movements.sort((a, b) => String(a.cells.date).localeCompare(String(b.cells.date)));
  return f;
}

function svcBalance(
  ctx: Ctx,
  w: Window,
  f: ClientFin,
  col: 'consultation_id' | 'meeting_id',
  id: string,
  due: number,
  ref: string,
  mv: (date: string, type: string, ref: string, method: string | null, amount: number | null, note?: string | null) => void,
): number {
  let paid = 0;
  let disc = 0;
  for (const t of ctx.db.all<{ kind: string; amount: number; txn_on: string; method: string | null; reference_no: string | null; reason: string | null }>(`SELECT * FROM service_txns WHERE ${col} = ? AND voided = 0 AND txn_on <= ? ORDER BY txn_on`, [id, w.end])) {
    if (t.kind === 'payment') {
      paid += t.amount;
      f.received += t.amount;
      if (inWin(w, t.txn_on)) f.collectedInPeriod += t.amount;
    } else if (t.kind === 'refund') {
      paid -= t.amount;
      f.refunds += t.amount;
      if (inWin(w, t.txn_on)) f.collectedInPeriod -= t.amount;
    } else {
      disc += t.amount;
      f.discounts += t.amount;
    }
    mv(t.txn_on, `${labelOf(SVC_TXN_KINDS, t.kind)} (${col === 'consultation_id' ? 'استشارة' : 'اجتماع'})`, `${ref}${t.reference_no ? ' — سند ' + t.reference_no : ''}`, t.method, t.amount, t.reason);
  }
  return due - disc - paid;
}

// ———————————————— بناء التقرير ————————————————

export function buildOfficeReport(ctx: Ctx, input: OfficeReportInput) {
  const u = requireUser(ctx);
  requirePerm(ctx, 'reports.office', 'لا تملك صلاحية عرض التقرير الشامل للمكتب');
  if ((input.includeSensitive || input.includeDetails) && !isOwner(ctx)) throw forbidden('تضمين البيانات الحساسة أو التفاصيل السرية متاح لصاحب المكتب فقط');
  const canFees = hasPerm(ctx, 'fees.view');
  const now = ctx.now();
  const today = todayRiyadh(now);
  const w = windowOf(input, today);
  const notices: string[] = [];
  if (!isOwner(ctx)) notices.push('هذا التقرير مقصور على الملفات والعملاء المتاحين لحسابك؛ الإجماليات محسوبة على هذا النطاق فقط.');
  if (!canFees) notices.push('لا تملك صلاحية الاطلاع على الأتعاب؛ حُذفت الأقسام والأعمدة المالية.');
  if (w.end > today) notices.push('نهاية الفترة بعد تاريخ اليوم؛ الأرقام تعكس ما سُجّل حتى الآن فقط.');

  const resp = input.responsibleUserId;
  // ———— العملاء المرئيون ————
  const cs = clientScope(ctx, 'cl.id');
  // العميل يدخل التقرير إن سُجل حتى نهاية الفترة أو كان له سجل بتاريخ عمل (فتح قضية/عقد/موعد) حتى نهايتها
  const businessStart = new Map<string, string>();
  const noteDate = (id: string, d: string | null | undefined) => {
    if (d && (!businessStart.has(id) || d < businessStart.get(id)!)) businessStart.set(id, d);
  };
  for (const r of ctx.db.all<{ client_id: string; d: string | null }>('SELECT client_id, min(coalesce(opened_on, substr(created_at,1,10))) AS d FROM cases GROUP BY client_id')) noteDate(r.client_id, r.d);
  for (const r of ctx.db.all<{ client_id: string; d: string | null }>('SELECT client_id, min(coalesce(signed_on, start_date, substr(created_at,1,10))) AS d FROM contracts GROUP BY client_id')) noteDate(r.client_id, r.d);
  let clients = ctx.db.all<ClientRec>(`SELECT cl.* FROM clients cl WHERE ${cs.sql} ORDER BY cl.client_no, cl.name`, cs.params).filter((c) => upTo(w, dateOfIso(c.created_at)) || upTo(w, businessStart.get(c.id)));
  if (input.clientId) clients = clients.filter((c) => c.id === input.clientId);
  const clientIds = new Set(clients.map((c) => c.id));

  // ———— القضايا ————
  const ks = caseScope(ctx, 'c.id');
  const allCases = ctx.db
    .all<CaseRec>(`SELECT c.*, u.display_name AS responsible FROM cases c LEFT JOIN users u ON u.id = c.responsible_user_id WHERE ${ks.sql} ORDER BY c.file_no`, ks.params)
    .filter((c) => clientIds.has(c.client_id) && upTo(w, c.opened_on ?? dateOfIso(c.created_at)));
  const statusAt = (c: CaseRec): 'active' | 'closed' | 'archived' =>
    c.archived && c.archived_at && c.archived_at < w.endIso ? 'archived' : c.status === 'closed' && c.closed_at && c.closed_at < w.endIso ? 'closed' : 'active';
  let cases = allCases;
  if (input.caseType) cases = cases.filter((c) => c.case_type === input.caseType);
  if (input.caseStatus) cases = cases.filter((c) => statusAt(c) === input.caseStatus);
  if (resp) cases = cases.filter((c) => c.responsible_user_id === resp);

  // ———— الاستشارات والاجتماعات ————
  const as = apptScope(ctx, 'consultations', 'k');
  let consults = ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT k.*, cl.name AS client_name, u.display_name AS responsible FROM consultations k JOIN clients cl ON cl.id = k.client_id LEFT JOIN users u ON u.id = k.responsible_user_id WHERE ${as.sql} ORDER BY k.starts_at`,
      as.params,
    )
    .filter((k) => (upTo(w, dateOfIso(String(k.created_at))) || upTo(w, dateOfIso(String(k.starts_at)))) && clientIds.has(String(k.client_id)));
  if (resp) consults = consults.filter((k) => k.responsible_user_id === resp);
  const ms = apptScope(ctx, 'meetings', 'm');
  let meetings = ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT m.*, cl.name AS client_name, u.display_name AS responsible FROM meetings m LEFT JOIN clients cl ON cl.id = m.client_id LEFT JOIN users u ON u.id = m.responsible_user_id WHERE ${ms.sql} ORDER BY m.starts_at`,
      ms.params,
    )
    .filter((m) => (upTo(w, dateOfIso(String(m.created_at))) || upTo(w, dateOfIso(String(m.starts_at)))) && (!m.client_id ? !input.clientId : clientIds.has(String(m.client_id))));
  if (resp) meetings = meetings.filter((m) => m.responsible_user_id === resp);

  // تقييد العملاء بحسب المرشحات المرتبطة بالخدمات
  const narrow = (ids: Set<string>) => {
    clients = clients.filter((c) => ids.has(c.id));
  };
  if (input.caseType || input.caseStatus) narrow(new Set(cases.map((c) => c.client_id)));
  if (input.serviceType === 'cases') narrow(new Set(cases.map((c) => c.client_id)));
  if (input.serviceType === 'consultations') narrow(new Set(consults.map((k) => String(k.client_id))));
  if (input.serviceType === 'meetings') narrow(new Set(meetings.filter((m) => m.client_id).map((m) => String(m.client_id))));
  if (resp) narrow(new Set([...cases.map((c) => c.client_id), ...consults.map((k) => String(k.client_id)), ...meetings.filter((m) => m.client_id).map((m) => String(m.client_id))]));

  // ———— المالية لكل عميل ————
  const fin = new Map<string, ClientFin>();
  if (canFees) {
    for (const c of clients) {
      fin.set(
        c.id,
        clientFinance(
          ctx,
          w,
          c.id,
          consults.filter((k) => k.client_id === c.id).map((k) => String(k.id)),
          meetings.filter((m) => m.client_id === c.id).map((m) => String(m.id)),
        ),
      );
    }
    if (input.payStatus) {
      clients = clients.filter((c) => fin.get(c.id)?.status === input.payStatus);
    }
  } else if (input.payStatus) throw forbidden('التصفية بحالة السداد تتطلب صلاحية الاطلاع على الأتعاب');
  const finalClientIds = new Set(clients.map((c) => c.id));
  if (input.payStatus || resp || input.serviceType || input.caseType || input.caseStatus) {
    cases = cases.filter((c) => finalClientIds.has(c.client_id));
    consults = consults.filter((k) => finalClientIds.has(String(k.client_id)));
    meetings = meetings.filter((m) => !m.client_id ? !input.payStatus && !input.serviceType : finalClientIds.has(String(m.client_id)));
  }
  if (input.serviceType === 'cases') {
    consults = [];
    meetings = [];
  } else if (input.serviceType === 'consultations') {
    meetings = [];
  } else if (input.serviceType === 'meetings') {
    consults = [];
  }
  const showCases = input.serviceType !== 'consultations' && input.serviceType !== 'meetings';

  // ———— الملخص التنفيذي ————
  const relAt = (clientId: string): ClientRelation => {
    const nCases = allCases.filter((c) => c.client_id === clientId).length;
    const nCons = consults.filter((k) => k.client_id === clientId).length;
    return relationOf(nCases, nCons);
  };
  const caseList = showCases ? cases : [];
  const caseIdSet = new Set(caseList.map((c) => c.id));
  const hearings = caseList.length
    ? ctx.db.all<{ case_id: string; starts_at: string; status: string }>(`SELECT case_id, starts_at, status FROM hearings WHERE case_id IN (${caseList.map(() => '?').join(',')})`, caseList.map((c) => c.id))
    : [];
  const ta = taskAccessSql(ctx);
  let tasks = ctx.db.all<{ id: string; title: string; status: string; due_date: string | null; completed_at: string | null; created_at: string; client_id: string | null; case_id: string | null; meeting_id: string | null; consultation_id: string | null; assignee_user_id: string | null }>(
    `SELECT t.* FROM tasks t WHERE ${ta.sql}`,
    ta.params,
  );
  tasks = tasks.filter((t) => upTo(w, dateOfIso(t.created_at)));
  if (input.clientId || input.caseType || input.caseStatus || input.serviceType || input.payStatus) {
    const meetIds = new Set(meetings.map((m) => String(m.id)));
    const consIds = new Set(consults.map((k) => String(k.id)));
    tasks = tasks.filter((t) => (t.case_id && caseIdSet.has(t.case_id)) || (t.meeting_id && meetIds.has(t.meeting_id)) || (t.consultation_id && consIds.has(t.consultation_id)) || (!t.case_id && t.client_id && finalClientIds.has(t.client_id) && !input.caseType && !input.caseStatus));
  }
  if (resp) tasks = tasks.filter((t) => t.assignee_user_id === resp);
  const doneAt = (t: (typeof tasks)[number]) => (t.status === 'done' && t.completed_at && t.completed_at < w.endIso ? t.completed_at : null);
  const openTasks = tasks.filter((t) => !doneAt(t));
  const kindCount = (k: string) => clients.filter((c) => c.kind === k).length;
  const periodNote = w.from ? `خلال الفترة من ${fmtDate(w.from)} إلى ${fmtDate(w.end)}` : `حتى ${fmtDate(w.end)}`;
  const apptDate = (r: Record<string, string | number | null>) => dateOfIso(String(r.starts_at));
  const consultIn = consults.filter((k) => inWin(w, apptDate(k)));
  const meetingIn = meetings.filter((m) => inWin(w, apptDate(m)));
  const finTotals = [...fin.entries()].filter(([id]) => finalClientIds.has(id)).map(([, f]) => f);
  const sumF = (k: keyof ClientFin) => finTotals.reduce((s, f) => s + (f[k] as number), 0);
  const expensesSpentInWin = canFees
    ? clients.reduce((s, c) => s + (ctx.db.get<{ s: number | null }>(`SELECT sum(amount) AS s FROM expenses WHERE client_id = ? AND spent_on <= ? ${w.from ? 'AND spent_on >= ?' : ''}`, w.from ? [c.id, w.end, w.from] : [c.id, w.end])!.s ?? 0), 0)
    : 0;
  const summary: { title: string; items: SummaryItem[] }[] = [
    {
      title: 'العملاء',
      items: [
        { label: 'العملاء وجهات الاتصال الفريدون', value: clients.length, basis: `المسجلون حتى ${fmtDate(w.end)} ضمن المرشحات — كل شخص أو شركة مرة واحدة` },
        { label: 'منهم أفراد', value: kindCount('individual'), basis: 'تصنيف العميل المسجل' },
        { label: 'منهم شركات', value: kindCount('company'), basis: 'تصنيف العميل المسجل' },
        { label: 'منهم منشآت', value: kindCount('establishment'), basis: 'تصنيف العميل المسجل' },
        { label: 'طالبو استشارة فقط', value: clients.filter((c) => relAt(c.id) === 'consultation_only').length, basis: 'لهم استشارات وليست لهم قضايا مسجلة حتى نهاية الفترة — لا يُحسبون ضمن عملاء القضايا' },
        { label: 'عملاء قضايا', value: clients.filter((c) => ['case_client', 'both'].includes(relAt(c.id))).length, basis: 'لهم قضية واحدة على الأقل (منهم من طلب استشارة أيضًا)' },
        ...(w.from ? [{ label: 'عملاء جدد خلال الفترة', value: clients.filter((c) => inWin(w, dateOfIso(c.created_at))).length, basis: 'تاريخ تسجيل العميل داخل الفترة' }] : []),
      ],
    },
  ];
  if (showCases) {
    const at = caseList.map(statusAt);
    summary.push({
      title: 'القضايا والجلسات',
      items: [
        { label: 'إجمالي القضايا', value: caseList.length, basis: `القضايا المفتوحة ملفاتها حتى ${fmtDate(w.end)}` },
        { label: 'القضايا النشطة في نهاية الفترة', value: at.filter((s) => s === 'active').length, basis: `غير مقفلة وغير مؤرشفة بتاريخ ${fmtDate(w.end)}` },
        { label: 'القضايا المقفلة', value: at.filter((s) => s === 'closed').length, basis: `تاريخ الإقفال حتى ${fmtDate(w.end)}` },
        { label: 'القضايا المؤرشفة', value: at.filter((s) => s === 'archived').length, basis: `تاريخ الأرشفة حتى ${fmtDate(w.end)}` },
        ...(w.from ? [{ label: 'قضايا فُتحت خلال الفترة', value: caseList.filter((c) => inWin(w, c.opened_on ?? dateOfIso(c.created_at))).length, basis: 'تاريخ فتح الملف داخل الفترة — يختلف عن عدد القضايا النشطة' }] : []),
        { label: 'الجلسات المنعقدة', value: hearings.filter((h) => h.status === 'held' && inWin(w, dateOfIso(h.starts_at))).length, basis: `جلسات حالتها «منعقدة» وتاريخها ${periodNote}` },
        { label: 'الجلسات القادمة', value: hearings.filter((h) => h.status === 'scheduled' && h.starts_at >= w.endIso).length, basis: `جلسات مجدولة بعد ${fmtDate(w.end)}` },
      ],
    });
  }
  if (input.serviceType !== 'cases' && input.serviceType !== 'meetings') {
    summary.push({
      title: 'الاستشارات',
      items: [
        { label: 'عدد الاستشارات', value: consultIn.length, basis: `بحسب تاريخ الموعد ${periodNote}` },
        { label: 'المنجزة', value: consultIn.filter((k) => k.status === 'done').length, basis: 'حالة «تمت الاستشارة»' },
        { label: 'الملغاة', value: consultIn.filter((k) => k.status === 'cancelled').length, basis: 'حالة «ملغى»' },
        { label: 'لم يحضر أصحابها', value: consultIn.filter((k) => k.status === 'no_show').length, basis: 'حالة «لم يحضر»' },
        { label: 'القادمة', value: consults.filter((k) => ['pending', 'confirmed'].includes(String(k.status)) && String(k.starts_at) >= w.endIso).length, basis: `بانتظار التأكيد أو مؤكدة بعد ${fmtDate(w.end)}` },
      ],
    });
  }
  if (input.serviceType !== 'cases' && input.serviceType !== 'consultations') {
    summary.push({
      title: 'الاجتماعات',
      items: [
        { label: 'عدد الاجتماعات', value: meetingIn.length, basis: `بحسب تاريخ الاجتماع ${periodNote}` },
        { label: 'المنعقدة', value: meetingIn.filter((m) => m.status === 'held').length, basis: 'حالة «منعقد»' },
        { label: 'القادمة', value: meetings.filter((m) => ['pending', 'confirmed'].includes(String(m.status)) && String(m.starts_at) >= w.endIso).length, basis: `بانتظار التأكيد أو مؤكدة بعد ${fmtDate(w.end)}` },
      ],
    });
  }
  summary.push({
    title: 'المهام',
    items: [
      { label: 'المهام المكتملة', value: tasks.filter((t) => doneAt(t) && inWin(w, dateOfIso(doneAt(t)))).length, basis: `تاريخ الإكمال ${periodNote}` },
      { label: 'المهام المفتوحة', value: openTasks.length, basis: `غير مكتملة بتاريخ ${fmtDate(w.end)}` },
      { label: 'المهام المتأخرة', value: openTasks.filter((t) => t.due_date && t.due_date < w.end).length, basis: `مفتوحة وموعدها قبل ${fmtDate(w.end)}` },
    ],
  });
  if (canFees) {
    summary.push({
      title: 'الوضع المالي',
      items: [
        { label: 'قيمة العقود المسجلة', value: sumF('contractValue'), money: true, basis: `إجمالي قيمة التعاقد للعقود السارية حتى ${fmtDate(w.end)} — كل عقد مرة واحدة مهما تعددت قضاياه` },
        { label: 'الأتعاب المستحقة فعليًا', value: sumF('feesDue'), money: true, basis: `الأقساط التي حل موعدها والعقود غير المقسطة والأتعاب النسبية المسجل تحققها حتى ${fmtDate(w.end)}` },
        { label: 'أتعاب الاستشارات', value: sumF('consultFees'), money: true, basis: 'مبالغ الاستشارات المدفوعة المسجلة (المجانية صفر ولا تُعد متأخرات)' },
        { label: 'مقابل الاجتماعات المدفوعة', value: sumF('meetingFees'), money: true, basis: 'بند مستقل لا يُكرر في أتعاب القضية أو الاستشارة' },
        { label: 'الخصومات والتسويات', value: sumF('discounts'), money: true, basis: `مسجلة حتى ${fmtDate(w.end)} (غير نقدية)` },
        { label: 'المبالغ المستلمة', value: sumF('received'), money: true, basis: `الدفعات حتى ${fmtDate(w.end)}` },
        { label: 'المبالغ المستردة', value: sumF('refunds'), money: true, basis: `حتى ${fmtDate(w.end)}` },
        { label: 'صافي المبالغ المستلمة', value: sumF('netReceived'), money: true, basis: 'المستلمة ناقص المستردة' },
        ...(w.from ? [{ label: 'المتحصل خلال الفترة (صافي)', value: sumF('collectedInPeriod'), money: true, basis: `الدفعات ناقص الاستردادات بين ${fmtDate(w.from)} و${fmtDate(w.end)}` }] : []),
        { label: 'الرصيد المتبقي', value: sumF('remaining'), money: true, basis: `المستحق غير المسدد حتى ${fmtDate(w.end)} (لكل عقد/خدمة على حدة)` },
        { label: 'المبالغ الزائدة / أرصدة دائنة', value: sumF('credit'), money: true, basis: 'مدفوع أكثر من المستحق ويحتاج تسوية' },
        { label: 'أقساط غير حالّة', value: sumF('notYetDue'), money: true, basis: `أقساط موعدها بعد ${fmtDate(w.end)} — ليست متأخرات` },
        { label: 'مبالغ غير محددة الاستحقاق', value: sumF('undated'), money: true, basis: 'أقساط بلا تاريخ أو جزء من العقد غير مجدول — لا تُحتسب مستحقة' },
        { label: 'المصروفات المحمّلة على العملاء', value: sumF('expensesCharged'), money: true, basis: 'منفصلة عن أتعاب المكتب' },
        { label: 'منها غير مسددة', value: sumF('expensesOutstanding'), money: true, basis: `لم يُسجل سدادها حتى ${fmtDate(w.end)}` },
        {
          label: 'صافي الحركة النقدية المسجلة',
          value: (w.from ? sumF('collectedInPeriod') : sumF('netReceived')) - expensesSpentInWin,
          money: true,
          basis: `صافي المقبوضات ناقص المصروفات المسجلة ${periodNote} — ليس صافي ربح محاسبي`,
        },
      ],
    });
    notices.push('لا تُسجَّل الضريبة في البرنامج؛ المبالغ كما أُدخلت دون افتراض نسبة أو وضع ضريبي.');
  }

  // ———— الأقسام ————
  const want = new Set(input.sections.length ? input.sections : OFFICE_SECTION_KEYS);
  const sections: Section[] = [];
  const pick = (key: OfficeSectionKey, all: Col[]) => {
    const chosen = input.columns[key];
    return chosen && chosen.length ? all.filter((c) => chosen.includes(c.key)) : all;
  };
  const endNow = new Date(Math.min(new Date(w.endIso).getTime() - 1, now.getTime()));

  if (want.has('clients')) {
    const all = cols(
      ['no', 'رقم العميل'],
      ['name', 'الاسم'],
      ['kind', 'فرد أو شركة'],
      ['relation', 'طبيعة العلاقة'],
      ['phone', 'الجوال'],
      ['email', 'البريد'],
      ['rep', 'ممثل الشركة'],
      ...(input.includeSensitive ? ([['idNumber', 'رقم الهوية / السجل']] as [string, string][]) : []),
      ['cases', 'القضايا وحالاتها'],
      ['consultations', 'الاستشارات', 'number'],
      ['lastAction', 'آخر إجراء مسجل'],
      ['nextAppt', 'الموعد القادم'],
      ...(canFees ? ([['due', 'إجمالي المستحقات', 'money'], ['paid', 'المدفوع (صافي)', 'money'], ['remaining', 'المتبقي', 'money']] as [string, string, ColKind][]) : []),
    );
    const rows: Row[] = clients.map((c) => {
      const cc = allCases.filter((k) => k.client_id === c.id);
      const st = cc.map(statusAt);
      const caseIds = cc.map((k) => k.id);
      const last = ctx.db.get<{ at: string; summary: string }>(
        `SELECT at, summary FROM activity_log WHERE at < ? AND (client_id = ? ${caseIds.length ? `OR case_id IN (${caseIds.map(() => '?').join(',')})` : ''}) AND action NOT IN ('login','logout','export') ORDER BY at DESC LIMIT 1`,
        [w.endIso, c.id, ...caseIds],
      );
      const next = nextAppointment(ctx, w, c.id, caseIds, consults, meetings);
      const f = fin.get(c.id);
      return {
        link: { type: 'client', id: c.id },
        cells: {
          no: c.client_no,
          name: c.name,
          kind: labelOf(CLIENT_KINDS, c.kind),
          relation: CLIENT_RELATIONS[relAt(c.id)].label,
          phone: c.phone,
          email: c.email,
          rep: c.kind === 'individual' ? '—' : c.rep_name,
          idNumber: c.id_number ? `${c.id_type ?? ''} ${c.id_number}`.trim() : null,
          cases: cc.length ? `${cc.length}: نشطة ${st.filter((s) => s === 'active').length}، مقفلة ${st.filter((s) => s === 'closed').length}، مؤرشفة ${st.filter((s) => s === 'archived').length}` : 'لا قضايا',
          consultations: consults.filter((k) => k.client_id === c.id).length,
          lastAction: last ? `${fmtDate(dateOfIso(last.at))} — ${canFees ? last.summary : last.summary.replace(/[\d,.]+ ر\.س/g, '…')}` : null,
          nextAppt: next,
          due: f ? f.feesDue + f.consultFees + f.meetingFees - f.discounts : null,
          paid: f ? f.netReceived : null,
          remaining: f ? f.remaining : null,
        },
      };
    });
    sections.push({ key: 'clients', title: OFFICE_SECTIONS.clients, notes: input.includeSensitive ? ['يتضمن أرقام الهوية/السجل بطلب صاحب المكتب — تعامل معه بسرية.'] : [], allColumns: all, columns: pick('clients', all), rows });
  }

  if (want.has('cases') && showCases) {
    const all = cols(
      ['fileNo', 'رقم الملف'],
      ['officialNo', 'رقم القضية الرسمي'],
      ['client', 'العميل'],
      ['title', 'عنوان القضية'],
      ['type', 'النوع'],
      ['parties', 'الخصم / الأطراف'],
      ['court', 'المحكمة والدائرة'],
      ['stage', 'المرحلة'],
      ['status', 'الحالة'],
      ['responsible', 'المسؤول'],
      ['openedOn', 'تاريخ فتح الملف', 'date'],
      ['lastAction', 'آخر إجراء وتاريخه'],
      ['nextHearing', 'الجلسة القادمة'],
      ['nextTask', 'المهمة التالية وموعدها'],
      ['missing', 'الناقص المسجل'],
      ['outcome', 'النتيجة عند الإقفال'],
    );
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const rows: Row[] = caseList.map((c) => {
      const stage = currentStageOf(ctx.db, c.id);
      const circuit = stage ? ctx.db.get<{ circuit: string | null }>('SELECT circuit FROM stages WHERE id = ?', [stage.id])?.circuit : null;
      const parties = ctx.db.all<{ name: string; role: string | null; is_opponent: number }>('SELECT name, role, is_opponent FROM case_parties WHERE case_id = ? ORDER BY is_opponent DESC, sort_order', [c.id]);
      const last = lastActionOf(ctx.db, c.id, endNow);
      const nh = ctx.db.get<{ starts_at: string }>("SELECT starts_at FROM hearings WHERE case_id = ? AND status = 'scheduled' AND starts_at >= ? ORDER BY starts_at LIMIT 1", [c.id, w.endIso]);
      const nt = ctx.db.get<{ title: string; due_date: string | null }>(
        "SELECT title, due_date FROM tasks WHERE case_id = ? AND (status != 'done' OR completed_at >= ?) AND created_at < ? ORDER BY due_date IS NULL, due_date LIMIT 1",
        [c.id, w.endIso, w.endIso],
      );
      const missing = ctx.db.get<{ sections: string }>('SELECT sections FROM case_analysis WHERE case_id = ?', [c.id]);
      let missingText: string | null = null;
      try {
        missingText = missing ? (JSON.parse(missing.sections).missing_documents as string | undefined)?.trim() || null : null;
      } catch {
        missingText = null;
      }
      const missingParts = [missingText ? `مستندات: ${missingText.slice(0, 200)}` : null, c.next_action ? `إجراء: ${c.next_action}${c.next_action_due ? ' (' + c.next_action_due + ')' : ''}` : null].filter(Boolean);
      const sAt = statusAt(c);
      return {
        link: { type: 'case', id: c.id },
        cells: {
          fileNo: c.file_no,
          officialNo: stage?.officialCaseNo ?? null,
          client: clientName.get(c.client_id) ?? null,
          title: c.title,
          type: c.case_type,
          parties: parties.length ? parties.map((p) => `${p.name}${p.role ? ' (' + p.role + ')' : ''}`).join('، ') : null,
          court: stage ? [stage.courtName ?? stage.courtType, circuit].filter(Boolean).join(' — ') || null : null,
          stage: stage ? stage.stageType : null,
          status: sAt === 'archived' ? 'مؤرشفة' : sAt === 'closed' ? CASE_STATUSES.closed.label : `${CASE_STATUSES.open.label} — ${labelOf(FOLLOW_STATUSES, c.follow_status)}`,
          responsible: c.responsible,
          openedOn: c.opened_on ?? dateOfIso(c.created_at),
          lastAction: last ? `${last.label} — ${last.isDateOnly ? fmtDate(last.at) : fmtDateTime(last.at)}` : null,
          nextHearing: nh ? fmtDateTime(nh.starts_at) : null,
          nextTask: nt ? `${nt.title}${nt.due_date ? ' — ' + fmtDate(nt.due_date) : ' — بلا موعد'}` : null,
          missing: missingParts.length ? missingParts.join(' | ') : null,
          outcome: sAt === 'closed' ? c.outcome : sAt === 'archived' ? c.outcome ?? null : '—',
        },
      };
    });
    sections.push({ key: 'cases', title: OFFICE_SECTIONS.cases, notes: ['الحالة محسوبة بتاريخ نهاية التقرير من تاريخي الإقفال والأرشفة؛ المرحلة والمحكمة من آخر مرحلة مسجلة.', 'لا يُفترض إجراء تالٍ أو نتيجة غير مسجلين.'], allColumns: all, columns: pick('cases', all), rows });
  }

  if (want.has('consultations') && input.serviceType !== 'cases' && input.serviceType !== 'meetings') {
    const all = cols(
      ['ref', 'الرقم المرجعي'],
      ['name', 'المستفيد'],
      ['title', 'الموضوع'],
      ['category', 'التصنيف'],
      ['date', 'التاريخ', 'datetime'],
      ['method', 'الطريقة'],
      ['responsible', 'المسؤول'],
      ['status', 'حالة الموعد'],
      ['opinion', 'الاستشارة المكتوبة'],
      ['delivered', 'تاريخ التسليم', 'date'],
      ...(canFees ? ([['amount', 'المبلغ', 'money'], ['paid', 'المدفوع (صافي)', 'money'], ['remaining', 'المتبقي', 'money'], ['payStatus', 'حالة السداد']] as [string, string, ColKind][]) : []),
    );
    const rows: Row[] = consults.map((k) => {
      const op = ctx.db.get<{ n: number; status: string | null; delivered: string | null }>(
        `SELECT count(*) AS n, (SELECT status FROM consultation_opinions WHERE consultation_id = :id ORDER BY updated_at DESC LIMIT 1) AS status,
          (SELECT max(delivered_on) FROM consultation_opinions WHERE consultation_id = :id AND delivered_on <= :end) AS delivered FROM consultation_opinions WHERE consultation_id = :id`,
        { id: k.id, end: w.end },
      )!;
      const f = canFees ? svcFinance(ctx, 'consultation', String(k.id), w.end) : null;
      let detail: string | null = null;
      if (input.includeDetails) {
        const ops = ctx.db.all<{ title: string; body: string | null; status: string }>('SELECT title, body, status FROM consultation_opinions WHERE consultation_id = ?', [k.id]);
        detail = [
          k.description ? `الموضوع: ${k.description}` : null,
          k.questions ? `الأسئلة: ${k.questions}` : null,
          k.internal_notes ? `ملاحظات داخلية: ${k.internal_notes}` : null,
          ...ops.map((o) => `الاستشارة المكتوبة «${o.title}» (${labelOf(OPINION_STATUSES, o.status)}): ${o.body ?? 'ملف مرفق'}`),
        ]
          .filter(Boolean)
          .join('\n');
      }
      return {
        link: { type: 'consultation', id: String(k.id) },
        detail,
        cells: {
          ref: String(k.ref_no),
          name: String(k.client_name),
          title: String(k.title),
          category: k.category as string | null,
          date: String(k.starts_at),
          method: labelOf(APPT_METHODS, String(k.method)),
          responsible: k.responsible as string | null,
          status: labelOf(CONSULT_STATUSES, String(k.status)),
          opinion: op.n ? labelOf(OPINION_STATUSES, op.status) : k.written_required ? 'لا توجد بعد' : 'غير مطلوبة',
          delivered: op.delivered,
          amount: f ? (f.mode === 'free' ? 0 : f.due) : null,
          paid: f ? f.netPaid : null,
          remaining: f ? f.remaining : null,
          payStatus: f ? PAY_STATUSES[f.status].label : null,
        },
      };
    });
    sections.push({
      key: 'consultations',
      title: OFFICE_SECTIONS.consultations,
      notes: [input.includeDetails ? 'يتضمن تفاصيل الموضوع والملاحظات الداخلية ونصوص الاستشارات بطلب صاحب المكتب — سري.' : 'لا تُدرج نصوص الاستشارات والملاحظات الداخلية افتراضيًا.', 'الاستشارة المجانية مبلغها صفر ولا تظهر كمتأخرات.'],
      allColumns: all,
      columns: pick('consultations', all),
      rows,
    });
  }

  if (want.has('meetings') && input.serviceType !== 'cases' && input.serviceType !== 'consultations') {
    const all = cols(
      ['ref', 'الرقم المرجعي'],
      ['title', 'العنوان'],
      ['party', 'الجهة أو الشخص'],
      ['date', 'التاريخ', 'datetime'],
      ['method', 'الطريقة'],
      ['participants', 'المشاركون'],
      ['status', 'الحالة'],
      ['minutes', 'المحضر'],
      ['decisions', 'القرارات والتوصيات'],
      ['tasks', 'المهام الناتجة وحالتها'],
    );
    const rows: Row[] = meetings.map((m) => {
      const items = ctx.db.all<{ kind: string; text: string; task_id: string | null }>('SELECT kind, text, task_id FROM meeting_items WHERE meeting_id = ? ORDER BY sort_order', [m.id]);
      const tk = ctx.db.all<{ status: string }>('SELECT status FROM tasks WHERE meeting_id = ?', [m.id]);
      let parts: { name: string; role: string | null }[] = [];
      try {
        parts = JSON.parse(String(m.participants ?? '[]'));
      } catch {
        parts = [];
      }
      return {
        link: { type: 'meeting', id: String(m.id) },
        detail: input.includeDetails ? [m.minutes ? `المحضر: ${m.minutes}` : null, ...items.map((i) => `${i.kind === 'decision' ? 'قرار' : 'توصية'}: ${i.text}`)].filter(Boolean).join('\n') || null : null,
        cells: {
          ref: String(m.ref_no),
          title: String(m.title),
          party: (m.client_name as string | null) ?? null,
          date: String(m.starts_at),
          method: labelOf(APPT_METHODS, String(m.method)),
          participants: parts.length ? parts.map((p) => p.name + (p.role ? ` (${p.role})` : '')).join('، ') : null,
          status: labelOf(MEETING_STATUSES, String(m.status)),
          minutes: m.minutes && String(m.minutes).trim() ? 'مسجل' : 'لا يوجد',
          decisions: items.length ? `${items.filter((i) => i.kind === 'decision').length} قرار، ${items.filter((i) => i.kind === 'recommendation').length} توصية` : 'لا يوجد',
          tasks: tk.length ? `${tk.length}: مكتملة ${tk.filter((t) => t.status === 'done').length}، مفتوحة ${tk.filter((t) => t.status !== 'done').length}` : 'لا يوجد',
        },
      };
    });
    sections.push({ key: 'meetings', title: OFFICE_SECTIONS.meetings, notes: input.includeDetails ? ['يتضمن نص المحاضر والقرارات — سري.'] : ['لا يُدرج نص المحاضر افتراضيًا.'], allColumns: all, columns: pick('meetings', all), rows });
  }

  if (canFees && want.has('finance')) {
    const all = cols(
      ['no', 'رقم العميل'],
      ['name', 'العميل'],
      ['contractValue', 'قيمة العقود', 'money'],
      ['feesDue', 'الأتعاب المستحقة فعليًا', 'money'],
      ['consultFees', 'أتعاب الاستشارات', 'money'],
      ['meetingFees', 'مقابل الاجتماعات', 'money'],
      ['expenses', 'مصروفات محمّلة على العميل', 'money'],
      ['discounts', 'الخصومات والتسويات', 'money'],
      ['received', 'المستلم', 'money'],
      ['refunds', 'المسترد', 'money'],
      ['net', 'صافي المستلم', 'money'],
      ...(w.from ? ([['collected', 'المتحصل خلال الفترة', 'money']] as [string, string, ColKind][]) : []),
      ['remaining', 'المتبقي', 'money'],
      ['credit', 'مبالغ زائدة / دائنة', 'money'],
      ['notYetDue', 'أقساط غير حالّة', 'money'],
      ['undated', 'غير محدد الاستحقاق', 'money'],
      ['notes', 'ملاحظات'],
    );
    const rows: Row[] = [];
    for (const c of clients) {
      const f = fin.get(c.id)!;
      if (!f.movements.length) continue;
      rows.push({
        link: { type: 'client', id: c.id },
        cells: {
          no: c.client_no,
          name: c.name,
          contractValue: f.contractValue,
          feesDue: f.feesDue,
          consultFees: f.consultFees,
          meetingFees: f.meetingFees,
          expenses: f.expensesCharged,
          discounts: f.discounts,
          received: f.received,
          refunds: f.refunds,
          net: f.netReceived,
          collected: f.collectedInPeriod,
          remaining: f.remaining,
          credit: f.credit,
          notYetDue: f.notYetDue,
          undated: f.undated,
          notes: [...f.conditionalPct, f.consultFeesUnset ? `${f.consultFeesUnset} استشارة مبلغها غير مسجل` : null, f.expensesOutstanding ? `مصروفات غير مسددة ${fmtAmount(f.expensesOutstanding)}` : null].filter(Boolean).join(' | ') || null,
        },
      });
    }
    sections.push({
      key: 'finance',
      title: OFFICE_SECTIONS.finance,
      notes: [
        `أ. إجمالي قيمة التعاقد ≠ ب. المستحق حتى ${fmtDate(w.end)} ≠ ج. المتحصل ${w.from ? 'خلال الفترة' : 'حتى نهايتها'} ≠ د. الرصيد المتبقي حتى نهايتها.`,
        'العقد الشامل لعدة قضايا يُحسب مرة واحدة على مستوى العميل ولا يُخترع توزيع لقيمته على القضايا.',
        'الأتعاب النسبية المشروطة لا تُضاف للمستحق إلا بعد تسجيل تحققها وقيمتها واعتمادها كبند «أتعاب نسبية متحققة».',
        'المصروفات المحمّلة على العميل منفصلة عن أتعاب المكتب ولا تدخل في المتبقي من الأتعاب.',
      ],
      allColumns: all,
      columns: pick('finance', all),
      rows,
    });
  }

  if (canFees && want.has('financeDetails')) {
    const all = cols(['date', 'التاريخ', 'date'], ['type', 'الحركة'], ['ref', 'المرجع'], ['method', 'الطريقة'], ['amount', 'المبلغ', 'money'], ['note', 'ملاحظة']);
    const groups = clients
      .map((c) => ({ title: `${c.client_no ?? ''} ${c.name}`.trim(), link: { type: 'client' as const, id: c.id }, rows: fin.get(c.id)!.movements }))
      .filter((g) => g.rows.length);
    sections.push({ key: 'financeDetails', title: OFFICE_SECTIONS.financeDetails, notes: ['كل حركة بتاريخها ومرجعها وطريقتها كما سُجلت.'], allColumns: all, columns: pick('financeDetails', all), rows: [], groups });
  }

  if (want.has('alerts')) {
    sections.push(buildAlerts(ctx, w, input, { cases: caseList, consults, meetings, openTasks, statusAt, canFees, clients }));
  }

  const office = readSetting(ctx.db, 'office.name');
  const filters: string[] = [];
  if (input.clientId) filters.push(`العميل: ${clients[0]?.name ?? ctx.db.get<{ name: string }>('SELECT name FROM clients WHERE id = ?', [input.clientId])?.name ?? '—'}`);
  if (input.caseType) filters.push(`نوع القضية: ${input.caseType}`);
  if (input.caseStatus) filters.push(`حالة القضية: ${{ active: 'نشطة', closed: 'مقفلة', archived: 'مؤرشفة' }[input.caseStatus]}`);
  if (resp) filters.push(`المسؤول: ${ctx.db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [resp])?.display_name ?? '—'}`);
  if (input.serviceType) filters.push(`نوع الخدمة: ${{ cases: 'قضايا', consultations: 'استشارات', meetings: 'اجتماعات' }[input.serviceType]}`);
  if (input.payStatus) filters.push(`حالة السداد: ${PAY_STATUSES[input.payStatus].label}`);
  return {
    meta: {
      office,
      title: 'التقرير الشامل للمكتب',
      confidential: 'تقرير داخلي — سري',
      generatedAt: now.toISOString(),
      generatedBy: u.displayName,
      mode: input.mode,
      from: w.from,
      end: w.end,
      periodLabel: w.from ? `الفترة من ${fmtDate(w.from)} إلى ${fmtDate(w.end)}` : `جميع البيانات حتى ${fmtDate(w.end)}`,
      filters,
      scopeLimited: !isOwner(ctx),
    },
    summary,
    sections,
    notices,
  };
}

export type OfficeReport = ReturnType<typeof buildOfficeReport>;

function nextAppointment(ctx: Ctx, w: Window, clientId: string, caseIds: string[], consults: Record<string, unknown>[], meetings: Record<string, unknown>[]): string | null {
  const c: { at: string; label: string }[] = [];
  if (caseIds.length) {
    const h = ctx.db.get<{ starts_at: string }>(`SELECT min(starts_at) AS starts_at FROM hearings WHERE status = 'scheduled' AND starts_at >= ? AND case_id IN (${caseIds.map(() => '?').join(',')})`, [w.endIso, ...caseIds]);
    if (h?.starts_at) c.push({ at: h.starts_at, label: 'جلسة' });
  }
  for (const k of consults) if (k.client_id === clientId && ['pending', 'confirmed'].includes(String(k.status)) && String(k.starts_at) >= w.endIso) c.push({ at: String(k.starts_at), label: 'استشارة' });
  for (const m of meetings) if (m.client_id === clientId && ['pending', 'confirmed'].includes(String(m.status)) && String(m.starts_at) >= w.endIso) c.push({ at: String(m.starts_at), label: 'اجتماع' });
  c.sort((a, b) => a.at.localeCompare(b.at));
  return c.length ? `${c[0].label} — ${fmtDateTime(c[0].at)}` : null;
}

function buildAlerts(
  ctx: Ctx,
  w: Window,
  input: OfficeReportInput,
  d: {
    cases: CaseRec[];
    consults: Record<string, string | number | null>[];
    meetings: Record<string, string | number | null>[];
    openTasks: { id: string; title: string; due_date: string | null; case_id: string | null }[];
    statusAt: (c: CaseRec) => string;
    canFees: boolean;
    clients: ClientRec[];
  },
): Section {
  const all = cols(['category', 'نوع التنبيه'], ['item', 'السجل'], ['detail', 'التفصيل'], ['date', 'التاريخ المرجعي', 'date']);
  const rows: Row[] = [];
  const add = (category: string, item: string, detail: string, date: string | null, link?: Row['link']) => rows.push({ cells: { category, item, detail, date }, link });
  const stale = Math.max(1, input.staleDays);
  for (const c of d.cases.filter((x) => d.statusAt(x) === 'active')) {
    const last = ctx.db.get<{ at: string | null }>(`SELECT max(at) AS at FROM activity_log WHERE case_id = ? AND at < ? AND action NOT IN ('export')`, [c.id, w.endIso])?.at ?? c.updated_at;
    const lastDate = dateOfIso(last)!;
    const days = diffDays(w.end, lastDate);
    if (days >= stale) add('قضية دون تحديث مسجل', `${c.file_no} — ${c.title}`, `آخر تحديث مسجل منذ ${days} يومًا (المدة المحددة ${stale}). مؤشر من السجلات فقط ولا يدل على عدم إنجاز عمل خارج البرنامج.`, lastDate, { type: 'case', id: c.id });
  }
  for (const t of d.openTasks.filter((t) => t.due_date && t.due_date < w.end)) add('مهمة متأخرة', t.title, `موعدها ${fmtDate(t.due_date)} ولم تُسجل مكتملة`, t.due_date, { type: 'task', id: t.id });
  for (const k of d.consults.filter((x) => ['pending', 'confirmed'].includes(String(x.status)) && String(x.ends_at) < w.endIso && String(x.ends_at) < ctx.now().toISOString()))
    add('موعد استشارة فات دون تحديث حالته', `${k.ref_no} — ${k.title}`, `الحالة «${labelOf(CONSULT_STATUSES, String(k.status))}» رغم مرور الموعد`, dateOfIso(String(k.starts_at)), { type: 'consultation', id: String(k.id) });
  for (const m of d.meetings.filter((x) => ['pending', 'confirmed'].includes(String(x.status)) && String(x.ends_at) < w.endIso && String(x.ends_at) < ctx.now().toISOString()))
    add('اجتماع فات دون تحديث حالته', `${m.ref_no} — ${m.title}`, `الحالة «${labelOf(MEETING_STATUSES, String(m.status))}» رغم مرور الموعد`, dateOfIso(String(m.starts_at)), { type: 'meeting', id: String(m.id) });
  for (const k of d.consults.filter((x) => x.status === 'done' && x.written_required)) {
    const n = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM consultation_opinions WHERE consultation_id = ? AND created_at < ?', [k.id, w.endIso])!.n;
    if (!n) add('استشارة منجزة دون استشارة مكتوبة', `${k.ref_no} — ${k.title}`, 'حُددت الاستشارة المكتوبة كمطلوبة ولم تُرفق بعد', dateOfIso(String(k.starts_at)), { type: 'consultation', id: String(k.id) });
  }
  if (d.canFees) {
    for (const k of d.consults) {
      const f = svcFinance(ctx, 'consultation', String(k.id), w.end);
      if (f.remaining && f.remaining > 0) add('استشارة برصيد غير مسدد', `${k.ref_no} — ${k.client_name}`, `المتبقي ${fmtAmount(f.remaining)} (${PAY_STATUSES[f.status].label})`, dateOfIso(String(k.starts_at)), { type: 'consultation', id: String(k.id) });
    }
  }
  const horizon = addDays(w.end, Math.max(0, input.expiringDays));
  const clientIds = d.clients.map((c) => c.id);
  if (clientIds.length) {
    const inC = clientIds.map(() => '?').join(',');
    for (const k of ctx.db.all<{ id: string; client_id: string; title: string; end_date: string; status: string }>(`SELECT id, client_id, title, end_date, status FROM contracts WHERE client_id IN (${inC}) AND status = 'active' AND end_date IS NOT NULL AND end_date <= ?`, [...clientIds, horizon]))
      add(k.end_date < w.end ? 'عقد انتهى تاريخه وما زال «ساريًا»' : 'عقد قريب من الانتهاء', k.title, `تاريخ النهاية المسجل ${fmtDate(k.end_date)}`, k.end_date, { type: 'client', id: k.client_id });
    for (const p of ctx.db.all<{ id: string; client_id: string; poa_no: string | null; expires_on: string }>(`SELECT id, client_id, poa_no, expires_on FROM poas WHERE client_id IN (${inC}) AND status = 'active' AND expires_on IS NOT NULL AND expires_on <= ?`, [...clientIds, horizon]))
      add(p.expires_on < w.end ? 'وكالة انتهى تاريخها وما زالت «سارية»' : 'وكالة قريبة من الانتهاء', `وكالة ${p.poa_no ?? 'بلا رقم'}`, `تاريخ الانتهاء المسجل ${fmtDate(p.expires_on)}`, p.expires_on, { type: 'client', id: p.client_id });
  }
  for (const c of d.clients.filter((x) => !x.phone)) add('بيانات أساسية ناقصة', c.name, 'لا يوجد رقم جوال مسجل', null, { type: 'client', id: c.id });
  for (const c of d.cases.filter((x) => d.statusAt(x) === 'active')) {
    const miss: string[] = [];
    if (!c.responsible_user_id) miss.push('المسؤول');
    if (!c.case_type) miss.push('نوع القضية');
    if (!ctx.db.get('SELECT 1 AS x FROM stages WHERE case_id = ?', [c.id])) miss.push('المرحلة والمحكمة');
    if (!ctx.db.get('SELECT 1 AS x FROM case_parties WHERE case_id = ? AND is_opponent = 1', [c.id])) miss.push('الخصم');
    if (miss.length) add('بيانات أساسية ناقصة', `${c.file_no} — ${c.title}`, `غير مسجل: ${miss.join('، ')}`, null, { type: 'case', id: c.id });
  }
  for (const k of d.consults.filter((x) => !x.responsible_user_id && ['pending', 'confirmed'].includes(String(x.status)))) add('بيانات أساسية ناقصة', `${k.ref_no} — ${k.title}`, 'لم يُحدد المسؤول عن الاستشارة', null, { type: 'consultation', id: String(k.id) });
  return {
    key: 'alerts',
    title: OFFICE_SECTIONS.alerts,
    notes: ['هذه مؤشرات مبنية على السجلات المدخلة في البرنامج فقط؛ غياب التحديث لا يعني عدم إنجاز العمل خارج البرنامج.'],
    allColumns: all,
    columns: pick2(input, all),
    rows,
  };
}

function pick2(input: OfficeReportInput, all: Col[]) {
  const chosen = input.columns.alerts;
  return chosen && chosen.length ? all.filter((c) => chosen.includes(c.key)) : all;
}

// ———————————————— العرض والتصدير ————————————————

const OPTIONAL_TEXT = new Set(['note', 'notes', 'method', 'detail']);

function fmtCell(c: Col, v: CellVal): string {
  if (v === null || v === undefined || v === '') return OPTIONAL_TEXT.has(c.key) ? '—' : NOT_RECORDED;
  if (c.kind === 'money') return fmtAmount(Number(v));
  if (c.kind === 'date') return fmtDate(String(v));
  if (c.kind === 'datetime') return fmtDateTime(String(v));
  return String(v);
}

export function renderOfficeReportHtml(r: OfficeReport): string {
  const td = (c: Col, v: CellVal) => {
    const s = fmtCell(c, v);
    const cls = (v === null || v === undefined || v === '') && !OPTIONAL_TEXT.has(c.key) ? 'nr' : c.kind === 'money' || c.kind === 'number' ? 'num' : c.kind === 'date' || c.kind === 'datetime' ? 'dt' : '';
    return `<td class="${cls}">${c.kind === 'money' || c.kind === 'number' ? `<bdi dir="ltr">${e(s)}</bdi>` : e(s).replace(/\n/g, '<br>')}</td>`;
  };
  const table = (columns: Col[], rows: Row[]) =>
    rows.length
      ? `<table><thead><tr>${columns.map((c) => `<th class="${c.kind === 'money' || c.kind === 'number' ? 'num' : ''}">${e(c.label)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${columns.map((c) => td(c, row.cells[c.key] ?? null)).join('')}</tr>${row.detail ? `<tr class="detail"><td colspan="${columns.length}">${e(row.detail).replace(/\n/g, '<br>')}</td></tr>` : ''}`)
          .join('')}</tbody></table>`
      : '<p class="empty">لا توجد سجلات ضمن النطاق والمرشحات.</p>';
  let body = '<h2>الملخص التنفيذي</h2>';
  for (const g of r.summary) {
    body += `<h3>${e(g.title)}</h3><table class="sum"><thead><tr><th>البند</th><th class="num">القيمة</th><th>أساس الاحتساب</th></tr></thead><tbody>${g.items
      .map((i) => `<tr><td>${e(i.label)}</td><td class="num"><bdi dir="ltr">${i.value === null ? NOT_RECORDED : e(i.money ? fmtAmount(i.value) : String(i.value))}</bdi></td><td class="basis">${e(i.basis)}</td></tr>`)
      .join('')}</tbody></table>`;
  }
  for (const s of r.sections) {
    body += `<section class="sec"><h2>${e(s.title)}</h2>${s.notes.map((n) => `<p class="snote">${e(n)}</p>`).join('')}`;
    if (s.groups) {
      if (!s.groups.length) body += '<p class="empty">لا توجد حركات مالية ضمن النطاق.</p>';
      for (const g of s.groups) body += `<h3>${e(g.title)}</h3>${table(s.columns, g.rows)}`;
    } else body += table(s.columns, s.rows);
    body += '</section>';
  }
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(r.meta.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:">
<style>
${reportFontCssText()}
@page { size: A4 landscape; margin: 12mm 10mm 16mm 10mm; }
* { box-sizing: border-box; }
body { font-family: 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif; color: #20252B; font-size: 9pt; line-height: 1.55; margin: 0; }
header.r { border-bottom: 2px solid #8A642F; padding-bottom: 6px; margin-bottom: 10px; }
.office { font-weight: 600; font-size: 12pt; }
h1 { font-size: 15pt; margin: 4px 0; font-weight: 600; }
.conf { display: inline-block; border: 1.5px solid #9F2D2D; color: #9F2D2D; padding: 0 8px; border-radius: 4px; font-weight: 600; font-size: 10pt; }
.meta { color: #4F5966; font-size: 8.5pt; display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 4px; }
.notice { background: #FFF2D9; color: #80551A; padding: 4px 8px; border-radius: 4px; margin: 4px 0; font-size: 8.5pt; }
h2 { font-size: 11.5pt; font-weight: 600; margin: 14px 0 4px; border-bottom: 1px solid #E3E5E8; padding-bottom: 2px; break-after: avoid; }
h3 { font-size: 10pt; font-weight: 600; margin: 8px 0 2px; break-after: avoid; }
table { width: 100%; border-collapse: collapse; table-layout: auto; margin: 2px 0 8px; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { border: 1px solid #D8DCE0; padding: 2px 4px; text-align: right; vertical-align: top; overflow-wrap: anywhere; word-break: normal; }
th { background: #F3ECDD; color: #6E5024; font-weight: 600; }
td.num, th.num { text-align: left; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.dt { white-space: nowrap; }
td.nr { color: #6B7480; font-style: italic; }
td.basis { color: #4F5966; font-size: 8pt; }
tr.detail td { background: #FAFAF8; font-size: 8.5pt; white-space: pre-wrap; }
table.sum { width: auto; min-width: 70%; }
.snote { color: #4F5966; font-size: 8.5pt; margin: 2px 0; }
.empty { color: #59636E; }
footer.r { margin-top: 14px; border-top: 1px solid #E3E5E8; padding-top: 4px; color: #59636E; font-size: 8pt; }
</style></head><body>
<header class="r"><div class="office">${e(r.meta.office)}</div>
<h1>${e(r.meta.title)} <span class="conf">${e(r.meta.confidential)}</span></h1>
<div class="meta"><span>تاريخ ووقت الاستخراج: <bdi dir="rtl">${e(fmtDateTime(r.meta.generatedAt))}</bdi></span><span>${e(r.meta.periodLabel)}</span><span>أنشأه: ${e(r.meta.generatedBy)}</span>
<span>المرشحات: ${r.meta.filters.length ? e(r.meta.filters.join('، ')) : 'بدون'}</span></div>
</header>
${r.notices.map((n) => `<div class="notice">${e(n)}</div>`).join('')}
${body}
<footer class="r">تقرير إداري داخلي لصاحب المكتب — لا يُسلَّم للعملاء. يعكس ما سُجّل في البرنامج فقط، و«${NOT_RECORDED}» تعني عدم وجود قيمة مسجلة وليست صفرًا. التواريخ بتوقيت الرياض.</footer>
</body></html>`;
}

export function officeReportSheets(r: OfficeReport): XSheet[] {
  const preface = [`${r.meta.title} — ${r.meta.confidential}`, r.meta.office, `${r.meta.periodLabel} — الاستخراج: ${fmtDateTime(r.meta.generatedAt)} — ${r.meta.generatedBy}`, `المرشحات: ${r.meta.filters.join('، ') || 'بدون'}`];
  const cell = (c: Col, v: CellVal): XCell => {
    if (v === null || v === undefined || v === '') return { t: 's', v: OPTIONAL_TEXT.has(c.key) ? '—' : NOT_RECORDED };
    if (c.kind === 'money') return { t: 'money', halalas: Number(v) };
    if (c.kind === 'number') return { t: 'n', v: Number(v) };
    return { t: 's', v: fmtCell(c, v) };
  };
  const sheets: XSheet[] = [
    {
      name: 'الملخص التنفيذي',
      preface,
      columns: [{ label: 'المجموعة', width: 18 }, { label: 'البند', width: 34 }, { label: 'القيمة', width: 18 }, { label: 'أساس الاحتساب', width: 80 }],
      rows: r.summary.flatMap((g) => g.items.map((i) => [{ t: 's', v: g.title }, { t: 's', v: i.label }, i.value === null ? { t: 's', v: NOT_RECORDED } : i.money ? { t: 'money', halalas: i.value } : { t: 'n', v: i.value }, { t: 's', v: i.basis }] as XCell[])),
    },
  ];
  for (const s of r.sections) {
    const columns = s.groups ? [{ key: '__group', label: 'العميل', kind: 'text' as const }, ...s.columns] : s.columns;
    const rows: XCell[][] = s.groups
      ? s.groups.flatMap((g) => g.rows.map((row) => [{ t: 's', v: g.title } as XCell, ...s.columns.map((c) => cell(c, row.cells[c.key] ?? null))]))
      : s.rows.map((row) => [...s.columns.map((c) => cell(c, row.cells[c.key] ?? null)), ...(s.rows.some((x) => x.detail) ? [{ t: 's', v: row.detail ?? '' } as XCell] : [])]);
    const extra = !s.groups && s.rows.some((x) => x.detail) ? [{ label: 'التفاصيل (سري)', width: 80 }] : [];
    sheets.push({
      name: s.title,
      preface: [...preface.slice(0, 1), ...s.notes],
      columns: [...columns.map((c) => ({ label: c.label, width: c.kind === 'money' ? 16 : c.kind === 'date' ? 13 : c.kind === 'datetime' ? 20 : Math.min(40, Math.max(14, c.label.length + 6)) })), ...extra],
      rows,
    });
  }
  return sheets;
}

export function generateOfficeReport(ctx: Ctx, input: OfficeReportInput) {
  const r = buildOfficeReport(ctx, input);
  logActivity(ctx, { action: 'report', entityType: 'office_report', summary: `إنشاء التقرير الشامل للمكتب — ${r.meta.periodLabel}${r.meta.filters.length ? ' — ' + r.meta.filters.join('، ') : ''}`, details: { sections: r.sections.map((s) => s.key), includeSensitive: input.includeSensitive, includeDetails: input.includeDetails } });
  return r;
}

export async function exportOfficeReport(ctx: Ctx, input: OfficeReportInput & { format: 'pdf' | 'xlsx' | 'print' }) {
  requirePerm(ctx, 'reports.officeExport', 'لا تملك صلاحية طباعة التقرير الشامل أو تصديره');
  const r = buildOfficeReport(ctx, input);
  const base = `التقرير الشامل للمكتب ${r.meta.end}`;
  const scope = `${r.meta.periodLabel}${r.meta.filters.length ? ' — ' + r.meta.filters.join('، ') : ''}${input.includeSensitive ? ' — مع البيانات الحساسة' : ''}${input.includeDetails ? ' — مع التفاصيل السرية' : ''}`;
  if (input.format === 'print') {
    if (!ctx.platform.printHtml) throw new AppError('INTERNAL', 'الطباعة غير متاحة');
    await ctx.platform.printHtml(renderOfficeReportHtml(r));
    logActivity(ctx, { action: 'export', entityType: 'office_report', summary: `طباعة التقرير الشامل — ${scope}` });
    return { saved: true as const, path: null };
  }
  const ext = input.format;
  const dest = await ctx.platform.showSaveFile({ title: ext === 'pdf' ? 'حفظ التقرير PDF' : 'تصدير جداول التقرير Excel', defaultName: `${base}.${ext}`, filters: [{ name: ext === 'pdf' ? 'PDF' : 'Excel', extensions: [ext] }] });
  if (!dest) return { saved: false as const, path: null };
  const final = dest.toLowerCase().endsWith(`.${ext}`) ? dest : `${dest}.${ext}`;
  let buf: Buffer;
  if (ext === 'pdf') {
    if (!ctx.platform.htmlToPdf) throw new AppError('INTERNAL', 'الحفظ PDF غير متاح');
    buf = await ctx.platform.htmlToPdf(renderOfficeReportHtml(r), { landscape: true, footer: `${r.meta.title} — ${r.meta.confidential} — استُخرج ${fmtDateTime(r.meta.generatedAt)}` });
  } else {
    buf = await buildXlsx(officeReportSheets(r), { title: r.meta.title, createdAt: r.meta.generatedAt });
  }
  try {
    fs.writeFileSync(final, buf);
  } catch (err) {
    throw new AppError('STORAGE', 'تعذر حفظ الملف: ' + (err as Error).message);
  }
  logActivity(ctx, { action: 'export', entityType: 'office_report', summary: `تصدير التقرير الشامل ${ext === 'pdf' ? 'PDF' : 'Excel'} — ${scope}`, details: { file: final } });
  return { saved: true as const, path: final };
}
