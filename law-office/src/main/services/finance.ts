// الأتعاب والعقود والوكالات. المبالغ بالهللة. العقد الشامل لعدة قضايا يُحسب مرة واحدة على مستوى العقد ولا يُكرر لكل قضية.
import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, forbidden, notFound } from '../errors';
import { fmtAmount } from '../../shared/money';
import type { ContractKind, ContractStatus, FeeType, PoaStatus } from '../../shared/constants';
import { caseScope, clientAccess, hasPerm, requireCase, requireClient, requirePerm, requireUser, canAccessCase } from './access';
import { logActivity } from './activity';

interface ContractRow {
  id: string;
  client_id: string;
  client_name: string;
  kind: ContractKind;
  parent_contract_id: string | null;
  title: string;
  contract_no: string | null;
  signed_on: string | null;
  start_date: string | null;
  end_date: string | null;
  scope: string;
  fee_type: FeeType;
  fixed_amount: number | null;
  percentage: number | null;
  percentage_basis: string | null;
  status: ContractStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** ملخص مالي لعقد واحد — مصدر الحقيقة الوحيد لحساب المدفوع والمتبقي. */
export function contractTotals(ctx: Ctx, contractId: string) {
  const k = ctx.db.get<{ fixed_amount: number | null; fee_type: FeeType }>('SELECT fixed_amount, fee_type FROM contracts WHERE id = ?', [contractId])!;
  const items = ctx.db.get<{ s: number | null; n: number }>('SELECT sum(amount) AS s, count(*) AS n FROM fee_items WHERE contract_id = ?', [contractId])!;
  const paid = ctx.db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM payments WHERE contract_id = ? AND voided = 0', [contractId])!.s ?? 0;
  // المقدم جزء من المسدد (دفعات معلّمة كدفعة مقدمة)
  const advance = ctx.db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM payments WHERE contract_id = ? AND voided = 0 AND is_advance = 1', [contractId])!.s ?? 0;
  const hasFixed = k.fee_type === 'fixed' || k.fee_type === 'mixed';
  const agreed = hasFixed ? (k.fixed_amount ?? (items.n ? items.s ?? 0 : 0)) : 0;
  return {
    agreed,
    advance,
    paid,
    remaining: Math.max(agreed - paid, 0),
    overpaid: Math.max(paid - agreed, 0),
    scheduleTotal: items.s ?? 0,
    scheduleMismatch: hasFixed && items.n > 0 && k.fixed_amount !== null && (items.s ?? 0) !== k.fixed_amount,
  };
}

function contractVisible(ctx: Ctx, k: { id: string; client_id: string }): boolean {
  const u = requireUser(ctx);
  if (u.role === 'owner') return true;
  if (clientAccess(ctx, k.client_id) === 'full') return true;
  const linked = ctx.db.all<{ case_id: string }>('SELECT case_id FROM contract_cases WHERE contract_id = ?', [k.id]);
  return linked.some((l) => canAccessCase(ctx, l.case_id));
}

function mapContract(ctx: Ctx, r: ContractRow) {
  const canFees = hasPerm(ctx, 'fees.view');
  const cases = ctx.db
    .all<{ id: string; file_no: string; title: string }>(
      'SELECT c.id, c.file_no, c.title FROM contract_cases cc JOIN cases c ON c.id = cc.case_id WHERE cc.contract_id = ? ORDER BY c.file_no',
      [r.id],
    )
    .map((c) => ({ id: c.id, fileNo: c.file_no, title: c.title, accessible: canAccessCase(ctx, c.id) }));
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    kind: r.kind,
    parentContractId: r.parent_contract_id,
    title: r.title,
    contractNo: r.contract_no,
    signedOn: r.signed_on,
    startDate: r.start_date,
    endDate: r.end_date,
    scope: r.scope,
    feeType: r.fee_type,
    status: r.status,
    notes: r.notes,
    cases,
    sharedAcrossCases: cases.length > 1,
    amountsHidden: !canFees,
    fixedAmount: canFees ? r.fixed_amount : null,
    percentage: canFees ? r.percentage : null,
    percentageBasis: canFees ? r.percentage_basis : null,
    totals: canFees ? contractTotals(ctx, r.id) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CONTRACT_SELECT = 'SELECT k.*, cl.name AS client_name FROM contracts k JOIN clients cl ON cl.id = k.client_id';

export function listContracts(ctx: Ctx, input: { clientId?: string | null; caseId?: string | null }) {
  requireUser(ctx);
  let rows: ContractRow[];
  if (input.caseId) {
    requireCase(ctx, input.caseId);
    rows = ctx.db.all<ContractRow>(`${CONTRACT_SELECT} JOIN contract_cases cc ON cc.contract_id = k.id WHERE cc.case_id = ? ORDER BY k.created_at`, [input.caseId]);
  } else if (input.clientId) {
    rows = ctx.db.all<ContractRow>(`${CONTRACT_SELECT} WHERE k.client_id = ? ORDER BY k.created_at`, [input.clientId]);
  } else {
    rows = ctx.db.all<ContractRow>(`${CONTRACT_SELECT} ORDER BY k.created_at DESC LIMIT 3000`);
  }
  return rows.filter((r) => contractVisible(ctx, r)).map((r) => mapContract(ctx, r));
}

export function getContract(ctx: Ctx, input: { id: string }) {
  const r = ctx.db.get<ContractRow>(`${CONTRACT_SELECT} WHERE k.id = ?`, [input.id]);
  if (!r) throw notFound('العقد');
  if (!contractVisible(ctx, r)) throw forbidden('لا تملك صلاحية الاطلاع على هذا العقد');
  const canFees = hasPerm(ctx, 'fees.view');
  return {
    contract: mapContract(ctx, r),
    feeItems: canFees
      ? ctx.db
          .all<{ id: string; title: string; amount: number; due_date: string | null; notes: string | null }>('SELECT * FROM fee_items WHERE contract_id = ? ORDER BY sort_order, created_at', [input.id])
          .map((i) => ({
            id: i.id,
            title: i.title,
            amount: i.amount,
            dueDate: i.due_date,
            notes: i.notes,
            paid: ctx.db.get<{ s: number | null }>('SELECT sum(amount) AS s FROM payments WHERE fee_item_id = ? AND voided = 0', [i.id])!.s ?? 0,
          }))
      : [],
    payments: canFees ? listPayments(ctx, { contractId: input.id }) : [],
  };
}

interface ContractInput {
  clientId: string;
  kind: ContractKind;
  parentContractId: string | null;
  title: string;
  contractNo: string | null;
  signedOn: string | null;
  startDate: string | null;
  endDate: string | null;
  scope: string;
  feeType: FeeType;
  fixedAmount: number | null;
  percentage: number | null;
  percentageBasis: string | null;
  status: ContractStatus;
  notes: string | null;
  caseIds: string[];
}

function validateContract(ctx: Ctx, input: ContractInput, selfId?: string) {
  const errs: Record<string, string> = {};
  if ((input.feeType === 'fixed' || input.feeType === 'mixed') && input.fixedAmount === null) errs.fixedAmount = 'أدخل مبلغ الأتعاب الثابتة';
  if ((input.feeType === 'percentage' || input.feeType === 'mixed') && (input.percentage === null || !input.percentageBasis))
    errs.percentage = 'أدخل النسبة وأساس الاحتساب';
  if (input.startDate && input.endDate && input.endDate < input.startDate) errs.endDate = 'تاريخ النهاية قبل البداية';
  if (input.kind === 'addendum' && !input.parentContractId) errs.parentContractId = 'اختر العقد الأصلي للملحق';
  if (input.parentContractId) {
    const p = ctx.db.get<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = ?', [input.parentContractId]);
    if (!p || p.client_id !== input.clientId || input.parentContractId === selfId) errs.parentContractId = 'العقد الأصلي لا يتبع هذا العميل';
  }
  for (const cid of input.caseIds) {
    const c = ctx.db.get<{ client_id: string }>('SELECT client_id FROM cases WHERE id = ?', [cid]);
    if (!c || c.client_id !== input.clientId) {
      errs.caseIds = 'إحدى القضايا المختارة لا تتبع هذا العميل';
      break;
    }
  }
  if (Object.keys(errs).length) throw new AppError('VALIDATION', 'تحقق من بيانات العقد', errs);
}

function contractParams(input: ContractInput) {
  return {
    kind: input.kind,
    parent_contract_id: input.parentContractId,
    title: input.title,
    contract_no: input.contractNo,
    signed_on: input.signedOn,
    start_date: input.startDate,
    end_date: input.endDate,
    scope: input.scope,
    fee_type: input.feeType,
    fixed_amount: input.feeType === 'fixed' || input.feeType === 'mixed' ? input.fixedAmount : null,
    percentage: input.feeType === 'percentage' || input.feeType === 'mixed' ? input.percentage : null,
    percentage_basis: input.feeType === 'percentage' || input.feeType === 'mixed' ? input.percentageBasis : null,
    status: input.status,
    notes: input.notes,
  };
}

function setContractCases(ctx: Ctx, contractId: string, caseIds: string[]) {
  ctx.db.run('DELETE FROM contract_cases WHERE contract_id = ?', [contractId]);
  for (const cid of new Set(caseIds)) ctx.db.run('INSERT INTO contract_cases (contract_id, case_id) VALUES (?, ?)', [contractId, cid]);
}

export function createContract(ctx: Ctx, input: ContractInput) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تسجيل العقود المالية');
  requireClient(ctx, input.clientId, 'full');
  validateContract(ctx, input);
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO contracts (id, client_id, kind, parent_contract_id, title, contract_no, signed_on, start_date, end_date, scope, fee_type, fixed_amount, percentage,
         percentage_basis, status, notes, created_by, created_at, updated_by, updated_at)
       VALUES (:id, :client_id, :kind, :parent_contract_id, :title, :contract_no, :signed_on, :start_date, :end_date, :scope, :fee_type, :fixed_amount, :percentage,
         :percentage_basis, :status, :notes, :uid, :now, :uid, :now)`,
      { id, client_id: input.clientId, ...contractParams(input), uid: ctx.user!.id, now },
    );
    setContractCases(ctx, id, input.caseIds);
    logActivity(ctx, {
      action: 'create',
      entityType: 'contract',
      entityId: id,
      clientId: input.clientId,
      summary: `تسجيل عقد: ${input.title}${input.caseIds.length ? ` يشمل ${input.caseIds.length} قضية` : ''}${input.fixedAmount ? ' — ' + fmtAmount(input.fixedAmount) : ''}`,
    });
  });
  return { id };
}

export function updateContract(ctx: Ctx, input: ContractInput & { id: string }) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تعديل العقود المالية');
  const k = ctx.db.get<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = ?', [input.id]);
  if (!k) throw notFound('العقد');
  if (k.client_id !== input.clientId) throw new AppError('VALIDATION', 'لا يمكن نقل العقد لعميل آخر', { clientId: 'العميل ثابت' });
  requireClient(ctx, input.clientId, 'full');
  validateContract(ctx, input, input.id);
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE contracts SET kind = :kind, parent_contract_id = :parent_contract_id, title = :title, contract_no = :contract_no, signed_on = :signed_on,
         start_date = :start_date, end_date = :end_date, scope = :scope, fee_type = :fee_type, fixed_amount = :fixed_amount, percentage = :percentage,
         percentage_basis = :percentage_basis, status = :status, notes = :notes, updated_by = :uid, updated_at = :now WHERE id = :id`,
      { id: input.id, ...contractParams(input), uid: ctx.user!.id, now: ctx.now().toISOString() },
    );
    setContractCases(ctx, input.id, input.caseIds);
    logActivity(ctx, { action: 'update', entityType: 'contract', entityId: input.id, clientId: input.clientId, summary: `تعديل عقد: ${input.title}` });
  });
  return { ok: true };
}

