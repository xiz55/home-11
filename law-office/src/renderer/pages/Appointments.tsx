// قسم «الاستشارات والاجتماعات»: مستقل عن القضايا، بقائمة وتقويم وملف مستقل لكل استشارة واجتماع.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banknote, CalendarClock, CheckCircle2, FilePlus2, FileText, Link2, ListChecks, Pencil, Plus, Printer, MessagesSquare, Users, PenLine, Send, Undo2, Eye, FileDown } from 'lucide-react';
import { Alert, Badge, Button, Card, DataTable, Empty, ErrorBox, KV, Loading, Modal, StatusBadge, Tabs, Checkbox, toast, Ltr } from '../components/ui';
import { api, invalidate } from '../lib/api';
import { useApi, useDebounced } from '../lib/hooks';
import { useSession } from '../lib/session';
import { When } from '../lib/display';
import { CalendarView } from './Calendar';
import { DocumentBrowser } from '../components/viewer';
import { DocumentAttachForm, type DocDefaults } from '../forms/docs';
import { ReasonForm } from '../forms/litigation';
import { optsFrom } from '../forms/common';
import { ConsultationForm, DeliveryForm, ItemToTaskForm, LinkCaseForm, MeetingForm, MeetingItemForm, OpinionForm, ServiceTxnForm } from '../forms/appointments';
import { APPT_METHODS, CONSULT_STATUSES, MEETING_ITEM_KINDS, MEETING_STATUSES, OPINION_STATUSES, PAY_STATUSES, SVC_TXN_KINDS, TASK_STATUSES
, CLIENT_KINDS } from '../../shared/constants';
import { fmtAmount } from '../../shared/money';
import { fmtDate, todayRiyadh } from '../../shared/dates';
import type { MethodOutput } from '../../main/ipc/registry';

type Tab = 'consultations' | 'meetings';
type CRow = MethodOutput<'consultations.list'>[number];
type MRow = MethodOutput<'meetings.list'>[number];
type Fin = NonNullable<CRow['finance']>;

