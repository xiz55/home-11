import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FilePlus2, ListChecks, Search as SearchIcon, Banknote, ScrollText } from 'lucide-react';
import { Badge, Button, Card, DataTable, Empty, ErrorBox, Loading, StatusBadge, toast, Ltr } from '../components/ui';
import { api, invalidate } from '../lib/api';
import { useApi, useDebounced } from '../lib/hooks';
import { useSession } from '../lib/session';
import { When } from '../lib/display';
import { CONTRACT_KINDS, CONTRACT_STATUSES, DOC_CATEGORIES, PRIORITIES, TASK_STATUSES, FEE_TYPES } from '../../shared/constants';
import { fmtAmount } from '../../shared/money';
import { fmtDate } from '../../shared/dates';
import { TaskForm, PaymentForm, ContractForm, ExpenseForm } from '../forms/finance';
import { DocumentAttachForm } from '../forms/docs';
import { DocumentBrowser } from '../components/viewer';
import { optsFrom } from '../forms/common';
import type { MethodOutput } from '../../main/ipc/registry';

export function TasksPage() {
  const [sp] = useSearchParams();
  const [status, setStatus] = useState(sp.get('status') ?? 'open');
  const [assignee, setAssignee] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const { users } = useSession();
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<MethodOutput<'tasks.list'>[number] | null>(null);
  const navigate = useNavigate();
  const list = useApi(() => api('tasks.list', { status, assigneeUserId: assignee || null, q: dq || null }), [status, assignee, dq]);
  const setTaskStatus = async (id: string, s: string) => {
    try {
      await api('tasks.setStatus', { id, status: s as never });
      invalidate();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>المهام</h1>
          <div className="sub">مهام المكتب المرتبطة بالعملاء والقضايا والجلسات</div>
        </div>
        <Button variant="primary" icon={<ListChecks />} onClick={() => setAdd(true)}>إضافة مهمة</Button>
      </div>
      <section className="card">
        <div className="toolbar">
          <input className="input search-input" placeholder="بحث في المهام…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المهام" />
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
            <option value="open">غير المكتملة</option>
            <option value="overdue">المتأخرة</option>
            {optsFrom(TASK_STATUSES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            <option value="all">الكل</option>
          </select>
          <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="المسؤول">
            <option value="">كل المسؤولين</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>
        {list.error ? (
          <div className="card-pad"><ErrorBox error={list.error} /></div>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : (
          <DataTable
            rows={list.data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => setEdit(r)}
            empty="لا توجد مهام"
            columns={[
              { key: 't', header: 'المهمة', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div>{r.hearingRequestId && <div className="sub">من طلب ورد في جلسة</div>}</div> },
              { key: 'c', header: 'الملف', sortValue: (r) => r.caseFileNo ?? r.clientName ?? '', render: (r) => (r.caseId ? <Link to={`/cases/${r.caseId}?tab=tasks`} onClick={(e) => e.stopPropagation()}><Ltr>{r.caseFileNo}</Ltr> — {r.caseTitle}</Link> : r.clientName ?? <span className="muted">عامة</span>) },
              { key: 'a', header: 'المسؤول', sortValue: (r) => r.assigneeName ?? '', render: (r) => r.assigneeName ?? '—' },
              { key: 'd', header: 'الاستحقاق', sortValue: (r) => r.dueDate ?? 'z', render: (r) => (r.dueDate ? <span><Ltr>{fmtDate(r.dueDate)}</Ltr>{r.dueTime && <> <Ltr>{r.dueTime}</Ltr></>} {r.overdue && <Badge tone="danger">متأخرة</Badge>}</span> : '—') },
              { key: 'p', header: 'الأولوية', sortValue: (r) => ['low', 'normal', 'high', 'urgent'].indexOf(r.priority), render: (r) => <StatusBadge map={PRIORITIES} value={r.priority} /> },
              {
                key: 's',
                header: 'الحالة',
                sortValue: (r) => r.status,
                render: (r) => (
                  <select className="select" style={{ height: 34, width: 'auto' }} value={r.status} onClick={(e) => e.stopPropagation()} onChange={(e) => void setTaskStatus(r.id, e.target.value)} aria-label="حالة المهمة">
                    {Object.entries(TASK_STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                ),
              },
            ]}
          />
        )}
      </section>
      {add && <TaskForm onClose={() => setAdd(false)} />}
      {edit && <TaskForm initial={edit} onClose={() => setEdit(null)} />}
      <div className="help" style={{ marginTop: 12 }}>نقر الصف يفتح المهمة للتعديل. <a href="#" onClick={(e) => { e.preventDefault(); navigate('/calendar'); }}>عرض المهام في التقويم</a></div>
    </div>
  );
}

export function DocumentsPage() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [clientId, setClientId] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived' | 'all'>('active');
  const dq = useDebounced(q, 300);
  const clients = useApi(() => api('clients.options', {}), []);
  const list = useApi(() => api('documents.list', { q: dq || null, category: (cat || null) as never, clientId: clientId || null, archived }), [dq, cat, clientId, archived]);
  const [sel, setSel] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>المستندات والمذكرات</h1>
          <div className="sub">كل المرفقات المحفوظة في مستودع البرنامج. المذكرات المكتوبة داخل البرنامج تجدها في تبويب «المستندات والمذكرات» بكل قضية.</div>
        </div>
        <Button variant="primary" icon={<FilePlus2 />} onClick={() => setAdd(true)}>إرفاق مستند</Button>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar">
          <input className="input search-input" placeholder="ابحث في العناوين والأوصاف وأسماء الملفات والنص المستخرج…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المستندات" />
          <select className="select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="التصنيف">
            <option value="">كل التصنيفات</option>
            {optsFrom(DOC_CATEGORIES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="العميل">
            <option value="">كل العملاء</option>
            {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" value={archived} onChange={(e) => setArchived(e.target.value as never)} aria-label="الأرشفة">
            <option value="active">غير المؤرشفة</option>
            <option value="archived">المؤرشفة</option>
            <option value="all">الكل</option>
          </select>
          {list.data && <span className="help">{list.data.length} مستند</span>}
        </div>
      </section>
      {list.error ? <ErrorBox error={list.error} /> : list.loading && !list.data ? <Loading /> : <DocumentBrowser docs={list.data ?? []} selected={sel} onSelect={setSel} emptyHint="البحث لا يشمل الصور الممسوحة ضوئيًا لعدم وجود نص مستخرج منها." />}
      {add && <DocumentAttachForm onClose={() => setAdd(false)} onSaved={setSel} />}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { client: 'العملاء', case: 'القضايا', memo: 'المذكرات', note: 'الملاحظات', communication: 'سجل التواصل', document: 'المستندات', hearing: 'ملخصات الجلسات' };

export function SearchPage() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const r = useApi(() => api('search.global', { q }), [q]);
  const navigate = useNavigate();
  const open = (h: MethodOutput<'search.global'>['hits'][number]) => {
    if (h.type === 'client') navigate(`/clients/${h.id}`);
    else if (h.type === 'case') navigate(`/cases/${h.id}`);
    else if (h.type === 'memo') navigate(`/cases/${h.caseId}/memos/${h.id}`);
    else if (h.type === 'hearing') navigate(`/cases/${h.caseId}?tab=stages&hearing=${h.id}`);
    else if (h.type === 'document') navigate(h.caseId ? `/cases/${h.caseId}?tab=docs` : `/clients/${h.clientId}?tab=docs`);
    else navigate(h.caseId ? `/cases/${h.caseId}` : `/clients/${h.clientId}?tab=notes`);
  };
  const groups = new Map<string, MethodOutput<'search.global'>['hits']>();
  for (const h of r.data?.hits ?? []) groups.set(h.type, [...(groups.get(h.type) ?? []), h]);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>نتائج البحث</h1>
          <div className="sub">«{q}» — البحث يطابق الصيغ العربية (الهمزات والتاء المربوطة والتشكيل) دون تغيير النص الأصلي</div>
        </div>
      </div>
      {r.loading && !r.data ? (
        <Loading />
      ) : r.error ? (
        <ErrorBox error={r.error} />
      ) : (r.data?.hits.length ?? 0) === 0 ? (
        <Card><Empty title="لا توجد نتائج" icon={<SearchIcon />}>جرّب كلمة أقصر أو جزءًا من الاسم أو الرقم.</Empty></Card>
      ) : (
        <div className="stack g2">
          {[...groups.entries()].map(([type, hits]) => (
            <Card key={type} title={`${TYPE_LABEL[type]} (${hits.length})`} flush>
              <ul className="list-plain" style={{ padding: '0 24px' }}>
                {hits.map((h) => (
                  <li key={h.type + h.id} style={{ cursor: 'pointer' }} onClick={() => open(h)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(h)}>
                    <div style={{ fontWeight: 500 }}>{h.title}</div>
                    {h.subtitle && <div className="help">{h.type === 'hearing' ? <When at={h.subtitle} /> : h.subtitle}</div>}
                    {h.snippet && <div className="help" style={{ color: 'var(--text)' }}>{h.snippet}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function FeesPage() {
  const { can } = useSession();
  const office = useApi(() => api('finance.officeSummary', {}), []);
  const contracts = useApi(() => api('contracts.list', {}), []);
  const payments = useApi(() => api('payments.list', {}), []);
  const expenses = useApi(() => api('expenses.list', {}), []);
  const [modal, setModal] = useState<null | 'contract' | 'payment' | 'expense'>(null);
  const navigate = useNavigate();
  if (office.error) return <ErrorBox error={office.error} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>الأتعاب</h1>
          <div className="sub">العقود والدفعات والمصاريف. العقد الشامل لعدة قضايا يُحسب مرة واحدة. هذا كشف متابعة وليس فاتورة ضريبية.</div>
        </div>
        {can('fees.manage') && (
          <div className="btn-group">
            <Button variant="primary" icon={<Banknote />} onClick={() => setModal('payment')}>تسجيل دفعة</Button>
            <Button icon={<ScrollText />} onClick={() => setModal('contract')}>إضافة عقد</Button>
            <Button onClick={() => setModal('expense')}>تسجيل مصروف</Button>
          </div>
        )}
      </div>
      {office.data && (
        <div className="grid c4" style={{ marginBottom: 16 }}>
          <div className="card stat"><span className="label">العقود</span><span className="value"><Ltr>{office.data.contractCount}</Ltr></span></div>
          <div className="card stat"><span className="label">المتفق عليه (ثابت)</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(office.data.agreed)}</Ltr></span></div>
          <div className="card stat"><span className="label">المدفوع</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(office.data.paid)}</Ltr></span></div>
          <div className="card stat"><span className="label">المتبقي المسجل</span><span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(office.data.remaining)}</Ltr></span></div>
        </div>
      )}
      <div className="stack g2">
        <Card title="العقود" flush>
          <DataTable
            rows={contracts.data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/clients/${r.clientId}?tab=contracts`)}
            empty="لا توجد عقود"
            columns={[
              { key: 't', header: 'العقد', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div><div className="sub">{r.clientName}</div></div> },
              { key: 'k', header: 'النوع', render: (r) => <span>{CONTRACT_KINDS[r.kind].label} — {FEE_TYPES[r.feeType].label}</span> },
              { key: 'c', header: 'القضايا', render: (r) => (r.cases.length ? <span>{r.cases.length} {r.sharedAcrossCases && <Badge tone="info">شامل</Badge>}</span> : '—') },
              { key: 'a', header: 'المتفق عليه', sortValue: (r) => r.totals?.agreed ?? 0, render: (r) => <Ltr>{fmtAmount(r.totals?.agreed ?? 0)}</Ltr> },
              { key: 'p', header: 'المدفوع', sortValue: (r) => r.totals?.paid ?? 0, render: (r) => <Ltr>{fmtAmount(r.totals?.paid ?? 0)}</Ltr> },
              { key: 'r', header: 'المتبقي', sortValue: (r) => r.totals?.remaining ?? 0, render: (r) => <Ltr>{fmtAmount(r.totals?.remaining ?? 0)}</Ltr> },
              { key: 's', header: 'الحالة', render: (r) => <StatusBadge map={CONTRACT_STATUSES} value={r.status} /> },
            ]}
          />
        </Card>
        <Card title="آخر الدفعات" flush>
          <DataTable
            rows={payments.data ?? []}
            rowKey={(r) => r.id}
            bounded
            onRowClick={(r) => navigate(`/clients/${r.clientId}?tab=fees`)}
            empty="لا توجد دفعات"
            columns={[
              { key: 'd', header: 'التاريخ', sortValue: (r) => r.paidOn, render: (r) => <Ltr>{fmtDate(r.paidOn)}</Ltr> },
              { key: 'c', header: 'العقد', sortValue: (r) => r.contractTitle },
              { key: 'a', header: 'المبلغ', sortValue: (r) => r.amount, render: (r) => <Ltr>{fmtAmount(r.amount)}</Ltr> },
              { key: 'm', header: 'الطريقة', render: (r) => r.method ?? '—' },
              { key: 'ref', header: 'رقم السند', render: (r) => <Ltr>{r.referenceNo}</Ltr> },
              { key: 's', header: 'الحالة', render: (r) => (r.voided ? <Badge tone="danger">ملغاة</Badge> : r.receiptDocumentId ? <Badge tone="success">السند مرفق</Badge> : <Badge>دون سند</Badge>) },
            ]}
          />
        </Card>
        <Card title="المصاريف" flush>
          <DataTable
            rows={expenses.data ?? []}
            rowKey={(r) => r.id}
            bounded
            empty="لا توجد مصاريف"
            columns={[
              { key: 'd', header: 'التاريخ', sortValue: (r) => r.spentOn, render: (r) => <Ltr>{fmtDate(r.spentOn)}</Ltr> },
              { key: 't', header: 'البيان', sortValue: (r) => r.title },
              { key: 'a', header: 'المبلغ', sortValue: (r) => r.amount, render: (r) => <Ltr>{fmtAmount(r.amount)}</Ltr> },
              { key: 'r', header: 'الاسترداد', render: (r) => (r.recoverable ? (r.reimbursedOn ? 'سُدد' : 'يُسترد') : 'على المكتب') },
            ]}
          />
        </Card>
      </div>
      {modal === 'contract' && <ContractForm onClose={() => setModal(null)} />}
      {modal === 'payment' && <PaymentForm onClose={() => setModal(null)} />}
      {modal === 'expense' && <ExpenseForm onClose={() => setModal(null)} />}
    </div>
  );
}