export function saveFeeItem(ctx: Ctx, input: { id: string | null; contractId: string; title: string; amount: number; dueDate: string | null; notes: string | null }) {
  requirePerm(ctx, 'fees.manage');
  const k = ctx.db.get<{ client_id: string; title: string }>('SELECT client_id, title FROM contracts WHERE id = ?', [input.contractId]);
  if (!k) throw notFound('العقد');
  requireClient(ctx, k.client_id, 'full');
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ contract_id: string }>('SELECT contract_id FROM fee_items WHERE id = ?', [id]);
      if (!ex || ex.contract_id !== input.contractId) throw notFound('البند');
      ctx.db.run('UPDATE fee_items SET title = ?, amount = ?, due_date = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.title, input.amount, input.dueDate, input.notes, ctx.user!.id, now, id]);
    } else {
      id = uuid();
      const max = ctx.db.get<{ m: number | null }>('SELECT max(sort_order) AS m FROM fee_items WHERE contract_id = ?', [input.contractId]);
      ctx.db.run(
        'INSERT INTO fee_items (id, contract_id, title, amount, due_date, notes, sort_order, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, input.contractId, input.title, input.amount, input.dueDate, input.notes, (max?.m ?? 0) + 10, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'fee_item', entityId: id, clientId: k.client_id, summary: `بند مالي في «${k.title}»: ${input.title} — ${fmtAmount(input.amount)}` });
  });
  return { id };
}

