// التقارير العربية القابلة للطباعة والحفظ PDF. تُبنى HTML ثابتة (بلا سكربتات) بخط مضمّن محليًا.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context';
import { AppError } from '../errors';
import { escapeHtml as e } from '../../shared/text';
import { fmtAmount } from '../../shared/money';
import { addDays, fmtDate, fmtDateTime, todayRiyadh } from '../../shared/dates';
import {
  CASE_STATUSES,
  CLIENT_KINDS,
  CONTRACT_KINDS,
  CONTRACT_STATUSES,
  DOC_CATEGORIES,
  DEADLINE_STATUSES,
  FEE_TYPES,
  FOLLOW_STATUSES,
  HEARING_STATUSES,
  JUDGMENT_FOLLOW,
  MEMO_STATUSES,
  MEMO_TYPES,
  POA_STATUSES,
  PRIORITIES,
  STAGE_STATUSES,
  TASK_STATUSES,
  labelOf,
} from '../../shared/constants';
import { ANALYSIS_SECTIONS } from '../../shared/schemas';
import { hasPerm, requirePerm, requireUser, requireCase, requireClient } from './access';
import { readSetting } from './settings';
import { getCase } from './cases';
import { listHearingsForCase } from './hearings';
import { listDeadlines, listJudgments } from './judgments';
import { listMemos } from './memos';
import { listTasks } from './tasks';
import { listDocuments } from './documents';
import { getAnalysis } from './analysis';
import { clientFinanceSummary, listContracts, listExpenses, listPayments, listPoas } from './finance';
import { listComms, listNotes } from './notes';
import { getClient } from './clients';
import { calendarEvents } from './calendar';
import { logActivity } from './activity';

export interface ReportInput {
  type: 'case' | 'client' | 'hearings' | 'tasks' | 'fees';
  caseId: string | null;
  clientId: string | null;
  from: string | null;
  to: string | null;
  assigneeUserId: string | null;
  options: { includeInternalNotes: boolean; includeAnalysis: boolean; includeFees: boolean; includeTasks: boolean; includeDocuments: boolean };
}

let fontCss: string | null = null;
export function loadReportFonts(fontsDir: string) {
  const faces: string[] = [];
  for (const w of [400, 500, 600]) {
    for (const subset of ['arabic', 'latin']) {
      const f = path.join(fontsDir, `ibm-plex-sans-arabic-${subset}-${w}-normal.woff2`);
      if (fs.existsSync(f)) {
        faces.push(
          `@font-face{font-family:'IBM Plex Sans Arabic';font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2');${subset === 'latin' ? 'unicode-range:U+0000-00FF,U+2000-206F;' : ''}}`,
        );
      }
    }
  }
  fontCss = faces.join('\n');
}

const ltr = (s: string | null | undefined) => (s ? `<bdi dir="ltr" class="ltr">${e(s)}</bdi>` : '—');
const dt = (s: string | null | undefined) => (s ? `<bdi dir="rtl">${e(s)}</bdi>` : '—');
const txt = (s: string | null | undefined) => (s ? e(s).replace(/\n/g, '<br>') : '—');
const badge = (label: string) => `<span class="badge">${e(label)}</span>`;

