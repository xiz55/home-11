import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Paperclip, Archive, ArchiveRestore, Banknote, Briefcase, FilePlus2, FileText, Pencil, Plus, ScrollText, StickyNote, UserPlus, MessageSquare, BarChart3, MessagesSquare } from 'lucide-react';
import { Alert, Badge, Button, Card, DataTable, Empty, ErrorBox, KV, Loading, Select, StatusBadge, Tabs, toast, Ltr } from '../components/ui';
import { api, invalidate } from '../lib/api';
import { useApi, useDebounced } from '../lib/hooks';
import { useSession } from '../lib/session';
import { EVENT_KIND, LastActionCell, NextEventCell, When } from '../lib/display';
import { CONSULT_STATUSES, MEETING_STATUSES, PAY_STATUSES, CLIENT_RELATIONS, CASE_STATUSES, CLIENT_KINDS, CLIENT_STATUSES, COMM_CHANNELS, CONTRACT_KINDS, CONTRACT_STATUSES, FEE_TYPES, FOLLOW_STATUSES, POA_STATUSES } from '../../shared/constants';
import { fmtAmount } from '../../shared/money';
import { fmtDate } from '../../shared/dates';
import { ClientForm, CaseForm } from '../forms/clientCase';
import { ContractForm, ExpenseForm, FeeItemForm, NoteForm, CommForm, PaymentForm, PoaForm } from '../forms/finance';
import { DocumentAttachForm, type DocDefaults } from '../forms/docs';
import { DocumentBrowser } from '../components/viewer';
import { optsFrom } from '../forms/common';
import { AdjustmentForm, ConsultationForm } from '../forms/appointments';
import { ReasonForm } from '../forms/litigation';
import type { MethodOutput } from '../../main/ipc/registry';