export function listPayments(ctx: Ctx, input: { contractId?: string | null; clientId?: string | null }) {
  requirePerm(ctx, 'fees.view');
  const where: string[] = [];
  const p: unknown[] = [];
  if (input.contractId) {
    where.push('p.contract_id = ?');
    p.push(input.contractId);
  }
  if (input.clientId) {
    where.push('p.client_id = ?');
    p.push(input.clientId);
  }
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT p.*, k.title AS contract_title, fi.title AS item_title, u.display_name AS by_name,
         (SELECT d.id FROM documents d WHERE d.payment_id = p.id AND d.archived_at IS NULL LIMIT 1) AS receipt_document_id
       FROM payments p JOIN contracts k ON k.id = p.contract_id LEFT JOIN fee_items fi ON fi.id = p.fee_item_id LEFT JOIN users u ON u.id = p.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.paid_on DESC, p.created_at DESC`,
      p,
    )
    .filter((r) => contractVisible(ctx, { id: String(r.contract_id), client_id: String(r.client_id) }))
    .map((r) => ({
      id: String(r.id),
      clientId: String(r.client_id),
      contractId: String(r.contract_id),
      contractTitle: String(r.contract_title),
      feeItemId: r.fee_item_id as string | null,
      feeItemTitle: r.item_title as string | null,
      amount: Number(r.amount),
      paidOn: String(r.paid_on),
      method: r.method as string | null,
      referenceNo: r.reference_no as string | null,
      notes: r.notes as string | null,
      voided: !!r.voided,
      isAdvance: !!r.is_advance,
      voidReason: r.void_reason as string | null,
      byName: r.by_name as string | null,
      receiptDocumentId: r.receipt_document_id as string | null,
    }));
}

export function createPayment(
  ctx: Ctx,
  input: { contractId: string; feeItemId: string | null; amount: number; paidOn: string; method: string | null; referenceNo: string | null; notes: string | null; isAdvance?: boolean },
) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تسجيل الدفعات');
  const k = ctx.db.get<{ id: string; client_id: string; title: string; fee_type: string }>('SELECT id, client_id, title, fee_type FROM contracts WHERE id = ?', [input.contractId]);
  if (!k) throw new AppError('VALIDATION', 'العقد غير موجود', { contractId: 'اختر العقد' });
  if (!contractVisible(ctx, k)) throw forbidden();
  if (input.feeItemId) {
    const it = ctx.db.get<{ contract_id: string }>('SELECT contract_id FROM fee_items WHERE id = ?', [input.feeItemId]);
    if (!it || it.contract_id !== input.contractId) throw new AppError('VALIDATION', 'البند لا يتبع العقد المختار', { feeItemId: 'اختر بندًا من بنود العقد' });
  }
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO payments (id, client_id, contract_id, fee_item_id, amount, paid_on, method, reference_no, notes, is_advance, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, k.client_id, input.contractId, input.feeItemId, input.amount, input.paidOn, input.method, input.referenceNo, input.notes, !!input.isAdvance, ctx.user!.id, now, ctx.user!.id, now],
    );
    logActivity(ctx, { action: 'create', entityType: 'payment', entityId: id, clientId: k.client_id, summary: `تسجيل ${input.isAdvance ? 'دفعة مقدمة' : 'دفعة'} ${fmtAmount(input.amount)} على «${k.title}» بتاريخ ${input.paidOn}` });
  });
  return { id, totals: contractTotals(ctx, input.contractId) };
}

export function voidPayment(ctx: Ctx, input: { id: string; reason: string }) {
  requirePerm(ctx, 'fees.manage');
  const p = ctx.db.get<{ client_id: string; contract_id: string; amount: number; voided: number }>('SELECT client_id, contract_id, amount, voided FROM payments WHERE id = ?', [input.id]);
  if (!p) throw notFound('الدفعة');
  requireClient(ctx, p.client_id, 'basic');
  if (p.voided) return { ok: true };
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE payments SET voided = 1, void_reason = ?, voided_at = ?, voided_by = ?, updated_by = ?, updated_at = ? WHERE id = ?', [input.reason, now, ctx.user!.id, ctx.user!.id, now, input.id]);
    logActivity(ctx, { action: 'void', entityType: 'payment', entityId: input.id, clientId: p.client_id, summary: `إلغاء دفعة ${fmtAmount(p.amount)}: ${input.reason}` });
  });
  return { ok: true };
}

export function listExpenses(ctx: Ctx, input: { clientId?: string | null; caseId?: string | null }) {
  requirePerm(ctx, 'fees.view');
  const where: string[] = [];
  const p: unknown[] = [];
  if (input.clientId) {
    where.push('e.client_id = ?');
    p.push(input.clientId);
  }
  if (input.caseId) {
    where.push('e.case_id = ?');
    p.push(input.caseId);
  }
  return ctx.db
    .all<Record<string, string | number | null>>(
      `SELECT e.*, c.file_no FROM expenses e LEFT JOIN cases c ON c.id = e.case_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.spent_on DESC`,
      p,
    )
    .filter((r) => (r.case_id ? canAccessCase(ctx, String(r.case_id)) : clientAccess(ctx, String(r.client_id)) === 'full'))
    .map((r) => ({
      id: String(r.id),
      clientId: String(r.client_id),
      caseId: r.case_id as string | null,
      caseFileNo: r.file_no as string | null,
      contractId: r.contract_id as string | null,
      title: String(r.title),
      amount: Number(r.amount),
      spentOn: String(r.spent_on),
      recoverable: !!r.recoverable,
      reimbursedOn: r.reimbursed_on as string | null,
      notes: r.notes as string | null,
    }));
}

export function saveExpense(
  ctx: Ctx,
  input: { id: string | null; clientId: string; caseId: string | null; contractId: string | null; title: string; amount: number; spentOn: string; recoverable: boolean; reimbursedOn: string | null; notes: string | null },
) {
  requirePerm(ctx, 'fees.manage', 'لا تملك صلاحية تسجيل المصاريف');
  if (input.caseId) {
    const c = requireCase(ctx, input.caseId);
    if (c.client_id !== input.clientId) throw new AppError('VALIDATION', 'القضية لا تتبع العميل', { caseId: 'اختيار غير صالح' });
  } else requireClient(ctx, input.clientId, 'full');
  if (input.contractId) {
    const k = ctx.db.get<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = ?', [input.contractId]);
    if (!k || k.client_id !== input.clientId) throw new AppError('VALIDATION', 'العقد لا يتبع العميل', { contractId: 'اختيار غير صالح' });
  }
  const now = ctx.now().toISOString();
  let id = input.id;
  ctx.db.tx(() => {
    if (id) {
      const ex = ctx.db.get<{ client_id: string }>('SELECT client_id FROM expenses WHERE id = ?', [id]);
      if (!ex || ex.client_id !== input.clientId) throw notFound('المصروف');
      ctx.db.run(
        'UPDATE expenses SET case_id = ?, contract_id = ?, title = ?, amount = ?, spent_on = ?, recoverable = ?, reimbursed_on = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        [input.caseId, input.contractId, input.title, input.amount, input.spentOn, input.recoverable, input.reimbursedOn, input.notes, ctx.user!.id, now, id],
      );
    } else {
      id = uuid();
      ctx.db.run(
        `INSERT INTO expenses (id, client_id, case_id, contract_id, title, amount, spent_on, recoverable, reimbursed_on, notes, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.clientId, input.caseId, input.contractId, input.title, input.amount, input.spentOn, input.recoverable, input.reimbursedOn, input.notes, ctx.user!.id, now, ctx.user!.id, now],
      );
    }
    logActivity(ctx, { action: input.id ? 'update' : 'create', entityType: 'expense', entityId: id, caseId: input.caseId, clientId: input.clientId, summary: `مصروف: ${input.title} — ${fmtAmount(input.amount)}` });
  });
  return { id };
}

