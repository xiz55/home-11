// «التقرير الشامل للمكتب» — تقرير إداري داخلي لصاحب المكتب، منفصل عن تقارير العملاء.
import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileDown, FileSpreadsheet, Play, Printer, ShieldAlert } from 'lucide-react';
import { Alert, Badge, Button, Card, Checkbox, Collapsible, DateInput, ErrorBox, Loading, Select, TextInput, toast, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { fmtAmount } from '../../shared/money';
import { fmtDate, fmtDateTime, todayRiyadh } from '../../shared/dates';
import type { MethodOutput } from '../../main/ipc/registry';

type Report = MethodOutput<'reports.office'>;
type Section = Report['sections'][number];
type SectionKey = Section['key'];
const SECTION_LABELS: Record<SectionKey, string> = {
  clients: 'كشف العملاء وبياناتهم',
  cases: 'كشف القضايا',
  consultations: 'كشف الاستشارات',
  meetings: 'كشف الاجتماعات',
  finance: 'التقرير المالي لكل عميل',
  financeDetails: 'تفاصيل الحركات المالية',
  alerts: 'التنبيهات الإدارية',
};
const ALL_SECTIONS = Object.keys(SECTION_LABELS) as SectionKey[];

function cellText(kind: string, v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return <span className="nr">غير مسجل</span>;
  if (kind === 'money') return <Ltr>{fmtAmount(Number(v))}</Ltr>;
  if (kind === 'number') return <Ltr>{v}</Ltr>;
  if (kind === 'date') return <Ltr>{fmtDate(String(v))}</Ltr>;
  if (kind === 'datetime') return <bdi dir="rtl">{fmtDateTime(String(v))}</bdi>;
  return <span className="text-pre">{String(v)}</span>;
}

export function OfficeReportPanel() {
  const { can, isOwner, users } = useSession();
  const navigate = useNavigate();
  const canFees = can('fees.view');
  const [mode, setMode] = useState<'asOf' | 'period'>('asOf');
  const [asOf, setAsOf] = useState(todayRiyadh());
  const [from, setFrom] = useState(`${todayRiyadh().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayRiyadh());
  const [clientId, setClientId] = useState('');
  const [caseType, setCaseType] = useState('');
  const [caseStatus, setCaseStatus] = useState('');
  const [resp, setResp] = useState('');
  const [service, setService] = useState('');
  const [pay, setPay] = useState('');
  const [sections, setSections] = useState<SectionKey[]>(ALL_SECTIONS);
  const [columns, setColumns] = useState<Partial<Record<SectionKey, string[]>>>({});
  const [sensitive, setSensitive] = useState(false);
  const [details, setDetails] = useState(false);
  const [staleDays, setStaleDays] = useState('30');
  const [expDays, setExpDays] = useState('30');
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const clients = useApi(() => api('clients.options', {}), []);
  const { lookup } = useSession();
  const input = () => ({
    mode,
    asOf: mode === 'asOf' ? asOf : null,
    from: mode === 'period' ? from : null,
    to: mode === 'period' ? to : null,
    clientId: clientId || null,
    caseType: caseType || null,
    caseStatus: (caseStatus || null) as never,
    responsibleUserId: resp || null,
    serviceType: (service || null) as never,
    payStatus: (pay || null) as never,
    sections,
    columns,
    includeSensitive: sensitive,
    includeDetails: details,
    staleDays: Math.max(1, Number(staleDays) || 30),
    expiringDays: Math.max(0, Number(expDays) || 30),
  });
  const run = async (kind: 'show' | 'print' | 'pdf' | 'xlsx') => {
    setBusy(kind);
    try {
      if (kind === 'show') {
        setReport(await api('reports.office', input()));
        setShowSettings(false);
      }
      else {
        const r = await api('reports.officeExport', { ...input(), format: kind });
        if (r.saved && r.path) toast.success(kind === 'pdf' ? 'حُفظ التقرير PDF' : 'صُدّرت الجداول إلى Excel');
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const open = (link: Section['rows'][number]['link']) => {
    if (!link) return;
    const map: Record<string, string> = { client: `/clients/${link.id}`, case: `/cases/${link.id}`, consultation: `/appointments/consultations/${link.id}`, meeting: `/appointments/meetings/${link.id}`, task: '/tasks', contract: `/clients/${link.clientId}?tab=contracts` };
    navigate(map[link.type]);
  };
  const toggleCol = (sec: SectionKey, key: string, all: string[]) => {
    const cur = columns[sec] ?? all;
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    setColumns({ ...columns, [sec]: next.length ? next : all });
  };
  if (!can('reports.office')) return <Alert tone="warning">التقرير الشامل للمكتب متاح لصاحب المكتب أو لمن مُنح صلاحية «عرض التقرير الشامل».</Alert>;
  return (
    <div className="stack g2">
      {!showSettings && (
        <div className="btn-group">
          <Button onClick={() => setShowSettings(true)}>تعديل النطاق والمرشحات والأقسام</Button>
          <Button variant="primary" icon={<Play />} loading={busy === 'show'} onClick={() => void run('show')}>تحديث التقرير</Button>
          {can('reports.officeExport') && (
            <>
              <Button icon={<Printer />} loading={busy === 'print'} onClick={() => void run('print')}>طباعة</Button>
              <Button icon={<FileDown />} loading={busy === 'pdf'} onClick={() => void run('pdf')}>حفظ PDF</Button>
              <Button icon={<FileSpreadsheet />} loading={busy === 'xlsx'} onClick={() => void run('xlsx')}>تصدير Excel</Button>
            </>
          )}
        </div>
      )}
      {showSettings && (
      <Card title="إعداد التقرير الشامل">
        <div className="form-grid">
          <div className="seg full" role="tablist" aria-label="نطاق التقرير" style={{ justifySelf: 'start' }}>
            <button className={mode === 'asOf' ? 'on' : ''} onClick={() => setMode('asOf')}>جميع البيانات حتى تاريخ</button>
            <button className={mode === 'period' ? 'on' : ''} onClick={() => setMode('period')}>فترة محددة</button>
          </div>
          {mode === 'asOf' ? (
            <DateInput label="حتى تاريخ" value={asOf} onChange={setAsOf} />
          ) : (
            <>
              <DateInput label="من" value={from} onChange={setFrom} />
              <DateInput label="إلى" value={to} onChange={setTo} />
            </>
          )}
          <fieldset className="full">
            <legend>مرشحات اختيارية</legend>
            <div className="form-grid">
            <Select label="العميل" value={clientId} onChange={setClientId} options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="كل العملاء" />
            <Select label="نوع القضية" value={caseType} onChange={setCaseType} options={lookup('case_types').map((x) => ({ value: x, label: x }))} placeholder="كل الأنواع" />
            <Select label="حالة القضية" value={caseStatus} onChange={setCaseStatus} options={[{ value: 'active', label: 'نشطة' }, { value: 'closed', label: 'مقفلة' }, { value: 'archived', label: 'مؤرشفة' }]} placeholder="كل الحالات" />
            <Select label="المسؤول" value={resp} onChange={setResp} options={users.map((u) => ({ value: u.id, label: u.displayName }))} placeholder="الجميع" />
            <Select label="نوع الخدمة" value={service} onChange={setService} options={[{ value: 'cases', label: 'قضايا' }, { value: 'consultations', label: 'استشارات' }, { value: 'meetings', label: 'اجتماعات' }]} placeholder="كل الخدمات" />
            {canFees && <Select label="حالة السداد" value={pay} onChange={setPay} options={[{ value: 'unpaid', label: 'غير مسدد' }, { value: 'partial', label: 'مسدد جزئيًا' }, { value: 'paid', label: 'مسدد' }, { value: 'overpaid', label: 'مبلغ زائد / رصيد دائن' }]} placeholder="الكل" />}
            </div>
          </fieldset>
          <fieldset className="full">
            <legend>الأقسام</legend>
            {ALL_SECTIONS.filter((k) => canFees || (k !== 'finance' && k !== 'financeDetails')).map((k) => (
              <Checkbox key={k} label={SECTION_LABELS[k]} checked={sections.includes(k)} onChange={(x) => setSections(x ? [...sections, k] : sections.filter((y) => y !== k))} />
            ))}
            <div className="help">الملخص التنفيذي يظهر دائمًا. اختيار الأعمدة متاح بعد إنشاء التقرير من رأس كل قسم.</div>
          </fieldset>
          <fieldset className="full">
            <legend>التنبيهات الإدارية</legend>
            <div className="row" style={{ gap: 8 }}>
              <TextInput label="قضية دون تحديث منذ (يوم)" ltr value={staleDays} onChange={setStaleDays} />
              <TextInput label="انتهاء العقود والوكالات خلال (يوم)" ltr value={expDays} onChange={setExpDays} />
            </div>
          </fieldset>
          {isOwner && (
            <fieldset className="full">
              <legend>بيانات حساسة (لصاحب المكتب فقط)</legend>
              <Checkbox label="تضمين أرقام الهوية والسجلات" checked={sensitive} onChange={setSensitive} />
              <Checkbox label="تضمين نصوص الاستشارات والملاحظات الداخلية والمحاضر" checked={details} onChange={setDetails} hint="غير مدرجة افتراضيًا" />
            </fieldset>
          )}
          <div className="btn-group full">
            <Button variant="primary" icon={<Play />} loading={busy === 'show'} onClick={() => void run('show')}>إنشاء التقرير</Button>
            {can('reports.officeExport') && (
              <>
                <Button icon={<Printer />} loading={busy === 'print'} onClick={() => void run('print')}>طباعة</Button>
                <Button icon={<FileDown />} loading={busy === 'pdf'} onClick={() => void run('pdf')}>حفظ PDF</Button>
                <Button icon={<FileSpreadsheet />} loading={busy === 'xlsx'} onClick={() => void run('xlsx')}>تصدير Excel</Button>
              </>
            )}
          </div>
          <div className="help full">يُسجل إنشاء التقرير وتصديره في سجل الأنشطة مع المستخدم والوقت والنطاق. ترقيم الصفحات وتاريخ الاستخراج يظهران في ملف PDF.</div>
        </div>
      </Card>
      )}
      <div className="stack g2">
        {busy === 'show' && !report ? (
          <Loading />
        ) : !report ? (
          <Card>
            <div className="muted">اختر النطاق والمرشحات ثم «إنشاء التقرير». تُستخرج الأرقام من السجلات الفعلية فقط، وما لم يُسجل يظهر «غير مسجل» لا صفرًا.</div>
          </Card>
        ) : (
          <ReportView report={report} open={open} columns={columns} toggleCol={toggleCol} />
        )}
      </div>
    </div>
  );
}

function ReportView({ report: r, open, columns, toggleCol }: { report: Report; open: (l: Section['rows'][number]['link']) => void; columns: Partial<Record<SectionKey, string[]>>; toggleCol: (s: SectionKey, k: string, all: string[]) => void }) {
  return (
    <>
      <Card>
        <div className="stack" style={{ gap: 4 }}>
          <div className="help">{r.meta.office}</div>
          <div className="row wrap" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>{r.meta.title}</h2>
            <span className="conf-badge"><ShieldAlert size={14} /> {r.meta.confidential}</span>
          </div>
          <div className="row wrap help" style={{ gap: 14 }}>
            <span>الاستخراج: <bdi dir="rtl">{fmtDateTime(r.meta.generatedAt)}</bdi></span>
            <span>{r.meta.periodLabel}</span>
            <span>أنشأه: {r.meta.generatedBy}</span>
            <span>المرشحات: {r.meta.filters.length ? r.meta.filters.join('، ') : 'بدون'}</span>
          </div>
        </div>
        {r.notices.map((n, i) => (
          <div key={i} style={{ marginTop: 8 }}>
            <Alert tone="warning">{n}</Alert>
          </div>
        ))}
      </Card>
      <Card title="الملخص التنفيذي">
        {r.summary.map((g) => (
          <div key={g.title} style={{ marginBottom: 14 }}>
            <h3>{g.title}</h3>
            <div className="sum-grid">
              {g.items.map((i) => (
                <div key={i.label} className="sum-item">
                  <div className="help">{i.label}</div>
                  <div className="v">{i.value === null ? <span className="nr">غير مسجل</span> : <Ltr>{i.money ? fmtAmount(i.value) : i.value}</Ltr>}</div>
                  <div className="b">{i.basis}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>
      {r.sections.map((s) => {
        const count = s.groups ? s.groups.reduce((n, g) => n + g.rows.length, 0) : s.rows.length;
        const all = s.allColumns.map((c) => c.key);
        const chosen = columns[s.key] ?? all;
        const table = (rows: Section['rows']) => (
          <div className="report-table">
            <table>
              <thead>
                <tr>{s.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <Fragment key={i}>
                    <tr className={row.link ? 'clickable' : ''} onClick={() => open(row.link)} title={row.link ? 'فتح السجل الأصلي' : undefined}>
                      {s.columns.map((c) => (
                        <td key={c.key} className={c.kind === 'money' || c.kind === 'number' ? 'num' : ''}>{cellText(c.kind, row.cells[c.key])}</td>
                      ))}
                    </tr>
                    {row.detail && (
                      <tr>
                        <td colSpan={s.columns.length} className="text-pre help">{row.detail}</td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        );
        return (
          <Collapsible key={s.key} title={<span>{s.title} <Badge tone="outline"><Ltr>{count}</Ltr></Badge></span>}>
            {s.notes.map((n, i) => <div key={i} className="help">{n}</div>)}
            <details style={{ margin: '6px 0' }}>
              <summary className="help">الأعمدة المعروضة (تُطبق على العرض والطباعة والتصدير؛ أعد «إنشاء التقرير» بعد التغيير)</summary>
              <div className="col-picker">
                {s.allColumns.map((c) => <Checkbox key={c.key} label={c.label} checked={chosen.includes(c.key)} onChange={() => toggleCol(s.key, c.key, all)} />)}
              </div>
            </details>
            {s.groups ? (
              s.groups.length === 0 ? (
                <div className="muted">لا توجد حركات ضمن النطاق.</div>
              ) : (
                s.groups.map((g) => (
                  <div key={g.title} style={{ marginBottom: 12 }}>
                    <h3 className="row" style={{ gap: 8 }}>
                      {g.title}
                      {g.link && <Button size="sm" onClick={() => open(g.link)}>فتح ملف العميل</Button>}
                    </h3>
                    {table(g.rows)}
                  </div>
                ))
              )
            ) : count === 0 ? (
              <div className="muted">لا توجد سجلات ضمن النطاق والمرشحات.</div>
            ) : (
              table(s.rows)
            )}
          </Collapsible>
        );
      })}
    </>
  );
}