export function ClientsPage() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q, 250);
  const { can } = useSession();
  const [add, setAdd] = useState(false);
  const navigate = useNavigate();
  const list = useApi(() => api('clients.list', { q: dq || null, kind: (kind || null) as never, status: (status || null) as never }), [dq, kind, status]);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>العملاء والشركات</h1>
          <div className="sub">ملف موحد لكل عميل: فرد أو شركة أو منشأة</div>
        </div>
        {can('clients.create') && (
          <Button variant="primary" icon={<UserPlus />} onClick={() => setAdd(true)}>
            إضافة عميل
          </Button>
        )}
      </div>
      <section className="card">
        <div className="toolbar">
          <input className="input search-input" placeholder="ابحث بالاسم أو الجوال أو المعرف أو الممثل…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في العملاء" />
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="نوع العميل">
            <option value="">كل الأنواع</option>
            {optsFrom(CLIENT_KINDS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="حالة العميل">
            <option value="">النشطون وغير النشطين</option>
            {optsFrom(CLIENT_STATUSES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="grow" />
          {list.data && <span className="help">{list.data.length} عميل</span>}
        </div>
        {list.error ? (
          <div className="card-pad"><ErrorBox error={list.error} onRetry={list.reload} /></div>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : (
          <DataTable
            rows={list.data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/clients/${r.id}`)}
            empty={dq ? 'لا توجد نتائج مطابقة' : 'لم يُضف أي عميل بعد'}
            defaultSort={{ key: 'name', dir: 1 }}
            columns={[
              { key: 'name', header: 'الاسم', sortValue: (r) => r.name, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.name}</div>{r.shortName && <div className="sub">{r.shortName}</div>}</div> },
              { key: 'kind', header: 'النوع', sortValue: (r) => r.kind, render: (r) => <Badge tone="outline">{CLIENT_KINDS[r.kind].label}</Badge> },
              { key: 'contact', header: 'وسيلة الاتصال', sortValue: (r) => r.phone ?? r.email ?? '', render: (r) => (r.phone ? <Ltr>{r.phone}</Ltr> : r.email ? <Ltr>{r.email}</Ltr> : <span className="muted">—</span>) },
              { key: 'cases', header: 'القضايا', sortValue: (r) => r.caseCount, render: (r) => <span><Ltr>{r.caseCount}</Ltr> {r.openCaseCount > 0 && <span className="sub">({r.openCaseCount} مفتوحة)</span>}</span> },
              { key: 'next', header: 'الجلسة القادمة', sortValue: (r) => r.nextHearingAt ?? '', render: (r) => <When at={r.nextHearingAt} /> },
              { key: 'status', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <StatusBadge map={CLIENT_STATUSES} value={r.status} /> },
            ]}
          />
        )}
      </section>
      {add && <ClientForm onClose={() => setAdd(false)} onSaved={(id) => navigate(`/clients/${id}`)} />}
    </div>
  );
}

type Profile = MethodOutput<'clients.get'>;
type Tab = 'summary' | 'cases' | 'consultations' | 'contracts' | 'poas' | 'fees' | 'docs' | 'notes';

export function ClientProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'summary';
  const q = useApi(() => api('clients.get', { id: id! }), [id]);
  const { can } = useSession();
  const navigate = useNavigate();
  const [modal, setModal] = useState<null | 'consultation' | 'edit' | 'case' | 'contract' | 'poa' | 'payment' | 'doc' | 'note' | 'comm' | 'expense' | 'archive'>(null);
  const [editContract, setEditContract] = useState<Profile['contracts'][number] | null>(null);
  const [editPoa, setEditPoa] = useState<Profile['poas'][number] | null>(null);
  const [feeItemFor, setFeeItemFor] = useState<string | null>(null);
  const [adjustFor, setAdjustFor] = useState<{ id: string; title: string } | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [attach, setAttach] = useState<DocDefaults | null>(null);
  const openDoc = (id: string) => {
    setSelectedDoc(id);
    setSp({ tab: 'docs' }, { replace: true });
  };
  const linkedFiles = (pred: (d: Profile['documents'][number]) => boolean) => {
    const list = p.documents.filter(pred);
    return list.length ? (
      <div className="chip-list" style={{ marginTop: 10 }}>
        {list.map((d) => (
          <Button key={d.id} size="sm" icon={<FileText />} onClick={() => openDoc(d.id)}>
            {d.title} ({(d.current?.ext ?? '').toUpperCase()})
          </Button>
        ))}
      </div>
    ) : (
      <div className="help" style={{ marginTop: 10 }}>لا توجد ملفات مرفقة.</div>
    );
  };
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const p = q.data!;
  const c = p.client;
  const full = p.access === 'full';
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  return (
    <div>
      <nav className="breadcrumb" aria-label="مسار التنقل">
        <Link to="/clients">العملاء</Link> / <span>{c.name}</span>
      </nav>
      <section className="card file-head">
        <div className="row between top wrap">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row wrap">
              <h1>{c.name}</h1>
              <Badge tone="outline">{CLIENT_KINDS[c.kind].label}</Badge>
              <StatusBadge map={CLIENT_STATUSES} value={c.status} />
              <Badge tone="info">{CLIENT_RELATIONS[p.relation].label}</Badge>
              {c.clientNo && <Badge tone="outline">رقم العميل <Ltr>{c.clientNo}</Ltr></Badge>}
              {!full && <Badge tone="neutral">اطلاع محدود على ملفاتك المسندة</Badge>}
            </div>
            <div className="row wrap help" style={{ gap: 16 }}>
              {c.phone && <span>الجوال: <Ltr>{c.phone}</Ltr></span>}
              {c.email && <span>البريد: <Ltr>{c.email}</Ltr></span>}
              {c.repName && <span>الممثل: {c.repName}{c.repTitle ? ` (${c.repTitle})` : ''} {c.repPhone && <Ltr>{c.repPhone}</Ltr>}</span>}
              {c.idNumber && <span>{c.idType ?? 'المعرف'}: <Ltr>{c.idNumber}</Ltr></span>}
            </div>
          </div>
          <div className="btn-group">
            {can('cases.create') && <Button variant="primary" icon={<Plus />} onClick={() => setModal('case')}>إضافة قضية</Button>}
            {can('consultations.manage') && <Button icon={<MessagesSquare />} onClick={() => setModal('consultation')}>إضافة استشارة</Button>}
            {full && <Button icon={<Pencil />} onClick={() => setModal('edit')}>تعديل</Button>}
            {can('reports.export') && <Button icon={<BarChart3 />} onClick={() => navigate(`/reports?type=client&clientId=${c.id}`)}>ملخص شامل</Button>}
          </div>
        </div>
        <div className="meta-grid">
          <div className="meta"><div className="k">القضايا</div><div className="v"><Ltr>{p.cases.length}</Ltr> ({p.cases.filter((x) => x.status === 'open' && !x.archived).length} مفتوحة)</div></div>
          <div className="meta"><div className="k">العقود</div><div className="v"><Ltr>{p.contracts.length}</Ltr></div></div>
          <div className="meta"><div className="k">الوكالات</div><div className="v"><Ltr>{p.poas.length}</Ltr> ({p.poas.filter((x) => x.status === 'active').length} سارية)</div></div>
          <div className="meta"><div className="k">الموعد القادم</div><div className="v">{p.upcoming[0] ? <span>{EVENT_KIND[p.upcoming[0].kind].label} — <When at={p.upcoming[0].startsAt ?? p.upcoming[0].date} dateOnly={!p.upcoming[0].startsAt} /></span> : 'لا يوجد'}</div></div>
        </div>
      </section>
      <div style={{ height: 16 }} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'summary', label: 'الملخص' },
          { key: 'cases', label: 'القضايا', count: p.cases.length },
          { key: 'consultations', label: 'الاستشارات والاجتماعات', count: p.consultations.length + p.meetings.length },
          { key: 'contracts', label: 'العقود', count: p.contracts.length },
          { key: 'poas', label: 'الوكالات', count: p.poas.length },
          { key: 'fees', label: 'الأتعاب', hidden: !p.canFees },
          { key: 'docs', label: 'المستندات', count: p.documents.length },
          { key: 'notes', label: 'الملاحظات والتواصل', count: p.notes.length + p.communications.length },
        ]}
      />
      {tab === 'summary' && (
        <div className="grid c2">
          <div className="stack g2">
            <Card title="القضايا والمواعيد القادمة" flush actions={<Button size="sm" onClick={() => setTab('cases')}>كل القضايا</Button>}>
              {p.cases.length === 0 ? (
                <Empty title="لا توجد قضايا" />
              ) : (
                <ul className="list-plain" style={{ padding: '0 24px' }}>
                  {p.cases.slice(0, 8).map((x) => (
                    <li key={x.id} className="row between top" style={{ cursor: 'pointer' }} onClick={() => navigate(`/cases/${x.id}`)}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{x.title}</div>
                        <div className="help">
                          <Ltr>{x.fileNo}</Ltr> — {x.caseType ?? 'نوع غير محدد'} — {x.stage?.stageType ?? 'لم تُسجل مرحلة'} {x.opponents.length > 0 && `— الخصم: ${x.opponents.join('، ')}`}
                        </div>
                      </div>
                      <div style={{ minWidth: 200 }}><NextEventCell ev={x.nextEvent} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="المواعيد القادمة من كل القضايا" flush>
              {p.upcoming.length === 0 ? (
                <Empty title="لا توجد مواعيد قادمة مسجلة" />
              ) : (
                <ul className="list-plain" style={{ padding: '0 24px' }}>
                  {p.upcoming.slice(0, 10).map((e) => (
                    <li key={e.kind + e.id} className="row between">
                      <span>
                        <Badge tone={EVENT_KIND[e.kind].tone}>{EVENT_KIND[e.kind].label}</Badge> {e.kind === 'hearing' ? e.caseTitle : e.title} {!e.confirmed && <Badge tone="warning">غير مؤكد</Badge>}
                      </span>
                      <When at={e.startsAt ?? e.date} dateOnly={!e.startsAt} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div className="stack g2">
            <Card title="بيانات التواصل والعلاقة">
              <KV
                items={[
                  ['ملخص العلاقة التعاقدية', full ? <div className="long-text">{c.relationshipSummary}</div> : <span className="muted">متاح للوصول الكامل</span>],
                  ['الجوال', c.phone && <Ltr>{c.phone}</Ltr>],
                  ['البريد', c.email && <Ltr>{c.email}</Ltr>],
                  ['العنوان', c.address],
                  ['الممثل', c.repName && `${c.repName}${c.repTitle ? ' — ' + c.repTitle : ''}`],
                  ['تواصل الممثل', (c.repPhone || c.repEmail) && <Ltr>{[c.repPhone, c.repEmail].filter(Boolean).join(' / ')}</Ltr>],
                  ['ملاحظات المكتب', full ? <div className="long-text">{c.notes}</div> : null],
                ]}
              />
            </Card>
            <Card title="العقود والوكالات" actions={<Button size="sm" onClick={() => setTab('contracts')}>التفاصيل</Button>}>
              {p.contracts.length === 0 && p.poas.length === 0 ? (
                <div className="muted">لا توجد عقود أو وكالات مسجلة</div>
              ) : (
                <ul className="list-plain">
                  {p.contracts.map((k) => (
                    <li key={k.id}>
                      {CONTRACT_KINDS[k.kind].label}: {k.title} — يشمل {k.cases.length ? k.cases.map((x) => x.fileNo).join('، ') : 'لم يُربط بقضايا'} <StatusBadge map={CONTRACT_STATUSES} value={k.status} />
                    </li>
                  ))}
                  {p.poas.map((x) => (
                    <li key={x.id}>
                      وكالة {x.poaNo && <Ltr>{x.poaNo}</Ltr>} — تشمل {x.cases.length ? x.cases.map((y) => y.fileNo).join('، ') : 'لم تُربط بقضايا'} <StatusBadge map={POA_STATUSES} value={x.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {p.finance && (
              <Card title="الأتعاب" actions={<Button size="sm" onClick={() => setTab('fees')}>التفاصيل</Button>}>
                <KV items={[['المتفق عليه (ثابت)', <Ltr>{fmtAmount(p.finance.agreed)}</Ltr>], ['المدفوع', <Ltr>{fmtAmount(p.finance.paid)}</Ltr>], ['المتبقي', <Ltr>{fmtAmount(p.finance.remaining)}</Ltr>]]} />
              </Card>
            )}
          </div>
        </div>
      )}
      {tab === 'cases' && (
        <section className="card">
          <div className="toolbar">
            <span className="help grow">اضغط القضية لفتح ملفها (الجلسات، الأحكام، المذكرات، العقود والوكالات).</span>
            <Button size="sm" icon={<Paperclip />} onClick={() => setAttach({ clientId: c.id })}>إرفاق ملف (Word أو PDF)</Button>
          </div>
          <DataTable
            rows={p.cases}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/cases/${r.id}`)}
            empty="لا توجد قضايا"
            columns={[
              { key: 'title', header: 'القضية', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div><div className="sub"><Ltr>{r.fileNo}</Ltr></div></div> },
              { key: 'type', header: 'النوع', sortValue: (r) => r.caseType ?? '', render: (r) => r.caseType ?? '—' },
              { key: 'opp', header: 'الخصم', sortValue: (r) => r.opponents.join(' '), render: (r) => r.opponents.join('، ') || '—' },
              { key: 'stage', header: 'المرحلة', sortValue: (r) => r.stage?.stageType ?? '', render: (r) => (r.stage ? <div>{r.stage.stageType}{r.stage.officialCaseNo && <div className="sub"><Ltr>{r.stage.officialCaseNo}</Ltr></div>}</div> : '—') },
              { key: 'status', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <div className="row wrap" style={{ gap: 4 }}><StatusBadge map={CASE_STATUSES} value={r.status} />{r.archived && <Badge>مؤرشفة</Badge>}<StatusBadge map={FOLLOW_STATUSES} value={r.followStatus} /></div> },
              { key: 'last', header: 'آخر إجراء', sortValue: (r) => r.lastAction?.at ?? '', render: (r) => <LastActionCell a={r.lastAction} /> },
              { key: 'next', header: 'الجلسة أو المهمة القادمة', sortValue: (r) => r.nextEvent?.at ?? '', render: (r) => <NextEventCell ev={r.nextEvent} /> },
            ]}
          />
        </section>
      )}
      {tab === 'consultations' && (
        <div className="stack g2">
          <Card
            title="الاستشارات"
            flush
            actions={can('consultations.manage') && <Button size="sm" icon={<MessagesSquare />} onClick={() => setModal('consultation')}>إضافة استشارة</Button>}
          >
            <DataTable
              rows={p.consultations}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/appointments/consultations/${r.id}`)}
              empty="لا توجد استشارات لهذا العميل"
              columns={[
                { key: 'ref', header: 'المرجع', render: (r) => <Ltr>{r.refNo}</Ltr> },
                { key: 't', header: 'الموضوع', render: (r) => r.title },
                { key: 'w', header: 'الموعد', sortValue: (r) => r.startsAt, render: (r) => <When at={r.startsAt} /> },
                { key: 's', header: 'الحالة', render: (r) => <StatusBadge map={CONSULT_STATUSES} value={r.status} /> },
                { key: 'c', header: 'القضية', render: (r) => (r.caseFileNo ? <Ltr>{r.caseFileNo}</Ltr> : <span className="muted">—</span>) },
                ...(p.canFees ? [{ key: 'f', header: 'السداد', render: (r: Profile['consultations'][number]) => (r.finance ? <StatusBadge map={PAY_STATUSES} value={r.finance.status} /> : '—') }] : []),
              ]}
            />
          </Card>
          <Card title="الاجتماعات" flush>
            <DataTable
              rows={p.meetings}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/appointments/meetings/${r.id}`)}
              empty="لا توجد اجتماعات لهذا العميل"
              columns={[
                { key: 'ref', header: 'المرجع', render: (r) => <Ltr>{r.refNo}</Ltr> },
                { key: 't', header: 'العنوان', render: (r) => r.title },
                { key: 'w', header: 'الموعد', sortValue: (r) => r.startsAt, render: (r) => <When at={r.startsAt} /> },
                { key: 's', header: 'الحالة', render: (r) => <StatusBadge map={MEETING_STATUSES} value={r.status} /> },
              ]}
            />
          </Card>
        </div>
      )}
      {tab === 'contracts' && (
        <div className="stack g2">
          <div className="row">
            {p.canManageFees && full && <Button variant="primary" icon={<ScrollText />} onClick={() => setModal('contract')}>إضافة عقد</Button>}
          </div>
          {p.contracts.length === 0 ? (
            <Card><Empty title="لا توجد عقود مسجلة" /></Card>
          ) : (
            p.contracts.map((k) => (
              <Card
                key={k.id}
                title={<div className="row wrap"><h2>{k.title}</h2><Badge tone="outline">{CONTRACT_KINDS[k.kind].label}</Badge><StatusBadge map={CONTRACT_STATUSES} value={k.status} />{k.sharedAcrossCases && <Badge tone="info">عقد شامل لعدة قضايا</Badge>}</div>}
                actions={
                  p.canManageFees && full ? (
                    <>
                      <Button size="sm" icon={<Paperclip />} onClick={() => setAttach({ clientId: c.id, contractId: k.id, category: 'fee_contract', title: k.title })}>إرفاق ملف العقد</Button>
                      <Button size="sm" onClick={() => setFeeItemFor(k.id)}>إضافة بند</Button>
                      <Button size="sm" onClick={() => setAdjustFor({ id: k.id, title: k.title })}>خصم / استرداد</Button>
                      <Button size="sm" icon={<Pencil />} onClick={() => setEditContract(k)}>تعديل</Button>
                    </>
                  ) : full ? (
                    <Button size="sm" icon={<Paperclip />} onClick={() => setAttach({ clientId: c.id, contractId: k.id, category: 'fee_contract', title: k.title })}>إرفاق ملف العقد</Button>
                  ) : undefined
                }
              >
                <KV
                  items={[
                    ['رقم العقد', k.contractNo && <Ltr>{k.contractNo}</Ltr>],
                    ['المدة', (k.startDate || k.endDate) && <Ltr>{[k.startDate && fmtDate(k.startDate), k.endDate && fmtDate(k.endDate)].filter(Boolean).join(' — ')}</Ltr>],
                    ['النطاق', <div className="long-text">{k.scope}</div>],
                    ['القضايا المشمولة', k.cases.length ? <div className="chip-list">{k.cases.map((x) => (x.accessible ? <Link key={x.id} to={`/cases/${x.id}`}><Badge tone="outline">{x.fileNo} — {x.title}</Badge></Link> : <Badge key={x.id} tone="neutral">{x.fileNo}</Badge>))}</div> : 'لم يُربط بقضايا محددة'],
                    ['نوع الأتعاب', FEE_TYPES[k.feeType].label],
                    ...(k.amountsHidden
                      ? ([['المبالغ', <span className="muted">مخفية — لا تملك صلاحية الأتعاب</span>]] as [string, ReactNode][])
                      : ([
                          ['الأتعاب الثابتة', k.fixedAmount !== null ? <Ltr>{fmtAmount(k.fixedAmount)}</Ltr> : null],
                          ['أتعاب نسبية', k.percentage !== null ? <span><Ltr>{k.percentage}%</Ltr> — {k.percentageBasis} <span className="help">(غير محتسبة كمستحق ثابت)</span></span> : null],
                          ['المدفوع / المتبقي', k.totals && <span><Ltr>{fmtAmount(k.totals.paid)}</Ltr> / <Ltr>{fmtAmount(k.totals.remaining)}</Ltr>{k.sharedAcrossCases && <span className="help"> — يخص العقد كاملًا ولا يُجمع لكل قضية</span>}</span>],
                          ['أتعاب نسبية متحققة', k.totals && k.totals.realizedPercentage ? <Ltr>{fmtAmount(k.totals.realizedPercentage)}</Ltr> : null],
                          ['خصومات وتسويات', k.totals && k.totals.adjustments ? <Ltr>{fmtAmount(k.totals.adjustments)}</Ltr> : null],
                          ['مبالغ مستردة', k.totals && k.totals.refunded ? <Ltr>{fmtAmount(k.totals.refunded)}</Ltr> : null],
                          ['مبلغ زائد يحتاج تسوية', k.totals && k.totals.overpaid ? <Ltr>{fmtAmount(k.totals.overpaid)}</Ltr> : null],
                        ] as [string, ReactNode | null][])),
                  ]}
                />
                {k.totals?.scheduleMismatch && <Alert tone="warning">مجموع البنود المالية لا يساوي إجمالي العقد.</Alert>}
                {linkedFiles((d) => d.contractId === k.id)}
              </Card>
            ))
          )}
        </div>
      )}
      {tab === 'poas' && (
        <div className="stack g2">
          {full && <div><Button variant="primary" icon={<Plus />} onClick={() => setModal('poa')}>تسجيل وكالة</Button></div>}
          {p.poas.length === 0 ? (
            <Card><Empty title="لا توجد وكالات مسجلة" /></Card>
          ) : (
            p.poas.map((x) => (
              <Card key={x.id} title={<div className="row wrap"><h2>وكالة {x.poaNo ? <Ltr>{x.poaNo}</Ltr> : 'دون رقم'}</h2><StatusBadge map={POA_STATUSES} value={x.status} /></div>} actions={full ? (<><Button size="sm" icon={<Paperclip />} onClick={() => setAttach({ clientId: c.id, poaId: x.id, category: 'poa', title: `وكالة ${x.poaNo ?? ''}`.trim() })}>إرفاق ملف الوكالة</Button><Button size="sm" icon={<Pencil />} onClick={() => setEditPoa(x)}>تعديل</Button></>) : undefined}>
                <KV
                  items={[
                    ['جهة الإصدار', x.issuer],
                    ['تاريخ الإصدار', x.issuedOn && <Ltr>{fmtDate(x.issuedOn)}</Ltr>],
                    ['تاريخ الانتهاء', x.expiresOn && <Ltr>{fmtDate(x.expiresOn)}</Ltr>],
                    ['التاريخ الهجري', x.hijriText],
                    ['النطاق المسجل', <div className="long-text">{x.scope}</div>],
                    ['الوكلاء', x.agents],
                    ['القضايا المشمولة', x.cases.length ? x.cases.map((y) => `${y.fileNo} — ${y.title}`).join('، ') : 'لم تُربط بقضايا — لا يُفترض شمولها لكل القضايا'],
                  ]}
                />
                {linkedFiles((d) => d.poaId === x.id)}
              </Card>
            ))
          )}
        </div>
      )}
      {tab === 'fees' && p.canFees && <ClientFees clientId={c.id} p={p} onPay={() => setModal('payment')} onExpense={() => setModal('expense')} />}
      {tab === 'docs' && (
        <div className="stack g2">
          <div className="row"><Button variant="primary" icon={<FilePlus2 />} onClick={() => setModal('doc')}>إرفاق مستند</Button></div>
          <DocumentBrowser docs={p.documents} selected={selectedDoc} onSelect={setSelectedDoc} emptyHint="أرفق العقود والوكالات والمستندات العامة أو مستندات القضايا." />
        </div>
      )}
      {tab === 'notes' && (
        <div className="grid c2">
          <Card title="الملاحظات" actions={<Button size="sm" icon={<StickyNote />} onClick={() => setModal('note')}>إضافة ملاحظة</Button>}>
            {p.notes.length === 0 ? (
              <Empty title="لا توجد ملاحظات" />
            ) : (
              <ul className="list-plain">
                {p.notes.map((n) => (
                  <li key={n.id}>
                    <div className="long-text">{n.body}</div>
                    <div className="help">
                      {n.byName} — <When at={n.createdAt} /> {n.caseFileNo && <>— ملف <Ltr>{n.caseFileNo}</Ltr></>} {n.isInternal ? <Badge tone="warning">داخلية</Badge> : <Badge tone="outline">تظهر في التقارير</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="سجل التواصل اليدوي" actions={<Button size="sm" icon={<MessageSquare />} onClick={() => setModal('comm')}>تسجيل تواصل</Button>}>
            {p.communications.length === 0 ? (
              <Empty title="لا يوجد سجل تواصل" />
            ) : (
              <ul className="list-plain">
                {p.communications.map((m) => (
                  <li key={m.id}>
                    <div className="row wrap" style={{ gap: 6 }}><Badge tone="outline">{COMM_CHANNELS[m.channel].label}</Badge><Ltr>{fmtDate(m.occurredOn)}</Ltr>{m.contactPerson && <span>— {m.contactPerson}</span>}</div>
                    <div className="long-text">{m.summary}</div>
                    <div className="help">سجّله {m.byName}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      {full && (
        <div className="row" style={{ marginTop: 24 }}>
          {c.status !== 'archived' ? (
            <Button size="sm" variant="ghost" icon={<Archive />} onClick={() => setModal('archive')}>أرشفة العميل</Button>
          ) : (
            <Button
              size="sm"
              icon={<ArchiveRestore />}
              onClick={async () => {
                try {
                  await api('clients.setStatus', { id: c.id, status: 'active' });
                  invalidate();
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              إلغاء أرشفة العميل
            </Button>
          )}
        </div>
      )}
      {modal === 'edit' && <ClientForm initial={c} onClose={() => setModal(null)} />}
      {modal === 'case' && <CaseForm clientId={c.id} onClose={() => setModal(null)} onSaved={(cid) => navigate(`/cases/${cid}`)} />}
      {modal === 'contract' && <ContractForm clientId={c.id} onClose={() => setModal(null)} />}
      {editContract && <ContractForm initial={editContract} clientId={c.id} onClose={() => setEditContract(null)} />}
      {feeItemFor && <FeeItemForm contractId={feeItemFor} percentageAllowed={['percentage', 'mixed'].includes(p.contracts.find((k) => k.id === feeItemFor)?.feeType ?? '')} onClose={() => setFeeItemFor(null)} />}
      {adjustFor && <AdjustmentForm contractId={adjustFor.id} title={adjustFor.title} onClose={() => setAdjustFor(null)} />}
      {modal === 'consultation' && <ConsultationForm defaults={{ clientId: c.id }} onClose={() => setModal(null)} onSaved={(cid) => navigate(`/appointments/consultations/${cid}`)} />}
      {modal === 'poa' && <PoaForm clientId={c.id} onClose={() => setModal(null)} />}
      {editPoa && <PoaForm clientId={c.id} initial={editPoa} onClose={() => setEditPoa(null)} />}
      {modal === 'payment' && <PaymentForm clientId={c.id} onClose={() => setModal(null)} />}
      {modal === 'expense' && <ExpenseForm clientId={c.id} onClose={() => setModal(null)} />}
      {attach && <DocumentAttachForm defaults={attach} onClose={() => setAttach(null)} />}
      {modal === 'doc' && <DocumentAttachForm defaults={{ clientId: c.id }} onClose={() => setModal(null)} onSaved={setSelectedDoc} />}
      {modal === 'note' && <NoteForm clientId={c.id} onClose={() => setModal(null)} />}
      {modal === 'comm' && <CommForm clientId={c.id} onClose={() => setModal(null)} />}
      {modal === 'archive' && (
        <ReasonForm
          title="أرشفة العميل"
          label="سبب الأرشفة (اختياري)"
          submitLabel="أرشفة"
          onClose={() => setModal(null)}
          onSubmit={async () => {
            await api('clients.setStatus', { id: c.id, status: 'archived' });
            invalidate();
            return true;
          }}
        />
      )}
    </div>
  );
}

function ClientFees({ clientId, p, onPay, onExpense }: { clientId: string; p: Profile; onPay: () => void; onExpense: () => void }) {
  const payments = useApi(() => api('payments.list', { clientId }), [clientId]);
  const expenses = useApi(() => api('expenses.list', { clientId }), [clientId]);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<string | null>(null);
  const f = p.finance!;
  return (
    <div className="stack g2">
      <div className="grid c4">
        <div className="card stat"><span className="label">المتفق عليه (ثابت)</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(f.agreed)}</Ltr></span><span className="note">مجموع العقود المميزة — كل عقد مرة واحدة</span></div>
        <div className="card stat"><span className="label">المسدد</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(f.paid)}</Ltr></span><span className="note">منه مقدم {fmtAmount(f.advance)}</span></div>
        <div className="card stat"><span className="label">المتبقي</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(f.remaining)}</Ltr></span></div>
        <div className="card stat"><span className="label">مصاريف مستردة غير مسددة</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(f.expenses.outstandingRecoverable)}</Ltr></span></div>
      </div>
      {f.percentage.length > 0 && <Alert tone="info">أتعاب نسبية مسجلة: {f.percentage.map((x) => `${x.title}: ${x.percentage ?? '—'}% (${x.basis ?? ''})`).join('؛ ')}. لا تُحتسب ضمن المستحق الثابت.</Alert>}
      <Card title="الدفعات" flush actions={p.canManageFees ? <Button size="sm" variant="primary" icon={<Banknote />} onClick={onPay}>تسجيل دفعة</Button> : undefined}>
        <DataTable
          rows={payments.data ?? []}
          rowKey={(r) => r.id}
          empty="لا توجد دفعات"
          columns={[
            { key: 'date', header: 'التاريخ', sortValue: (r) => r.paidOn, render: (r) => <Ltr>{fmtDate(r.paidOn)}</Ltr> },
            { key: 'contract', header: 'العقد / البند', sortValue: (r) => r.contractTitle, render: (r) => `${r.contractTitle}${r.feeItemTitle ? ' / ' + r.feeItemTitle : ''}` },
            { key: 'amount', header: 'المبلغ', sortValue: (r) => r.amount, render: (r) => <Ltr>{fmtAmount(r.amount)}</Ltr> },
            { key: 'kind', header: 'النوع', sortValue: (r) => (r.isAdvance ? 0 : 1), render: (r) => (r.isAdvance ? <Badge tone="info">مقدم</Badge> : <Badge tone="outline">دفعة</Badge>) },
            { key: 'method', header: 'الطريقة', sortValue: (r) => r.method ?? '', render: (r) => r.method ?? '—' },
            { key: 'ref', header: 'رقم السند', sortValue: (r) => r.referenceNo ?? '', render: (r) => <Ltr>{r.referenceNo}</Ltr> },
            { key: 'st', header: 'الحالة', render: (r) => (r.voided ? <Badge tone="danger">ملغاة: {r.voidReason}</Badge> : <Badge tone="success">سارية</Badge>) },
            {
              key: 'act',
              header: '',
              className: 'actions',
              render: (r) =>
                p.canManageFees && !r.voided ? (
                  <div className="row">
                    {!r.receiptDocumentId && <Button size="sm" icon={<FileText />} onClick={() => setReceiptFor(r.id)}>إرفاق السند</Button>}
                    {r.receiptDocumentId && <Badge tone="outline">السند مرفق</Badge>}
                    <Button size="sm" variant="ghost" onClick={() => setVoidFor(r.id)}>إلغاء</Button>
                  </div>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card title="المصاريف" flush actions={p.canManageFees ? <Button size="sm" onClick={onExpense}>تسجيل مصروف</Button> : undefined}>
        <DataTable
          rows={expenses.data ?? []}
          rowKey={(r) => r.id}
          empty="لا توجد مصاريف"
          columns={[
            { key: 'date', header: 'التاريخ', sortValue: (r) => r.spentOn, render: (r) => <Ltr>{fmtDate(r.spentOn)}</Ltr> },
            { key: 'title', header: 'البيان', sortValue: (r) => r.title },
            { key: 'case', header: 'الملف', sortValue: (r) => r.caseFileNo ?? '', render: (r) => <Ltr>{r.caseFileNo}</Ltr> },
            { key: 'amount', header: 'المبلغ', sortValue: (r) => r.amount, render: (r) => <Ltr>{fmtAmount(r.amount)}</Ltr> },
            { key: 'rec', header: 'الاسترداد', render: (r) => (r.recoverable ? (r.reimbursedOn ? <Badge tone="success">سُدد <Ltr>{fmtDate(r.reimbursedOn)}</Ltr></Badge> : <Badge tone="warning">يُسترد — لم يُسدد</Badge>) : <Badge>على المكتب</Badge>) },
          ]}
        />
      </Card>
      <div className="help">هذا كشف متابعة داخلي وليس فاتورة ضريبية.</div>
      {receiptFor && <DocumentAttachForm defaults={{ clientId, paymentId: receiptFor, category: 'receipt', title: 'سند دفع' }} onClose={() => setReceiptFor(null)} />}
      {voidFor && (
        <ReasonForm
          title="إلغاء دفعة"
          label="سبب الإلغاء"
          required
          submitLabel="إلغاء الدفعة"
          onClose={() => setVoidFor(null)}
          onSubmit={async (reason) => {
            const r = await api('payments.void', { id: voidFor, reason });
            invalidate();
            return r;
          }}
        />
      )}
    </div>
  );
}