/** ملخص مالي للعميل: يجمع العقود المميزة مرة واحدة فقط مهما كان عدد القضايا المرتبطة بكل عقد. */
export function clientFinanceSummary(ctx: Ctx, clientId: string) {
  requirePerm(ctx, 'fees.view');
  const contracts = listContracts(ctx, { clientId });
  let agreed = 0;
  let advance = 0;
  let paid = 0;
  let remaining = 0;
  const percentage: { contractId: string; title: string; percentage: number | null; basis: string | null }[] = [];
  for (const k of contracts) {
    if (k.totals) {
      agreed += k.totals.agreed;
      advance += k.totals.advance;
      paid += k.totals.paid;
      remaining += k.totals.remaining;
    }
    if (k.feeType === 'percentage' || k.feeType === 'mixed') percentage.push({ contractId: k.id, title: k.title, percentage: k.percentage, basis: k.percentageBasis });
  }
  const expenses = listExpenses(ctx, { clientId });
  const expTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const expOutstanding = expenses.filter((e) => e.recoverable && !e.reimbursedOn).reduce((s, e) => s + e.amount, 0);
  return {
    contractCount: contracts.length,
    agreed,
    advance,
    paid,
    remaining,
    percentage,
    expenses: { total: expTotal, outstandingRecoverable: expOutstanding, count: expenses.length },
  };
}