function table(headers: string[], rows: string[][], empty = 'لا توجد سجلات'): string {
  if (!rows.length) return `<p class="empty">${e(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}
function kv(pairs: [string, string][]): string {
  return `<table class="kv"><tbody>${pairs.map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table>`;
}

function shell(ctx: Ctx, title: string, subtitle: string, lastUpdate: string | null, body: string, notes: string[] = []): string {
  const office = readSetting(ctx.db, 'office.name');
  const footer = readSetting(ctx.db, 'reports.footer');
  const contact = [readSetting(ctx.db, 'office.phone'), readSetting(ctx.db, 'office.email'), readSetting(ctx.db, 'office.address')].filter(Boolean).join(' — ');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<style>
${fontCss ?? ''}
@page { size: A4; margin: 16mm 14mm 18mm 14mm; }
* { box-sizing: border-box; }
body { font-family: 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif; color: #20252B; font-size: 11.5pt; line-height: 1.75; margin: 0; background: #fff; }
.wrap { max-width: 190mm; margin: 0 auto; padding: 8px 0; }
header.r { border-bottom: 2px solid #8A642F; padding-bottom: 8px; margin-bottom: 14px; }
header.r .office { font-weight: 600; font-size: 13pt; }
header.r .contact { color: #59636E; font-size: 9.5pt; }
h1 { font-size: 16pt; margin: 6px 0 2px; font-weight: 600; }
.sub { color: #59636E; font-size: 10pt; }
.meta { display: flex; gap: 18px; flex-wrap: wrap; color: #59636E; font-size: 9.5pt; margin-top: 6px; }
h2 { font-size: 12.5pt; font-weight: 600; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #E3E5E8; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 10pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #E3E5E8; padding: 4px 6px; text-align: right; vertical-align: top; }
thead th { background: #F3ECDD; color: #6E5024; font-weight: 600; }
table.kv th { width: 30%; background: #F7F7F5; font-weight: 500; }
.ltr { direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 0 6px; border: 1px solid #D8DCE0; border-radius: 4px; font-size: 9pt; background: #EEF0F3; color: #4F5966; }
.empty { color: #59636E; font-style: normal; }
.note { background: #FFF2D9; color: #80551A; padding: 6px 10px; border-radius: 6px; font-size: 9.5pt; margin: 8px 0; }
.text-block { white-space: pre-wrap; border: 1px solid #E3E5E8; border-radius: 6px; padding: 6px 10px; margin: 4px 0 8px; }
footer.r { margin-top: 20px; border-top: 1px solid #E3E5E8; padding-top: 6px; color: #59636E; font-size: 9pt; }
.src { color: #59636E; font-size: 9pt; }
</style></head><body><div class="wrap">
<header class="r"><div class="office">${e(office)}</div>${contact ? `<div class="contact">${e(contact)}</div>` : ''}
<h1>${e(title)}</h1><div class="sub">${subtitle}</div>
<div class="meta"><span>تاريخ الاستخراج: ${dt(fmtDateTime(ctx.now().toISOString()))}</span><span>آخر تحديث مسجل: ${lastUpdate ? dt(fmtDateTime(lastUpdate)) : '—'}</span><span>استخرجه: ${e(ctx.user?.displayName ?? '')}</span></div>
</header>
${notes.map((n) => `<div class="note">${e(n)}</div>`).join('')}
${body}
<footer class="r">يعكس هذا التقرير ما سُجّل في البرنامج حتى تاريخ استخراجه فقط؛ عدم ظهور واقعة لا يعني بالضرورة عدم حدوثها. التواريخ بتوقيت الرياض.${footer ? '<br>' + e(footer) : ''}</footer>
</div></body></html>`;
}

function maxUpdated(ctx: Ctx, caseIds: string[], clientId: string | null): string | null {
  const vals: (string | null)[] = [];
  const q = (sql: string, p: unknown[]) => vals.push(ctx.db.get<{ m: string | null }>(sql, p)?.m ?? null);
  for (const id of caseIds) {
    q('SELECT max(updated_at) AS m FROM cases WHERE id = ?', [id]);
    for (const t of ['hearings', 'judgments', 'memos', 'documents', 'tasks', 'stages', 'deadlines']) q(`SELECT max(updated_at) AS m FROM ${t} WHERE case_id = ?`, [id]);
  }
  if (clientId) {
    q('SELECT max(updated_at) AS m FROM clients WHERE id = ?', [clientId]);
    q('SELECT max(updated_at) AS m FROM contracts WHERE client_id = ?', [clientId]);
    q('SELECT max(updated_at) AS m FROM payments WHERE client_id = ?', [clientId]);
  }
  return vals.filter(Boolean).sort().pop() ?? null;
}

function caseReport(ctx: Ctx, input: ReportInput) {
  if (!input.caseId) throw new AppError('VALIDATION', 'اختر القضية', { caseId: 'اختر القضية' });
  const d = getCase(ctx, { id: input.caseId });
  const c = d.case;
  const o = input.options;
  const hearings = listHearingsForCase(ctx, c.id);
  const judgments = listJudgments(ctx, c.id);
  const deadlines = listDeadlines(ctx, c.id);
  const memos = listMemos(ctx, c.id);
  const stageName = (id: string | null) => d.stages.find((s) => s.id === id)?.stageType ?? '—';
  const minutes = new Set(
    ctx.db.all<{ hearing_id: string }>("SELECT DISTINCT hearing_id FROM documents WHERE case_id = ? AND category = 'minutes' AND hearing_id IS NOT NULL AND archived_at IS NULL", [c.id]).map((r) => r.hearing_id),
  );
  const judgmentDocs = new Set(
    ctx.db.all<{ judgment_id: string }>('SELECT DISTINCT judgment_id FROM documents WHERE case_id = ? AND judgment_id IS NOT NULL AND archived_at IS NULL', [c.id]).map((r) => r.judgment_id),
  );
  let body = '<h2>بيانات الملف</h2>' + kv([
    ['رقم الملف الداخلي', ltr(c.fileNo)],
    ['عنوان القضية', e(c.title)],
    ['العميل', e(d.client.name)],
    ['نوع القضية', e(c.caseType ?? '—')],
    ['حالة الملف', badge(labelOf(CASE_STATUSES, c.status)) + (c.archived ? ' ' + badge('مؤرشف') : '')],
    ['حالة المتابعة', badge(labelOf(FOLLOW_STATUSES, c.followStatus))],
    ['الأولوية', e(labelOf(PRIORITIES, c.priority))],
    ['المسؤول', e(c.responsibleName ?? '—')],
    ['تاريخ فتح الملف', c.openedOn ? ltr(fmtDate(c.openedOn)) : '—'],
    ['مبلغ المطالبة', c.claimAmount !== null ? ltr(fmtAmount(c.claimAmount)) : 'غير مسجل'],
    ['الموضوع', txt(c.subject)],
    ['الطلبات', txt(c.requests)],
    ...(c.status === 'closed' ? ([['النتيجة المسجلة عند الإقفال', txt(c.outcome)]] as [string, string][]) : []),
  ]);
  body += '<h2>الأطراف</h2>' + table(['الاسم', 'الصفة', 'خصم', 'الممثل'], d.parties.map((p) => [e(p.name), e(p.role ?? '—'), p.isOpponent ? 'نعم' : 'لا', e(p.representative ?? '—')]));
  body +=
    '<h2>مراحل التقاضي</h2>' +
    table(
      ['المرحلة', 'الجهة القضائية', 'المحكمة / الدائرة', 'رقم القضية الرسمي', 'البداية', 'الحالة'],
      d.stages.map((s) => [e(s.stageType), e(s.courtType ?? '—'), e([s.courtName, s.circuit].filter(Boolean).join(' / ') || '—'), ltr(s.officialCaseNo), s.startedOn ? ltr(fmtDate(s.startedOn)) : '—', e(labelOf(STAGE_STATUSES, s.status))]),
      'لم تُسجل مراحل',
    );
  body +=
    '<h2>الجلسات</h2>' +
    table(
      ['الموعد', 'المرحلة', 'الحالة', 'النتيجة / الملخص', 'المصدر'],
      hearings.map((h) => [
        dt(fmtDateTime(h.startsAt)) + (h.confirmed ? '' : '<br><span class="src">موعد غير مؤكد</span>'),
        e(stageName(h.stageId)),
        e(labelOf(HEARING_STATUSES, h.status)),
        txt([h.outcome, h.summary].filter(Boolean).join('\n') || null),
        `<span class="src">${minutes.has(h.id) ? 'ضبط الجلسة مرفق' : 'إدخال يدوي'}</span>`,
      ]),
      'لم تُسجل جلسات',
    );
  body +=
    '<h2>الأحكام والقرارات</h2>' +
    table(
      ['الرقم', 'التاريخ', 'المرحلة', 'خلاصة المنطوق (كما سجلها المستخدم)', 'المتابعة', 'المصدر'],
      judgments.map((j) => [ltr(j.judgmentNo), j.judgmentDate ? ltr(fmtDate(j.judgmentDate)) : '—', e(stageName(j.stageId)), txt(j.summary), e(labelOf(JUDGMENT_FOLLOW, j.followStatus)), `<span class="src">${judgmentDocs.has(j.id) ? 'نسخة الحكم مرفقة' : 'إدخال يدوي'}</span>`]),
      'لم تُسجل أحكام',
    );
  if (deadlines.length)
    body += '<h2>المواعيد الإجرائية المسجلة</h2>' + table(['الإجراء', 'الموعد', 'الحالة', 'مصدر الموعد'], deadlines.map((x) => [e(x.title), ltr(fmtDate(x.dueDate)), e(labelOf(DEADLINE_STATUSES, x.status)), e(x.source)]));
  body +=
    '<h2>المذكرات</h2>' +
    table(
      ['العنوان', 'النوع', 'الحالة', 'تاريخ آخر تقديم'],
      memos.map((m) => [e(m.title), e(labelOf(MEMO_TYPES, m.memoType)), e(labelOf(MEMO_STATUSES, m.status)), m.lastSubmittedOn ? ltr(fmtDate(m.lastSubmittedOn)) : 'لم يُسجل تقديم']),
      'لم تُسجل مذكرات',
    );
  if (o.includeTasks) {
    const tasks = listTasks(ctx, { caseId: c.id, status: 'open' });
    body += '<h2>المهام المفتوحة</h2>' + table(['المهمة', 'المسؤول', 'الاستحقاق', 'الحالة'], tasks.map((t) => [e(t.title), e(t.assigneeName ?? '—'), t.dueDate ? ltr(fmtDate(t.dueDate)) : '—', e(labelOf(TASK_STATUSES, t.status))]), 'لا توجد مهام مفتوحة');
  }
  if (o.includeDocuments) {
    const docs = listDocuments(ctx, { q: null, clientId: null, caseId: c.id, stageId: null, hearingId: null, judgmentId: null, memoId: null, contractId: null, poaId: null, category: null, archived: 'active', clientLevelOnly: false }).filter(
      (x) => o.includeInternalNotes || !x.isInternal,
    );
    body += '<h2>المستندات المرفقة</h2>' + table(['العنوان', 'التصنيف', 'التاريخ', 'الملف'], docs.map((x) => [e(x.title), e(labelOf(DOC_CATEGORIES, x.category)), x.docDate ? ltr(fmtDate(x.docDate)) : '—', ltr(x.current?.originalName ?? '')]));
  }
  if (o.includeAnalysis) {
    const a = getAnalysis(ctx, { caseId: c.id });
    const filled = a.sections.filter((s) => s.text.trim());
    body += '<h2>التحليل (يدوي — كتبه المستخدم)</h2>';
    body += filled.length
      ? filled.map((s) => `<h3 style="font-size:11pt;margin:8px 0 2px">${e(s.label)}</h3><div class="text-block">${e(s.text)}</div><div class="src">آخر تعديل: ${e(s.updatedByName ?? '—')} ${s.updatedAt ? dt(fmtDateTime(s.updatedAt)) : ''}</div>`).join('')
      : '<p class="empty">لم يُكتب تحليل.</p>';
    if (a.evidence.length)
      body += '<h3 style="font-size:11pt">جدول الأدلة</h3>' + table(['الواقعة / الطلب', 'درجة الثبوت', 'المستند المؤيد', 'ملاحظات'], a.evidence.map((x) => [txt(x.statement), e(labelOf({ confirmed: { label: 'مؤكدة بمستند' }, client_statement: { label: 'إفادة عميل' }, needs_verification: { label: 'تحتاج تحققًا' } }, x.reliability)), e(x.documentTitle ?? '—') + (x.locationRef ? ` (${e(x.locationRef)})` : ''), txt(x.notes)]));
  }
  if (o.includeFees && hasPerm(ctx, 'fees.view')) {
    const ks = listContracts(ctx, { caseId: c.id });
    body +=
      '<h2>العقود والأتعاب المرتبطة</h2>' +
      table(
        ['العقد', 'النوع', 'نطاقه', 'مبلغ القضية / العقد', 'المقدم', 'المسدد', 'المتبقي'],
        ks.map((k) => [
          e(k.title) + (k.sharedAcrossCases ? `<br><span class="src">عقد شامل لـ ${k.cases.length} قضايا — المبالغ تخص العقد كاملًا ولا تُجمع لكل قضية</span>` : ''),
          e(labelOf(CONTRACT_KINDS, k.kind)),
          txt(k.scope),
          ltr(fmtAmount(k.totals?.agreed ?? 0)),
          ltr(fmtAmount(k.totals?.advance ?? 0)),
          ltr(fmtAmount(k.totals?.paid ?? 0)),
          ltr(fmtAmount(k.totals?.remaining ?? 0)),
        ]),
        'لا توجد عقود مرتبطة',
      );
  }
  const notes = listNotes(ctx, { clientId: c.clientId, caseId: c.id }).filter((n) => o.includeInternalNotes || !n.isInternal);
  if (notes.length) body += `<h2>الملاحظات${o.includeInternalNotes ? '' : ' (غير الداخلية فقط)'}</h2>` + table(['التاريخ', 'الملاحظة', 'كتبها'], notes.map((n) => [ltr(fmtDate(n.createdAt.slice(0, 10))), txt(n.body), e(n.byName ?? '—')]));
  return {
    title: `تقرير موقف قضية — ${c.title}`,
    html: shell(ctx, `تقرير موقف قضية`, `${e(c.title)} — ملف ${ltr(c.fileNo)} — العميل: ${e(d.client.name)}`, maxUpdated(ctx, [c.id], c.clientId), body),
  };
}

function clientReport(ctx: Ctx, input: ReportInput) {
  if (!input.clientId) throw new AppError('VALIDATION', 'اختر العميل', { clientId: 'اختر العميل' });
  const d = getClient(ctx, { id: input.clientId });
  const cl = d.client;
  const o = input.options;
  let body = '<h2>بيانات العميل</h2>' + kv([
    ['الاسم', e(cl.name)],
    ['النوع', e(labelOf(CLIENT_KINDS, cl.kind))],
    ['الجوال', ltr(cl.phone)],
    ['البريد', ltr(cl.email)],
    ['المعرف الرسمي', cl.idNumber ? `${e(cl.idType ?? '')} ${ltr(cl.idNumber)}` : '—'],
    ['الممثل وصفته', e([cl.repName, cl.repTitle].filter(Boolean).join(' — ') || '—')],
    ['تواصل الممثل', ltr([cl.repPhone, cl.repEmail].filter(Boolean).join(' / ') || null)],
    ['ملخص العلاقة التعاقدية', txt(cl.relationshipSummary)],
  ]);
  body +=
    '<h2>القضايا</h2>' +
    table(
      ['الملف', 'القضية', 'الخصم', 'المرحلة', 'الحالة', 'آخر إجراء مسجل', 'التالي'],
      d.cases.map((c) => [
        ltr(c.fileNo),
        e(c.title) + (c.caseType ? `<br><span class="src">${e(c.caseType)}</span>` : ''),
        e(c.opponents.join('، ') || '—'),
        e(c.stage?.stageType ?? '—') + (c.stage?.officialCaseNo ? '<br>' + ltr(c.stage.officialCaseNo) : ''),
        e(labelOf(CASE_STATUSES, c.status)) + (c.archived ? ' (مؤرشفة)' : ''),
        c.lastAction ? `${e(c.lastAction.label)}<br>${dt(c.lastAction.isDateOnly ? fmtDate(c.lastAction.at) : fmtDateTime(c.lastAction.at))}` : 'لم يُسجل',
        c.nextEvent ? `${e(c.nextEvent.label)}<br>${dt(c.nextEvent.isDateOnly ? fmtDate(c.nextEvent.at) : fmtDateTime(c.nextEvent.at))}${c.nextEvent.confirmed ? '' : ' (غير مؤكد)'}` : '—',
      ]),
    );
  body +=
    '<h2>العقود والملاحق</h2>' +
    table(
      ['العقد', 'النوع', 'المدة', 'النطاق', 'القضايا المشمولة', 'الحالة'],
      d.contracts.map((k) => [e(k.title), e(labelOf(CONTRACT_KINDS, k.kind)), ltr([k.startDate && fmtDate(k.startDate), k.endDate && fmtDate(k.endDate)].filter(Boolean).join(' — ') || null), txt(k.scope), e(k.cases.map((c) => c.fileNo).join('، ') || 'غير مرتبط بقضايا محددة'), e(labelOf(CONTRACT_STATUSES, k.status))]),
    );
  body +=
    '<h2>الوكالات</h2>' +
    table(
      ['الرقم', 'جهة الإصدار', 'الإصدار', 'الانتهاء', 'النطاق المسجل', 'القضايا المشمولة', 'الحالة'],
      d.poas.map((p) => [ltr(p.poaNo), e(p.issuer ?? '—'), p.issuedOn ? ltr(fmtDate(p.issuedOn)) : '—', p.expiresOn ? ltr(fmtDate(p.expiresOn)) : '—', txt(p.scope), e(p.cases.map((c) => c.fileNo).join('، ') || 'لم تُربط بقضايا'), e(labelOf(POA_STATUSES, p.status))]),
    );
  body += '<h2>المواعيد القادمة</h2>' + table(['الموعد', 'النوع', 'البيان', 'الملف'], d.upcoming.map((u) => [dt(u.startsAt ? fmtDateTime(u.startsAt) : fmtDate(u.date)), e(u.kind === 'hearing' ? 'جلسة' : u.kind === 'task' ? 'مهمة' : 'موعد إجرائي') + (u.confirmed ? '' : ' (غير مؤكد)'), e(u.title), ltr(u.fileNo)]), 'لا توجد مواعيد قادمة مسجلة');
  if (o.includeFees && d.finance) {
    body += '<h2>ملخص الأتعاب</h2>' + kv([
      ['إجمالي الأتعاب الثابتة المتفق عليها', ltr(fmtAmount(d.finance.agreed))],
      ['المدفوع', ltr(fmtAmount(d.finance.paid))],
      ['المتبقي', ltr(fmtAmount(d.finance.remaining))],
      ['المصاريف المستردة غير المسددة', ltr(fmtAmount(d.finance.expenses.outstandingRecoverable))],
    ]);
    if (d.finance.percentage.length) body += `<div class="note">توجد أتعاب نسبية مسجلة (${d.finance.percentage.map((p) => `${e(p.title)}: ${p.percentage ?? '—'}% — ${e(p.basis ?? '')}`).join('؛ ')}). لا تُحتسب كمستحق ثابت.</div>`;
  }
  const notes = d.notes.filter((n) => o.includeInternalNotes || !n.isInternal);
  if (notes.length) body += `<h2>الملاحظات${o.includeInternalNotes ? '' : ' (غير الداخلية فقط)'}</h2>` + table(['التاريخ', 'الملاحظة', 'الملف'], notes.map((n) => [ltr(fmtDate(n.createdAt.slice(0, 10))), txt(n.body), ltr(n.caseFileNo)]));
  if (o.includeInternalNotes && d.communications.length)
    body += '<h2>سجل التواصل</h2>' + table(['التاريخ', 'الوسيلة', 'الملخص'], d.communications.map((m) => [ltr(fmtDate(m.occurredOn)), e(m.channel), txt(m.summary)]));
  return { title: `ملخص شامل — ${cl.name}`, html: shell(ctx, 'ملخص شامل للعميل', e(cl.name), maxUpdated(ctx, d.cases.map((c) => c.id), cl.id), body) };
}

function hearingsReport(ctx: Ctx, input: ReportInput) {
  const from = input.from ?? todayRiyadh(ctx.now());
  const to = input.to ?? addDays(from, 30);
  const evs = calendarEvents(ctx, { from, to, clientId: input.clientId, caseId: input.caseId }).filter((x) => x.kind === 'hearing' && x.status !== 'cancelled');
  const body = table(
    ['الموعد', 'العميل', 'القضية', 'المرحلة', 'المكان', 'الحالة'],
    evs.map((x) => [dt(fmtDateTime(x.startsAt)) + (x.confirmed ? '' : '<br><span class="src">غير مؤكد</span>'), e(x.clientName), e(x.caseTitle) + '<br>' + ltr(x.fileNo), e(x.stageType), e(x.location ?? '—'), e(labelOf(HEARING_STATUSES, x.status))]),
    'لا توجد جلسات مسجلة في هذه الفترة',
  );
  return { title: 'الجلسات القادمة', html: shell(ctx, 'الجلسات القادمة', `من ${dt(fmtDate(from))} إلى ${dt(fmtDate(to))}`, null, body, evs.some((x) => !x.confirmed) ? ['المواعيد غير المؤكدة معلّمة بوضوح ولا تُعامل كمواعيد معتمدة.'] : []) };
}

function tasksReport(ctx: Ctx, input: ReportInput) {
  const tasks = listTasks(ctx, { status: 'open', assigneeUserId: input.assigneeUserId, caseId: input.caseId, clientId: input.clientId });
  const body = table(
    ['المهمة', 'الملف', 'المسؤول', 'الاستحقاق', 'الأولوية', 'الحالة'],
    tasks.map((t) => [e(t.title), t.caseFileNo ? ltr(t.caseFileNo) : e(t.clientName ?? 'عامة'), e(t.assigneeName ?? '—'), t.dueDate ? ltr(fmtDate(t.dueDate)) + (t.overdue ? '<br><span class="src">متأخرة</span>' : '') : '—', e(labelOf(PRIORITIES, t.priority)), e(labelOf(TASK_STATUSES, t.status))]),
    'لا توجد مهام مفتوحة',
  );
  return { title: 'تقرير المهام', html: shell(ctx, 'تقرير المهام المفتوحة', 'المهام غير المكتملة', null, body) };
}

function feesReport(ctx: Ctx, input: ReportInput) {
  requirePerm(ctx, 'fees.view', 'لا تملك صلاحية الاطلاع على الأتعاب');
  if (!input.clientId) throw new AppError('VALIDATION', 'اختر العميل', { clientId: 'اختر العميل' });
  const client = requireClient(ctx, input.clientId);
  const ks = listContracts(ctx, { clientId: input.clientId });
  const sum = clientFinanceSummary(ctx, input.clientId);
  const payments = listPayments(ctx, { clientId: input.clientId });
  const expenses = listExpenses(ctx, { clientId: input.clientId });
  let body = '<h2>العقود</h2>' + table(
    ['العقد', 'نوع الأتعاب', 'القضايا المشمولة', 'المتفق عليه', 'المدفوع', 'المتبقي'],
    ks.map((k) => [
      e(k.title) + (k.sharedAcrossCases ? `<br><span class="src">عقد شامل — يُحسب مرة واحدة</span>` : ''),
      e(labelOf(FEE_TYPES, k.feeType)) + (k.percentage !== null ? `<br><span class="src">${k.percentage}% — ${e(k.percentageBasis ?? '')} (غير محتسبة كمستحق ثابت)</span>` : ''),
      e(k.cases.map((c) => c.fileNo).join('، ') || '—'),
      ltr(fmtAmount(k.totals?.agreed ?? 0)),
      ltr(fmtAmount(k.totals?.paid ?? 0)),
      ltr(fmtAmount(k.totals?.remaining ?? 0)),
    ]),
  );
  body += kv([
    ['الإجمالي المتفق عليه (أتعاب ثابتة)', ltr(fmtAmount(sum.agreed))],
    ['المقدم (ضمن المسدد)', ltr(fmtAmount(sum.advance))],
    ['إجمالي المسدد', ltr(fmtAmount(sum.paid))],
    ['المتبقي', ltr(fmtAmount(sum.remaining))],
  ]);
  body += '<h2>الدفعات</h2>' + table(['التاريخ', 'العقد / البند', 'المبلغ', 'النوع', 'الطريقة', 'رقم السند', 'الحالة'], payments.map((p) => [ltr(fmtDate(p.paidOn)), e(p.contractTitle) + (p.feeItemTitle ? ' / ' + e(p.feeItemTitle) : ''), ltr(fmtAmount(p.amount)), p.isAdvance ? 'مقدم' : 'دفعة', e(p.method ?? '—'), ltr(p.referenceNo), p.voided ? `ملغاة: ${e(p.voidReason ?? '')}` : 'سارية']));
  body += '<h2>المصاريف</h2>' + table(['التاريخ', 'البيان', 'المبلغ', 'تُسترد', 'سُددت'], expenses.map((x) => [ltr(fmtDate(x.spentOn)), e(x.title), ltr(fmtAmount(x.amount)), x.recoverable ? 'نعم' : 'لا', x.reimbursedOn ? ltr(fmtDate(x.reimbursedOn)) : '—']));
  return {
    title: `كشف أتعاب — ${client.name}`,
    html: shell(ctx, 'كشف أتعاب', e(client.name), maxUpdated(ctx, [], input.clientId), body, ['هذا كشف حساب داخلي لأغراض المتابعة وليس فاتورة ضريبية.']),
  };
}

export function renderReport(ctx: Ctx, input: ReportInput): { title: string; html: string } {
  requireUser(ctx);
  requirePerm(ctx, 'reports.export', 'لا تملك صلاحية استخراج التقارير');
  if (input.caseId) requireCase(ctx, input.caseId);
  switch (input.type) {
    case 'case':
      return caseReport(ctx, input);
    case 'client':
      return clientReport(ctx, input);
    case 'hearings':
      return hearingsReport(ctx, input);
    case 'tasks':
      return tasksReport(ctx, input);
    case 'fees':
      return feesReport(ctx, input);
  }
}

export async function printReport(ctx: Ctx, input: ReportInput) {
  const r = renderReport(ctx, input);
  if (!ctx.platform.printHtml) throw new AppError('INTERNAL', 'الطباعة غير متاحة');
  await ctx.platform.printHtml(r.html);
  logActivity(ctx, { action: 'export', entityType: 'report', caseId: input.caseId, clientId: input.clientId, summary: `طباعة تقرير: ${r.title}` });
  return { ok: true };
}

export async function saveReportPdf(ctx: Ctx, input: ReportInput) {
  const r = renderReport(ctx, input);
  if (!ctx.platform.htmlToPdf) throw new AppError('INTERNAL', 'الحفظ PDF غير متاح');
  const dest = await ctx.platform.showSaveFile({ title: 'حفظ التقرير PDF', defaultName: `${r.title.replace(/[\\/:*?"<>|]/g, ' ')}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!dest) return { saved: false };
  const pdf = await ctx.platform.htmlToPdf(r.html);
  const final = dest.toLowerCase().endsWith('.pdf') ? dest : dest + '.pdf';
  fs.writeFileSync(final, pdf);
  logActivity(ctx, { action: 'export', entityType: 'report', caseId: input.caseId, clientId: input.clientId, summary: `حفظ تقرير PDF: ${r.title}` });
  return { saved: true, path: final };
}