function Money({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="nr">غير مسجل</span>;
  return <Ltr>{fmtAmount(v)}</Ltr>;
}

function PayBadge({ f, hidden }: { f: Fin | null; hidden?: boolean }) {
  if (hidden) return <span className="muted">—</span>;
  if (!f) return <Badge tone="neutral">غير مدفوع (افتراضي)</Badge>;
  return <StatusBadge map={PAY_STATUSES} value={f.status} />;
}

export function AppointmentsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'consultations';
  const view = sp.get('view') === 'calendar' ? 'calendar' : 'list';
  const set = (p: Record<string, string>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(p)) v ? n.set(k, v) : n.delete(k);
    setSp(n, { replace: true });
  };
  const { can, users } = useSession();
  const canFees = can('fees.view');
  const canManage = can('consultations.manage');
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [card, setCard] = useState<'' | 'today' | 'upcoming' | 'done' | 'unpaid'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [resp, setResp] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [pay, setPay] = useState('');
  const [add, setAdd] = useState<null | Tab>(null);
  const today = todayRiyadh();
  const ov = useApi(() => api('appointments.overview', {}), []);
  const filters = {
    q: dq || null,
    from: card === 'today' ? today : card === 'upcoming' ? today : from || null,
    to: card === 'today' ? today : to || null,
    responsibleUserId: resp || null,
    method: (method || null) as never,
    status: card === 'done' ? 'done' : status || null,
    payStatus: (card === 'unpaid' ? null : pay || null) as never,
  };
  const cq = useApi(() => (tab === 'consultations' ? api('consultations.list', filters) : Promise.resolve([] as CRow[])), [tab, JSON.stringify(filters)]);
  const mq = useApi(() => (tab === 'meetings' ? api('meetings.list', filters) : Promise.resolve([] as MRow[])), [tab, JSON.stringify(filters)]);
  let crows = cq.data ?? [];
  if (card === 'unpaid') crows = crows.filter((r) => r.finance && ['unpaid', 'partial'].includes(r.finance.status));
  if (card === 'upcoming') crows = crows.filter((r) => ['pending', 'confirmed'].includes(r.status));
  let mrows = mq.data ?? [];
  if (card === 'upcoming') mrows = mrows.filter((r) => ['pending', 'confirmed'].includes(r.status));
  const o = ov.data;
  const cardBtn = (key: typeof card, label: string, value: number | null | undefined, extra?: string) => (
    <button
      className={`stat-card ${card === key ? 'on' : ''}`}
      onClick={() => {
        setCard(card === key ? '' : key);
        if (key === 'done' || key === 'unpaid') set({ tab: 'consultations', view: '' });
      }}
      aria-pressed={card === key}
    >
      <div className="v">{value === null || value === undefined ? '—' : <Ltr>{value}</Ltr>}</div>
      <div className="l">{label}</div>
      {extra && <div className="help">{extra}</div>}
    </button>
  );
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>الاستشارات والاجتماعات</h1>
          <div className="sub">قسم مستقل عن القضايا: استشارة دون توكيل أو قضية، واجتماعات بمحاضرها ومهامها. التوقيت بتوقيت الرياض.</div>
        </div>
        {canManage && (
          <div className="btn-group">
            <Button variant="primary" icon={<MessagesSquare />} onClick={() => setAdd('consultations')}>
              إضافة استشارة
            </Button>
            <Button icon={<Users />} onClick={() => setAdd('meetings')}>
              إضافة اجتماع
            </Button>
          </div>
        )}
      </div>
      <div className="stat-cards" aria-label="ملخص المواعيد">
        {cardBtn('today', 'مواعيد اليوم', o?.counts.today)}
        {cardBtn('upcoming', 'المواعيد القادمة', o?.counts.upcoming)}
        {cardBtn('done', 'الاستشارات المنجزة', o?.counts.consultationsDone)}
        {canFees && cardBtn('unpaid', 'استشارات غير مسددة', o?.counts.consultationsUnpaid, o?.counts.unpaidAmount ? `المتبقي ${fmtAmount(o.counts.unpaidAmount)}` : undefined)}
      </div>
      {o && o.todayItems.length > 0 && (
        <Card title="مواعيد اليوم" className="mb">
          <ul className="list-plain">
            {o.todayItems.map((t) => (
              <li key={t.kind + t.id} className="row wrap" style={{ gap: 8 }}>
                <Badge tone="neutral">{t.kind === 'consultation' ? <MessagesSquare size={13} /> : <Users size={13} />} {t.kind === 'consultation' ? 'استشارة' : 'اجتماع'}</Badge>
                <Ltr>{t.time}</Ltr>
                <Link to={`/appointments/${t.kind === 'consultation' ? 'consultations' : 'meetings'}/${t.id}`}>{t.title}</Link>
                {t.name && <span className="help">— {t.name}</span>}
                {t.kind === 'consultation' ? <StatusBadge map={CONSULT_STATUSES} value={t.status} /> : <StatusBadge map={MEETING_STATUSES} value={t.status} />}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="row between wrap" style={{ margin: '16px 0 8px' }}>
        <Tabs
          tabs={[
            { key: 'consultations', label: 'الاستشارات القانونية' },
            { key: 'meetings', label: 'الاجتماعات' },
          ]}
          value={tab}
          onChange={(k) => {
            set({ tab: k });
            setStatus('');
          }}
        />
        <div className="seg" role="tablist" aria-label="طريقة العرض">
          <button className={view === 'list' ? 'on' : ''} onClick={() => set({ view: '' })} role="tab" aria-selected={view === 'list'}>
            قائمة
          </button>
          <button className={view === 'calendar' ? 'on' : ''} onClick={() => set({ view: 'calendar' })} role="tab" aria-selected={view === 'calendar'}>
            تقويم
          </button>
        </div>
      </div>
      {view === 'calendar' ? (
        <CalendarView embedded only={tab === 'consultations' ? ['consultation'] : ['meeting']} />
      ) : (
        <section className="card">
          <div className="toolbar">
            <input className="input search-input" placeholder="ابحث بالاسم أو الجوال أو عنوان الموضوع أو الرقم المرجعي…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
            <label className="help">
              من <input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); setCard(''); }} aria-label="من تاريخ" />
            </label>
            <label className="help">
              إلى <input type="date" className="input" value={to} onChange={(e) => { setTo(e.target.value); setCard(''); }} aria-label="إلى تاريخ" />
            </label>
            <select className="select" value={resp} onChange={(e) => setResp(e.target.value)} aria-label="المسؤول">
              <option value="">كل المسؤولين</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
            <select className="select" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="الطريقة">
              <option value="">كل الطرق</option>
              {optsFrom(APPT_METHODS).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
            <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setCard(''); }} aria-label="الحالة">
              <option value="">كل الحالات</option>
              {optsFrom(tab === 'consultations' ? CONSULT_STATUSES : MEETING_STATUSES).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
            {canFees && (
              <select className="select" value={pay} onChange={(e) => setPay(e.target.value)} aria-label="حالة السداد">
                <option value="">كل حالات السداد</option>
                {optsFrom(PAY_STATUSES).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            )}
          </div>
          {tab === 'consultations' ? (
            cq.error ? (
              <div className="card-pad"><ErrorBox error={cq.error} onRetry={cq.reload} /></div>
            ) : cq.loading && !cq.data ? (
              <Loading />
            ) : (
              <DataTable
                rows={crows}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(`/appointments/consultations/${r.id}`)}
                empty={canManage ? 'لا توجد استشارات مطابقة. أضف استشارة من الزر أعلاه.' : 'لا توجد استشارات مطابقة'}
                defaultSort={{ key: 'when', dir: -1 }}
                columns={[
                  { key: 'name', header: 'الاسم', sortValue: (r) => r.clientName, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.clientName}</div>{r.clientPhone && <div className="sub"><Ltr>{r.clientPhone}</Ltr></div>}</div> },
                  { key: 'type', header: 'نوع الموعد', render: () => <Badge tone="neutral"><MessagesSquare size={13} /> استشارة</Badge> },
                  { key: 'title', header: 'الموضوع', sortValue: (r) => r.title, render: (r) => <div>{r.title}<div className="sub"><Ltr>{r.refNo}</Ltr>{r.category ? ` — ${r.category}` : ''}</div></div> },
                  { key: 'when', header: 'التاريخ والوقت', sortValue: (r) => r.startsAt, render: (r) => <When at={r.startsAt} /> },
                  { key: 'method', header: 'الطريقة', render: (r) => APPT_METHODS[r.method].label },
                  { key: 'resp', header: 'المسؤول', sortValue: (r) => r.responsibleName ?? '', render: (r) => r.responsibleName ?? <span className="muted">—</span> },
                  { key: 'status', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <StatusBadge map={CONSULT_STATUSES} value={r.status} /> },
                  ...(canFees
                    ? [
                        { key: 'amount', header: 'المبلغ', sortValue: (r: CRow) => r.finance?.due ?? -1, render: (r: CRow) => (r.finance?.mode === 'free' ? <Badge tone="neutral">مجانية</Badge> : <Money v={r.finance?.due} />) },
                        { key: 'paid', header: 'المدفوع', sortValue: (r: CRow) => r.finance?.netPaid ?? 0, render: (r: CRow) => <Money v={r.finance?.netPaid ?? null} /> },
                        { key: 'rem', header: 'المتبقي', sortValue: (r: CRow) => r.finance?.remaining ?? -1, render: (r: CRow) => <div><Money v={r.finance?.remaining === null ? null : Math.max(r.finance?.remaining ?? 0, 0)} /><div><PayBadge f={r.finance} /></div></div> },
                      ]
                    : []),
                ]}
              />
            )
          ) : mq.error ? (
            <div className="card-pad"><ErrorBox error={mq.error} onRetry={mq.reload} /></div>
          ) : mq.loading && !mq.data ? (
            <Loading />
          ) : (
            <DataTable
              rows={mrows}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/appointments/meetings/${r.id}`)}
              empty="لا توجد اجتماعات مطابقة"
              defaultSort={{ key: 'when', dir: -1 }}
              columns={[
                { key: 'name', header: 'الاسم / الجهة', sortValue: (r) => r.clientName ?? '', render: (r) => r.clientName ?? <span className="muted">بدون طرف مرتبط</span> },
                { key: 'type', header: 'نوع الموعد', render: () => <Badge tone="neutral"><Users size={13} /> اجتماع</Badge> },
                { key: 'title', header: 'الموضوع', sortValue: (r) => r.title, render: (r) => <div>{r.title}<div className="sub"><Ltr>{r.refNo}</Ltr></div></div> },
                { key: 'when', header: 'التاريخ والوقت', sortValue: (r) => r.startsAt, render: (r) => <div><When at={r.startsAt} /><div className="sub">حتى <Ltr>{r.endTime}</Ltr></div></div> },
                { key: 'method', header: 'الطريقة', render: (r) => APPT_METHODS[r.method].label },
                { key: 'resp', header: 'المسؤول', render: (r) => r.responsibleName ?? <span className="muted">—</span> },
                { key: 'status', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <StatusBadge map={MEETING_STATUSES} value={r.status} /> },
                ...(canFees
                  ? [
                      { key: 'amount', header: 'المبلغ', render: (r: MRow) => (r.isPaid ? <Money v={r.feeAmount} /> : <span className="muted">غير مدفوع</span>) },
                      { key: 'paid', header: 'المدفوع', render: (r: MRow) => (r.finance ? <Money v={r.finance.netPaid} /> : <span className="muted">—</span>) },
                      { key: 'rem', header: 'المتبقي', render: (r: MRow) => (r.finance ? <div><Money v={Math.max(r.finance.remaining ?? 0, 0)} /><div><PayBadge f={r.finance} /></div></div> : <span className="muted">—</span>) },
                    ]
                  : []),
              ]}
            />
          )}
        </section>
      )}
      {add === 'consultations' && <ConsultationForm onClose={() => setAdd(null)} onSaved={(id) => navigate(`/appointments/consultations/${id}`)} />}
      {add === 'meetings' && <MeetingForm onClose={() => setAdd(null)} onSaved={(id) => navigate(`/appointments/meetings/${id}`)} />}
    </div>
  );
}

// ———————————————— ملف الاستشارة ————————————————

type CTab = 'summary' | 'details' | 'notes' | 'docs' | 'opinion' | 'fees' | 'log';

function SummaryPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const [internal, setInternal] = useState(false);
  const [fees, setFees] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useApi(() => api('reports.consultationSummary', { id, includeInternalNotes: internal, includeFees: fees, action: 'preview' }), [id, internal, fees]);
  const run = async (action: 'print' | 'pdf') => {
    setBusy(action);
    try {
      const r = await api('reports.consultationSummary', { id, includeInternalNotes: internal, includeFees: fees, action });
      if (action === 'pdf' && r.saved) toast.success('حُفظ الملخص PDF');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal
      title="طباعة ملخص الاستشارة"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={<Printer />} loading={busy === 'print'} onClick={() => void run('print')}>طباعة</Button>
          <Button icon={<FileDown />} loading={busy === 'pdf'} onClick={() => void run('pdf')}>حفظ PDF</Button>
          <Button onClick={onClose}>إغلاق</Button>
        </>
      }
    >
      <div className="row wrap" style={{ gap: 16, marginBottom: 8 }}>
        <Checkbox label="تضمين الملاحظات الداخلية" checked={internal} onChange={setInternal} hint="غير مدرجة افتراضيًا — لا تُسلّم للمستفيد" />
        {can('fees.view') && <Checkbox label="تضمين الأتعاب" checked={fees} onChange={setFees} />}
      </div>
      {q.error ? <ErrorBox error={q.error} /> : q.data?.html ? <iframe className="iframe-report" title="معاينة الملخص" sandbox="" srcDoc={q.data.html} /> : <Loading />}
    </Modal>
  );
}

export function ConsultationPage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as CTab) ?? 'summary';
  const setTab = (t: CTab) => setSp({ tab: t }, { replace: true });
  const q = useApi(() => api('consultations.get', { id: id! }), [id]);
  const docsQ = useApi(() => api('documents.list', { consultationId: id! }), [id]);
  const { can } = useSession();
  const navigate = useNavigate();
  const [modal, setModal] = useState<null | 'edit' | 'doc' | 'opinion' | 'pay' | 'print' | 'link' | 'meeting'>(null);
  const [attach, setAttach] = useState<DocDefaults | null>(null);
  const [opinionEdit, setOpinionEdit] = useState<MethodOutput<'consultations.get'>['opinions'][number] | null>(null);
  const [deliver, setDeliver] = useState<MethodOutput<'consultations.get'>['opinions'][number] | null>(null);
  const [voidTx, setVoidTx] = useState<string | null>(null);
  const [selDoc, setSelDoc] = useState<string | null>(null);
  const [rev, setRev] = useState<{ id: string; label: string } | null>(null);
  const revQ = useApi(() => (rev ? api('opinions.revision', { id: rev.id }) : Promise.resolve(null)), [rev?.id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const g = q.data!;
  const c = g.consultation;
  const docs = docsQ.data ?? [];
  const clientDocs = docs.filter((d) => d.category !== 'legal_opinion' && d.category !== 'delivery_proof' && d.category !== 'receipt');
  const manage = can('consultations.manage');
  const f = c.finance;
  const label = `الاستشارة ${c.refNo}`;
  return (
    <div>
      <nav className="breadcrumb" aria-label="مسار التنقل">
        <Link to="/appointments">الاستشارات والاجتماعات</Link> / <span>{c.title}</span>
      </nav>
      <section className="card file-head">
        <div className="row between top wrap">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row wrap">
              <h1>{c.title}</h1>
              <Badge tone="outline"><Ltr>{c.refNo}</Ltr></Badge>
              <StatusBadge map={CONSULT_STATUSES} value={c.status} />
              {!c.amountsHidden && <PayBadge f={f} />}
            </div>
            <div className="row wrap help" style={{ gap: 16 }}>
              <span>
                صاحب الاستشارة: {c.clientAccessible ? <Link to={`/clients/${c.clientId}`}>{c.clientName}</Link> : c.clientName} ({CLIENT_KINDS[c.clientKind].label})
              </span>
              {c.clientPhone && <span>الجوال: <Ltr>{c.clientPhone}</Ltr></span>}
              <span><When at={c.startsAt} /> — حتى <Ltr>{c.endTime}</Ltr> ({c.durationMin} دقيقة)</span>
              <span>{APPT_METHODS[c.method].label}</span>
              {c.responsibleName && <span>المسؤول: {c.responsibleName}</span>}
              {c.caseId ? <span>القضية: <Link to={`/cases/${c.caseId}`}><Ltr>{c.caseFileNo}</Ltr> — {c.caseTitle}</Link></span> : <span>غير مرتبطة بقضية</span>}
            </div>
          </div>
          <div className="btn-group">
            {manage && <Button icon={<CalendarClock />} onClick={() => setModal('edit')}>تعديل الموعد</Button>}
            {manage && <Button icon={<FilePlus2 />} onClick={() => setAttach({ consultationId: c.id, category: 'consultation_doc', lockedLabel: label })}>إرفاق مستند</Button>}
            {manage && <Button icon={<PenLine />} onClick={() => setModal('opinion')}>إضافة الاستشارة المكتوبة</Button>}
            {can('fees.manage') && <Button icon={<Banknote />} onClick={() => setModal('pay')}>تسجيل دفعة</Button>}
            {can('reports.export') && <Button icon={<Printer />} onClick={() => setModal('print')}>طباعة ملخص</Button>}
            {manage && <Button icon={<Link2 />} onClick={() => setModal('link')}>{c.caseId ? 'تغيير القضية المرتبطة' : 'ربط بقضية'}</Button>}
            {manage && <Button icon={<Users />} onClick={() => setModal('meeting')}>اجتماع مرتبط</Button>}
          </div>
        </div>
      </section>
      <Tabs
        tabs={[
          { key: 'summary', label: 'الملخص' },
          { key: 'details', label: 'التفاصيل والأسئلة' },
          { key: 'notes', label: 'الملاحظات الداخلية' },
          { key: 'docs', label: 'مستندات المستفيد', count: clientDocs.length },
          { key: 'opinion', label: 'الاستشارة المكتوبة', count: g.opinions.length },
          { key: 'fees', label: 'الأتعاب والدفعات', hidden: c.amountsHidden },
          { key: 'log', label: 'سجل التغييرات' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'summary' && (
          <div className="split">
            <Card title="الشخص والموعد">
              <KV
                items={[
                  ['الاسم', c.clientName],
                  ['الجوال', c.clientPhone ? <Ltr>{c.clientPhone}</Ltr> : '—'],
                  ['البريد', c.clientEmail ? <Ltr>{c.clientEmail}</Ltr> : '—'],
                  ['التاريخ والوقت', <When key="w" at={c.startsAt} />],
                  ['المدة', `${c.durationMin} دقيقة — حتى ${c.endTime}`],
                  ['المكان / الرابط', c.location ?? (c.meetingLink ? <Ltr>{c.meetingLink}</Ltr> : '—')],
                  ['الحالة', <span key="s"><StatusBadge map={CONSULT_STATUSES} value={c.status} /> {c.statusReason && <span className="help">— {c.statusReason}</span>}</span>],
                  ['التصنيف', c.category ?? '—'],
                ]}
              />
            </Card>
            <Card title="الموضوع">
              <div className="text-pre">{c.description ?? <span className="muted">لم يُسجل وصف</span>}</div>
              <div style={{ marginTop: 12 }} className="help">
                الاستشارة المكتوبة: {g.opinions.length ? <StatusBadge map={OPINION_STATUSES} value={c.opinionStatus} /> : c.writtenRequired ? 'مطلوبة ولم تُضف بعد' : 'غير مطلوبة'}
                {c.deliveredOn && <> — سُلّمت في <Ltr>{fmtDate(c.deliveredOn)}</Ltr></>}
              </div>
              {f && (
                <table className="fin-mini" style={{ marginTop: 12 }}>
                  <tbody>
                    <tr><th>المبلغ</th><td className="num">{f.mode === 'free' ? 'مجانية' : <Money v={f.due} />}</td></tr>
                    <tr><th>المدفوع (صافي)</th><td className="num"><Money v={f.netPaid} /></td></tr>
                    <tr><th>المتبقي</th><td className="num">{f.remaining === null ? <span className="nr">غير مسجل</span> : <Money v={Math.max(f.remaining, 0)} />}</td></tr>
                  </tbody>
                </table>
              )}
              {(g.meetings.length > 0 || g.tasks.length > 0) && (
                <div style={{ marginTop: 12 }}>
                  {g.meetings.map((m) => <div key={m.id}><Link to={`/appointments/meetings/${m.id}`}>اجتماع <Ltr>{m.refNo}</Ltr>: {m.title}</Link></div>)}
                  {g.tasks.map((t) => <div key={t.id} className="help">مهمة: {t.title} — {TASK_STATUSES[t.status as keyof typeof TASK_STATUSES]?.label}</div>)}
                </div>
              )}
            </Card>
          </div>
        )}
        {tab === 'details' && (
          <div className="split">
            <Card title="وصف الموضوع"><div className="text-pre">{c.description ?? <span className="muted">—</span>}</div></Card>
            <Card title="الأسئلة المطلوب بحثها"><div className="text-pre">{c.questions ?? <span className="muted">—</span>}</div></Card>
          </div>
        )}
        {tab === 'notes' && (
          <Card title="ملاحظات داخلية" actions={manage && <Button size="sm" icon={<Pencil />} onClick={() => setModal('edit')}>تعديل</Button>}>
            <Alert tone="neutral">لا تُدرج في ملخص المستفيد أو التقارير المسلّمة إلا باختيار صريح.</Alert>
            <div className="text-pre" style={{ marginTop: 8 }}>{c.internalNotes ?? <span className="muted">لا توجد ملاحظات</span>}</div>
          </Card>
        )}
        {tab === 'docs' && (
          <Card title="المستندات المقدمة من طالب الاستشارة" actions={manage && <Button size="sm" icon={<FilePlus2 />} onClick={() => setAttach({ consultationId: c.id, category: 'consultation_doc', lockedLabel: label })}>إرفاق مستند</Button>}>
            <DocumentBrowser docs={clientDocs} selected={selDoc} onSelect={setSelDoc} emptyHint="لم تُرفق مستندات بعد. تُنسخ الملفات إلى مستودع البرنامج المحلي." />
          </Card>
        )}
        {tab === 'opinion' && (
          <div className="stack g2">
            <Alert tone="info">حفظ الاستشارة أو اعتمادها داخليًا لا يعني تسليمها؛ سجّل التسليم بزر «تسجيل التسليم» مع التاريخ والطريقة.</Alert>
            {manage && (
              <div>
                <Button variant="primary" icon={<PenLine />} onClick={() => setModal('opinion')}>إضافة الاستشارة المكتوبة</Button>
              </div>
            )}
            {g.opinions.length === 0 && <Empty title="لا توجد استشارة مكتوبة بعد" />}
            {g.opinions.map((o) => {
              const doc = docs.find((d) => d.id === o.documentId);
              const proof = docs.find((d) => d.id === o.deliveryProofDocumentId);
              return (
                <Card
                  key={o.id}
                  title={o.title}
                  sub={<span><StatusBadge map={OPINION_STATUSES} value={o.status} /> — النسخة <Ltr>{o.revision}</Ltr>{o.opinionDate && <> — <Ltr>{fmtDate(o.opinionDate)}</Ltr></>}{o.authorName && ` — ${o.authorName}`}</span>}
                  actions={
                    manage && (
                      <div className="btn-group">
                        {o.status !== 'delivered' && <Button size="sm" icon={<Pencil />} onClick={() => setOpinionEdit(o)}>نسخة معدلة</Button>}
                        {o.status !== 'delivered' && <Button size="sm" icon={<Send />} onClick={() => setDeliver(o)}>تسجيل التسليم</Button>}
                      </div>
                    )
                  }
                >
                  {o.deliveredOn && (
                    <Alert tone="success">
                      سُلّمت للمستفيد في <Ltr>{fmtDate(o.deliveredOn)}</Ltr> — {o.deliveryMethod}
                      {o.deliveryNotes && ` — ${o.deliveryNotes}`}
                      {proof && <> — <Button size="sm" icon={<FileText />} onClick={() => { setSelDoc(proof.id); setTab('docs'); }}>إثبات التسليم</Button></>}
                    </Alert>
                  )}
                  {doc && (
                    <div style={{ margin: '8px 0' }}>
                      <DocumentBrowser docs={[doc]} selected={selDoc === doc.id ? doc.id : null} onSelect={setSelDoc} />
                    </div>
                  )}
                  {o.body ? <div className="text-pre">{o.body}</div> : <div className="muted">النص في الملف المرفق.</div>}
                  <details style={{ marginTop: 10 }}>
                    <summary>النسخ السابقة ({o.revisions.length})</summary>
                    <ul className="list-plain">
                      {o.revisions.map((r) => (
                        <li key={r.id} className="row wrap" style={{ gap: 8 }}>
                          <Ltr>v{r.revision}</Ltr> <StatusBadge map={OPINION_STATUSES} value={r.status} /> <When at={r.savedAt} /> {r.byName && `— ${r.byName}`} {r.note && <span className="help">— {r.note}</span>}
                          <Button size="sm" icon={<Eye />} onClick={() => setRev({ id: r.id, label: `النسخة ${r.revision}` })}>عرض</Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </Card>
              );
            })}
          </div>
        )}
        {tab === 'fees' && f && (
          <div className="split">
            <Card title="السجل المالي للاستشارة">
              <table className="fin-mini">
                <tbody>
                  <tr><th>المبلغ المستحق</th><td className="num">{f.mode === 'free' ? 'مجانية (صفر)' : <Money v={f.due} />}</td></tr>
                  <tr><th>الدفعات</th><td className="num"><Money v={f.paid} /></td></tr>
                  <tr><th>المبالغ المستردة</th><td className="num"><Money v={f.refunded} /></td></tr>
                  <tr><th>التسويات والخصومات</th><td className="num"><Money v={f.discounts} /></td></tr>
                  <tr><th>صافي المستلم</th><td className="num"><Money v={f.netPaid} /></td></tr>
                  <tr><th>الرصيد المتبقي</th><td className="num">{f.remaining === null ? <span className="nr">غير مسجل</span> : <Money v={Math.max(f.remaining, 0)} />}</td></tr>
                  {f.remaining !== null && f.remaining < 0 && <tr><th>مبلغ زائد يحتاج تسوية</th><td className="num"><Money v={-f.remaining} /></td></tr>}
                  <tr><th>حالة السداد</th><td><PayBadge f={f} /></td></tr>
                  {f.credited > 0 && <tr><th>محتسب من أتعاب قضية</th><td className="num"><Money v={f.credited} /></td></tr>}
                </tbody>
              </table>
              {c.status === 'cancelled' && f.netPaid > 0 && <Alert tone="warning">الموعد ملغى وعليه مبالغ مستلمة. إلغاء الموعد لا يلغي المبلغ تلقائيًا؛ سجّل الاسترداد أو التسوية مع السبب.</Alert>}
              {g.credits.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <strong>تسويات مرتبطة بأتعاب القضية</strong>
                  <ul className="list-plain">
                    {g.credits.map((x) => <li key={x.id}><Money v={x.amount} /> على «{x.contractTitle}» بتاريخ <Ltr>{fmtDate(x.adjustedOn)}</Ltr> — {x.reason} {x.voided && <Badge tone="neutral">ملغاة</Badge>}</li>)}
                  </ul>
                </div>
              )}
            </Card>
            <Card
              title="الحركات"
              actions={
                can('fees.manage') && (
                  <div className="btn-group">
                    <Button size="sm" icon={<Banknote />} onClick={() => setModal('pay')}>تسجيل دفعة / استرداد / تسوية</Button>
                  </div>
                )
              }
            >
              <DataTable
                rows={g.transactions}
                rowKey={(r) => r.id}
                empty="لا توجد حركات"
                columns={[
                  { key: 'd', header: 'التاريخ', render: (r) => <Ltr>{fmtDate(r.txnOn)}</Ltr> },
                  { key: 'k', header: 'النوع', render: (r) => <StatusBadge map={SVC_TXN_KINDS} value={r.kind} /> },
                  { key: 'a', header: 'المبلغ', render: (r) => <Money v={r.amount} /> },
                  { key: 'm', header: 'الطريقة / المرجع', render: (r) => <div>{r.method ?? '—'}{r.referenceNo && <div className="sub"><Ltr>{r.referenceNo}</Ltr></div>}{r.reason && <div className="sub">{r.reason}</div>}</div> },
                  { key: 's', header: 'الحالة', render: (r) => (r.voided ? <Badge tone="neutral">ملغاة: {r.voidReason}</Badge> : <Badge tone="success">سارية</Badge>) },
                  {
                    key: 'x',
                    header: '',
                    render: (r) => (
                      <div className="btn-group">
                        {r.receiptDocumentId ? (
                          <Button size="sm" icon={<FileText />} onClick={() => { setSelDoc(r.receiptDocumentId); setTab('docs'); }}>السند</Button>
                        ) : (
                          can('fees.manage') && !r.voided && <Button size="sm" icon={<FilePlus2 />} onClick={() => setAttach({ consultationId: c.id, serviceTxnId: r.id, category: 'receipt', title: `سند ${SVC_TXN_KINDS[r.kind].label} ${fmtDate(r.txnOn)}`, lockedLabel: label })}>إرفاق سند</Button>
                        )}
                        {can('fees.manage') && !r.voided && <Button size="sm" icon={<Undo2 />} onClick={() => setVoidTx(r.id)}>إلغاء</Button>}
                      </div>
                    ),
                  },
                ]}
              />
              {docs.filter((d) => d.category === 'receipt').length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <DocumentBrowser docs={docs.filter((d) => d.category === 'receipt')} selected={selDoc} onSelect={setSelDoc} />
                </div>
              )}
            </Card>
          </div>
        )}
        {tab === 'log' && (
          <div className="split">
            <Card title="تغييرات الموعد">
              {g.changes.length === 0 ? (
                <Empty title="لا تغييرات مسجلة" />
              ) : (
                <ul className="list-plain">
                  {g.changes.map((x) => (
                    <li key={x.id}>
                      <strong>{x.field}</strong>: {x.oldValue ?? '—'} ← {x.newValue ?? '—'}
                      <div className="help"><When at={x.changedAt} /> {x.byName && `— ${x.byName}`} {x.reason && `— السبب: ${x.reason}`}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="الإجراءات">
              <ul className="list-plain">
                {g.activity.map((a) => (
                  <li key={a.id}>
                    {a.summary}
                    <div className="help"><When at={a.at} /> — {a.username ?? 'النظام'}</div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </div>
      {modal === 'edit' && <ConsultationForm initial={c} onClose={() => setModal(null)} />}
      {modal === 'opinion' && <OpinionForm consultationId={c.id} refNo={c.refNo} docs={docs} onClose={() => setModal(null)} />}
      {opinionEdit && <OpinionForm consultationId={c.id} refNo={c.refNo} initial={opinionEdit} docs={docs} onClose={() => setOpinionEdit(null)} />}
      {deliver && <DeliveryForm opinion={deliver} consultationId={c.id} refNo={c.refNo} docs={docs} onClose={() => setDeliver(null)} />}
      {modal === 'pay' && <ServiceTxnForm consultationId={c.id} onClose={() => setModal(null)} />}
      {modal === 'print' && <SummaryPreview id={c.id} onClose={() => setModal(null)} />}
      {modal === 'link' && <LinkCaseForm consultation={c} onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingForm defaults={{ clientId: c.clientAccessible ? c.clientId : undefined, consultationId: c.id, caseId: c.caseId ?? undefined }} onClose={() => setModal(null)} onSaved={(mid) => navigate(`/appointments/meetings/${mid}`)} />}
      {attach && <DocumentAttachForm defaults={attach} onClose={() => setAttach(null)} />}
      {voidTx && <ReasonForm title="إلغاء حركة مالية" label="سبب الإلغاء" required submitLabel="إلغاء الحركة" onSubmit={async (reason) => { await api('serviceTxns.void', { id: voidTx, reason }); invalidate(); }} onClose={() => setVoidTx(null)} />}
      {rev && (
        <Modal title={`${rev.label} من الاستشارة المكتوبة`} size="wide" onClose={() => setRev(null)}>
          {revQ.data ? (
            <div>
              <div className="help"><StatusBadge map={OPINION_STATUSES} value={revQ.data.status} /> — <When at={revQ.data.savedAt} /> {revQ.data.note && `— ${revQ.data.note}`}</div>
              <h3>{revQ.data.title}</h3>
              <div className="text-pre">{revQ.data.body ?? <span className="muted">بدون نص (ملف مرفق)</span>}</div>
            </div>
          ) : (
            <Loading />
          )}
        </Modal>
      )}
    </div>
  );
}

// ———————————————— ملف الاجتماع ————————————————

type MTab = 'summary' | 'minutes' | 'docs' | 'tasks' | 'fees' | 'log';

export function MeetingPage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as MTab) ?? 'summary';
  const setTab = (t: MTab) => setSp({ tab: t }, { replace: true });
  const q = useApi(() => api('meetings.get', { id: id! }), [id]);
  const docsQ = useApi(() => api('documents.list', { meetingId: id! }), [id]);
  const { can } = useSession();
  const [modal, setModal] = useState<null | 'edit' | 'item' | 'pay'>(null);
  const [attach, setAttach] = useState<DocDefaults | null>(null);
  const [toTask, setToTask] = useState<{ id: string; text: string } | null>(null);
  const [editItem, setEditItem] = useState<{ id: string; kind: 'decision' | 'recommendation'; text: string } | null>(null);
  const [selDoc, setSelDoc] = useState<string | null>(null);
  const [voidTx, setVoidTx] = useState<string | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const g = q.data!;
  const m = g.meeting;
  const manage = can('consultations.manage');
  const docs = docsQ.data ?? [];
  const label = `الاجتماع ${m.refNo}`;
  return (
    <div>
      <nav className="breadcrumb" aria-label="مسار التنقل">
        <Link to="/appointments?tab=meetings">الاستشارات والاجتماعات</Link> / <span>{m.title}</span>
      </nav>
      <section className="card file-head">
        <div className="row between top wrap">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row wrap">
              <h1>{m.title}</h1>
              <Badge tone="outline"><Ltr>{m.refNo}</Ltr></Badge>
              <StatusBadge map={MEETING_STATUSES} value={m.status} />
              {m.isPaid && !m.amountsHidden && <PayBadge f={m.finance} />}
            </div>
            <div className="row wrap help" style={{ gap: 16 }}>
              <span><When at={m.startsAt} /> — حتى <Ltr>{m.endTime}</Ltr></span>
              <span>{APPT_METHODS[m.method].label}</span>
              {m.responsibleName && <span>المسؤول: {m.responsibleName}</span>}
              {m.clientName && <span>الطرف: {m.clientAccessible ? <Link to={`/clients/${m.clientId}`}>{m.clientName}</Link> : m.clientName}</span>}
              {m.caseId && <span>القضية: <Link to={`/cases/${m.caseId}`}><Ltr>{m.caseFileNo}</Ltr> — {m.caseTitle}</Link></span>}
              {m.consultationId && <span>الاستشارة: <Link to={`/appointments/consultations/${m.consultationId}`}><Ltr>{m.consultationRef}</Ltr></Link></span>}
            </div>
          </div>
          <div className="btn-group">
            {manage && <Button icon={<CalendarClock />} onClick={() => setModal('edit')}>تعديل الاجتماع والمحضر</Button>}
            {manage && <Button icon={<Plus />} onClick={() => setModal('item')}>إضافة قرار أو توصية</Button>}
            {manage && <Button icon={<FilePlus2 />} onClick={() => setAttach({ meetingId: m.id, category: 'meeting_doc', lockedLabel: label })}>إرفاق مستند</Button>}
            {m.isPaid && can('fees.manage') && <Button icon={<Banknote />} onClick={() => setModal('pay')}>تسجيل دفعة</Button>}
          </div>
        </div>
      </section>
      <Tabs
        tabs={[
          { key: 'summary', label: 'الملخص' },
          { key: 'minutes', label: 'المحضر والقرارات', count: g.items.length },
          { key: 'docs', label: 'المرفقات', count: docs.length },
          { key: 'tasks', label: 'المهام الناتجة', count: g.tasks.length },
          { key: 'fees', label: 'المقابل المالي', hidden: !m.isPaid || m.amountsHidden },
          { key: 'log', label: 'السجل' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'summary' && (
          <div className="split">
            <Card title="بيانات الاجتماع">
              <KV
                items={[
                  ['الغرض', m.purpose ?? '—'],
                  ['التاريخ', <When key="w" at={m.startsAt} />],
                  ['النهاية', <Ltr key="e">{m.endTime}</Ltr>],
                  ['الطريقة', APPT_METHODS[m.method].label],
                  ['المكان / الرابط', m.location ?? (m.meetingLink ? <Ltr>{m.meetingLink}</Ltr> : '—')],
                  ['الحالة', <span key="s"><StatusBadge map={MEETING_STATUSES} value={m.status} /> {m.statusReason && <span className="help">— {m.statusReason}</span>}</span>],
                  ['المقابل المالي', m.isPaid ? (m.amountsHidden ? 'مسجل' : <Money v={m.feeAmount} />) : 'غير مدفوع'],
                ]}
              />
            </Card>
            <Card title="المشاركون وجدول الأعمال">
              {m.participants.length ? (
                <ul className="list-plain">
                  {m.participants.map((p, i) => <li key={i}>{p.name}{p.role && <span className="help"> — {p.role}</span>}</li>)}
                </ul>
              ) : (
                <div className="muted">لم يُسجل مشاركون</div>
              )}
              <h3 style={{ marginTop: 12 }}>جدول الأعمال</h3>
              <div className="text-pre">{m.agenda ?? <span className="muted">—</span>}</div>
            </Card>
          </div>
        )}
        {tab === 'minutes' && (
          <div className="split">
            <Card title="محضر الاجتماع" actions={manage && <Button size="sm" icon={<Pencil />} onClick={() => setModal('edit')}>تعديل المحضر</Button>}>
              <div className="text-pre">{m.minutes ?? <span className="muted">لم يُسجل محضر بعد</span>}</div>
            </Card>
            <Card title="القرارات والتوصيات" actions={manage && <Button size="sm" icon={<Plus />} onClick={() => setModal('item')}>إضافة بند</Button>}>
              {g.items.length === 0 ? (
                <Empty title="لا توجد بنود" />
              ) : (
                <ul className="list-plain">
                  {g.items.map((i) => (
                    <li key={i.id}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <StatusBadge map={MEETING_ITEM_KINDS} value={i.kind} />
                        <span>{i.text}</span>
                      </div>
                      <div className="row wrap help" style={{ gap: 8, marginTop: 4 }}>
                        {i.taskId ? (
                          <span>
                            <CheckCircle2 size={14} /> مهمة: {i.taskTitle} — {TASK_STATUSES[i.taskStatus as keyof typeof TASK_STATUSES]?.label}
                            {i.taskDueDate && <> — <Ltr>{fmtDate(i.taskDueDate)}</Ltr></>}
                            {i.taskAssignee && ` — ${i.taskAssignee}`}
                          </span>
                        ) : (
                          manage && (
                            <>
                              <Button size="sm" icon={<ListChecks />} onClick={() => setToTask({ id: i.id, text: i.text })}>تحويل إلى مهمة</Button>
                              <Button size="sm" icon={<Pencil />} onClick={() => setEditItem(i)}>تعديل</Button>
                              <Button size="sm" onClick={async () => { try { await api('meetingItems.remove', { id: i.id }); invalidate(); } catch (e) { toast.error(e); } }}>حذف</Button>
                            </>
                          )
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
        {tab === 'docs' && (
          <Card title="مرفقات الاجتماع" actions={manage && <Button size="sm" icon={<FilePlus2 />} onClick={() => setAttach({ meetingId: m.id, category: 'meeting_doc', lockedLabel: label })}>إرفاق مستند</Button>}>
            <DocumentBrowser docs={docs} selected={selDoc} onSelect={setSelDoc} emptyHint="لا توجد مرفقات" />
          </Card>
        )}
        {tab === 'tasks' && (
          <Card title="المهام الناتجة عن الاجتماع">
            <DataTable
              rows={g.tasks}
              rowKey={(r) => r.id}
              empty="لم تُحوّل بنود إلى مهام بعد"
              columns={[
                { key: 't', header: 'المهمة', render: (r) => r.title },
                { key: 'a', header: 'المسؤول', render: (r) => r.assignee ?? '—' },
                { key: 'd', header: 'الموعد', render: (r) => (r.dueDate ? <Ltr>{fmtDate(r.dueDate)}</Ltr> : '—') },
                { key: 's', header: 'الحالة', render: (r) => <StatusBadge map={TASK_STATUSES} value={r.status} /> },
              ]}
            />
            <div className="help" style={{ marginTop: 8 }}>تُدار المهام وتُغلق من صفحة «المهام».</div>
          </Card>
        )}
        {tab === 'fees' && m.finance && (
          <Card title="المقابل المالي للاجتماع (بند مستقل)" actions={can('fees.manage') && <Button size="sm" icon={<Banknote />} onClick={() => setModal('pay')}>تسجيل حركة</Button>}>
            <table className="fin-mini">
              <tbody>
                <tr><th>المستحق</th><td className="num"><Money v={m.finance.due} /></td></tr>
                <tr><th>صافي المستلم</th><td className="num"><Money v={m.finance.netPaid} /></td></tr>
                <tr><th>المتبقي</th><td className="num"><Money v={Math.max(m.finance.remaining ?? 0, 0)} /></td></tr>
                <tr><th>الحالة</th><td><PayBadge f={m.finance} /></td></tr>
              </tbody>
            </table>
            <DataTable
              rows={g.transactions}
              rowKey={(r) => r.id}
              empty="لا توجد حركات"
              columns={[
                { key: 'd', header: 'التاريخ', render: (r) => <Ltr>{fmtDate(r.txnOn)}</Ltr> },
                { key: 'k', header: 'النوع', render: (r) => <StatusBadge map={SVC_TXN_KINDS} value={r.kind} /> },
                { key: 'a', header: 'المبلغ', render: (r) => <Money v={r.amount} /> },
                { key: 's', header: 'الحالة', render: (r) => (r.voided ? <Badge tone="neutral">ملغاة</Badge> : <Badge tone="success">سارية</Badge>) },
                { key: 'x', header: '', render: (r) => can('fees.manage') && !r.voided && <Button size="sm" icon={<Undo2 />} onClick={() => setVoidTx(r.id)}>إلغاء</Button> },
              ]}
            />
          </Card>
        )}
        {tab === 'log' && (
          <div className="split">
            <Card title="تغييرات الموعد">
              {g.changes.length === 0 ? (
                <Empty title="لا تغييرات مسجلة" />
              ) : (
                <ul className="list-plain">
                  {g.changes.map((x) => (
                    <li key={x.id}>
                      <strong>{x.field}</strong>: {x.oldValue ?? '—'} ← {x.newValue ?? '—'}
                      <div className="help"><When at={x.changedAt} /> {x.byName && `— ${x.byName}`} {x.reason && `— السبب: ${x.reason}`}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="الإجراءات">
              <ul className="list-plain">
                {g.activity.map((a) => (
                  <li key={a.id}>
                    {a.summary}
                    <div className="help"><When at={a.at} /> — {a.username ?? 'النظام'}</div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        )}
      </div>
      {modal === 'edit' && <MeetingForm initial={m} onClose={() => setModal(null)} />}
      {modal === 'item' && <MeetingItemForm meetingId={m.id} onClose={() => setModal(null)} />}
      {editItem && <MeetingItemForm meetingId={m.id} initial={editItem} onClose={() => setEditItem(null)} />}
      {toTask && <ItemToTaskForm item={toTask} onClose={() => setToTask(null)} />}
      {modal === 'pay' && <ServiceTxnForm meetingId={m.id} onClose={() => setModal(null)} />}
      {attach && <DocumentAttachForm defaults={attach} onClose={() => setAttach(null)} />}
      {voidTx && <ReasonForm title="إلغاء حركة مالية" label="سبب الإلغاء" required submitLabel="إلغاء الحركة" onSubmit={async (reason) => { await api('serviceTxns.void', { id: voidTx, reason }); invalidate(); }} onClose={() => setVoidTx(null)} />}
    </div>
  );
}