/** ملخص مالي على مستوى المكتب (المستحقات المسجلة). */
export function officeFinanceSummary(ctx: Ctx) {
  requirePerm(ctx, 'fees.view');
  const contracts = listContracts(ctx, {});
  const t = contracts.reduce(
    (acc, k) => {
      if (k.totals) {
        acc.agreed += k.totals.agreed;
        acc.paid += k.totals.paid;
        acc.remaining += k.totals.remaining;
      }
      return acc;
    },
    { agreed: 0, paid: 0, remaining: 0 },
  );
  return { ...t, contractCount: contracts.length };
}

// ———————— الوكالات ————————
interface PoaInput {
  clientId: string;
  poaNo: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  hijriText: string | null;
  scope: string;
  agents: string | null;
  status: PoaStatus;
  notes: string | null;
  caseIds: string[];
}

function poaVisible(ctx: Ctx, p: { id: string; client_id: string }) {
  const u = requireUser(ctx);
  if (u.role === 'owner' || clientAccess(ctx, p.client_id) === 'full') return true;
  return ctx.db.all<{ case_id: string }>('SELECT case_id FROM poa_cases WHERE poa_id = ?', [p.id]).some((r) => canAccessCase(ctx, r.case_id));
}

export function listPoas(ctx: Ctx, input: { clientId?: string | null; caseId?: string | null }) {
  requireUser(ctx);
  let rows: Record<string, string | null>[];
  if (input.caseId) {
    requireCase(ctx, input.caseId);
    rows = ctx.db.all('SELECT p.* FROM poas p JOIN poa_cases pc ON pc.poa_id = p.id WHERE pc.case_id = ? ORDER BY p.issued_on', [input.caseId]);
  } else if (input.clientId) rows = ctx.db.all('SELECT * FROM poas WHERE client_id = ? ORDER BY issued_on', [input.clientId]);
  else {
    const scope = caseScope(ctx, 'pc.case_id');
    rows = ctx.db.all(`SELECT DISTINCT p.* FROM poas p LEFT JOIN poa_cases pc ON pc.poa_id = p.id WHERE ${scope.sql} OR ${requireUser(ctx).role === 'owner' ? '1=1' : '0'} ORDER BY p.issued_on`, scope.params);
  }
  return rows
    .filter((r) => poaVisible(ctx, { id: r.id!, client_id: r.client_id! }))
    .map((r) => ({
      id: r.id!,
      clientId: r.client_id!,
      poaNo: r.poa_no,
      issuer: r.issuer,
      issuedOn: r.issued_on,
      expiresOn: r.expires_on,
      hijriText: r.hijri_text,
      scope: r.scope!,
      agents: r.agents,
      status: r.status as PoaStatus,
      notes: r.notes,
      cases: ctx.db
        .all<{ id: string; file_no: string; title: string }>('SELECT c.id, c.file_no, c.title FROM poa_cases pc JOIN cases c ON c.id = pc.case_id WHERE pc.poa_id = ?', [r.id])
        .map((c) => ({ id: c.id, fileNo: c.file_no, title: c.title })),
    }));
}

function validatePoa(ctx: Ctx, input: PoaInput) {
  if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) throw new AppError('VALIDATION', 'تحقق من التواريخ', { expiresOn: 'تاريخ الانتهاء قبل الإصدار' });
  for (const cid of input.caseIds) {
    const c = ctx.db.get<{ client_id: string }>('SELECT client_id FROM cases WHERE id = ?', [cid]);
    if (!c || c.client_id !== input.clientId) throw new AppError('VALIDATION', 'إحدى القضايا لا تتبع هذا العميل', { caseIds: 'اختيار غير صالح' });
  }
}

export function createPoa(ctx: Ctx, input: PoaInput) {
  requireClient(ctx, input.clientId, 'full');
  validatePoa(ctx, input);
  const id = uuid();
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO poas (id, client_id, poa_no, issuer, issued_on, expires_on, hijri_text, scope, agents, status, notes, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.clientId, input.poaNo, input.issuer, input.issuedOn, input.expiresOn, input.hijriText, input.scope, input.agents, input.status, input.notes, ctx.user!.id, now, ctx.user!.id, now],
    );
    for (const cid of new Set(input.caseIds)) ctx.db.run('INSERT INTO poa_cases (poa_id, case_id) VALUES (?, ?)', [id, cid]);
    logActivity(ctx, { action: 'create', entityType: 'poa', entityId: id, clientId: input.clientId, summary: `تسجيل وكالة${input.poaNo ? ' رقم ' + input.poaNo : ''} تشمل ${input.caseIds.length} قضية` });
  });
  return { id };
}

export function updatePoa(ctx: Ctx, input: PoaInput & { id: string }) {
  const p = ctx.db.get<{ client_id: string }>('SELECT client_id FROM poas WHERE id = ?', [input.id]);
  if (!p) throw notFound('الوكالة');
  if (p.client_id !== input.clientId) throw new AppError('VALIDATION', 'لا يمكن نقل الوكالة لعميل آخر', { clientId: 'العميل ثابت' });
  requireClient(ctx, input.clientId, 'full');
  validatePoa(ctx, input);
  ctx.db.tx(() => {
    ctx.db.run(
      'UPDATE poas SET poa_no = ?, issuer = ?, issued_on = ?, expires_on = ?, hijri_text = ?, scope = ?, agents = ?, status = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      [input.poaNo, input.issuer, input.issuedOn, input.expiresOn, input.hijriText, input.scope, input.agents, input.status, input.notes, ctx.user!.id, ctx.now().toISOString(), input.id],
    );
    ctx.db.run('DELETE FROM poa_cases WHERE poa_id = ?', [input.id]);
    for (const cid of new Set(input.caseIds)) ctx.db.run('INSERT INTO poa_cases (poa_id, case_id) VALUES (?, ?)', [input.id, cid]);
    logActivity(ctx, { action: 'update', entityType: 'poa', entityId: input.id, clientId: input.clientId, summary: `تعديل وكالة${input.poaNo ? ' رقم ' + input.poaNo : ''}` });
  });
  return { ok: true };
}
