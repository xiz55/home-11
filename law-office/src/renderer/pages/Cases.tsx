import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import { Badge, Button, DataTable, ErrorBox, Loading, StatusBadge, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi, useDebounced } from '../lib/hooks';
import { useSession } from '../lib/session';
import { LastActionCell, NextEventCell } from '../lib/display';
import { CASE_STATUSES, FOLLOW_STATUSES, PRIORITIES } from '../../shared/constants';
import { CaseForm } from '../forms/clientCase';
import { optsFrom } from '../forms/common';

export function CasesPage() {
  const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [status, setStatus] = useState('');
  const [follow, setFollow] = useState('');
  const [caseType, setCaseType] = useState('');
  const [resp, setResp] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived' | 'all'>('active');
  const dq = useDebounced(q, 250);
  const { lookup, users, can } = useSession();
  const navigate = useNavigate();
  const [add, setAdd] = useState(false);
  const list = useApi(
    () => api('cases.list', { q: dq || null, status: (status || null) as never, followStatus: (follow || null) as never, caseType: caseType || null, responsibleUserId: resp || null, archived }),
    [dq, status, follow, caseType, resp, archived],
  );
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>القضايا</h1>
          <div className="sub">كل ملفات القضايا المسموحة لك</div>
        </div>
        {can('cases.create') && (
          <Button variant="primary" icon={<Briefcase />} onClick={() => setAdd(true)}>
            إضافة قضية
          </Button>
        )}
      </div>
      <section className="card">
        <div className="toolbar">
          <input className="input search-input" placeholder="ابحث بالعنوان، رقم الملف، الرقم الرسمي، العميل، الخصم…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في القضايا" />
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="حالة الملف">
            <option value="">كل الحالات</option>
            {optsFrom(CASE_STATUSES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="select" value={follow} onChange={(e) => setFollow(e.target.value)} aria-label="حالة المتابعة">
            <option value="">كل حالات المتابعة</option>
            {optsFrom(FOLLOW_STATUSES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className="select" value={caseType} onChange={(e) => setCaseType(e.target.value)} aria-label="نوع القضية">
            <option value="">كل الأنواع</option>
            {lookup('case_types').map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="select" value={resp} onChange={(e) => setResp(e.target.value)} aria-label="المسؤول">
            <option value="">كل المسؤولين</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
          <select className="select" value={archived} onChange={(e) => setArchived(e.target.value as never)} aria-label="الأرشفة">
            <option value="active">غير المؤرشفة</option>
            <option value="archived">المؤرشفة</option>
            <option value="all">الكل</option>
          </select>
        </div>
        {list.error ? (
          <div className="card-pad"><ErrorBox error={list.error} onRetry={list.reload} /></div>
        ) : list.loading && !list.data ? (
          <Loading />
        ) : (
          <DataTable
            rows={list.data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/cases/${r.id}`)}
            empty={dq ? 'لا توجد نتائج مطابقة' : 'لا توجد قضايا'}
            columns={[
              { key: 'title', header: 'القضية', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div><div className="sub">ملف <Ltr>{r.fileNo}</Ltr> — {r.clientName}</div></div> },
              { key: 'type', header: 'النوع', sortValue: (r) => r.caseType ?? '', render: (r) => r.caseType ?? '—' },
              { key: 'opp', header: 'الخصم', sortValue: (r) => r.opponents.join(' '), render: (r) => r.opponents.join('، ') || '—' },
              { key: 'stage', header: 'المرحلة', sortValue: (r) => r.stage?.stageType ?? '', render: (r) => (r.stage ? <div>{r.stage.stageType}{r.stage.officialCaseNo && <div className="sub"><Ltr>{r.stage.officialCaseNo}</Ltr></div>}</div> : <span className="muted">—</span>) },
              { key: 'status', header: 'الحالة', sortValue: (r) => r.status + r.followStatus, render: (r) => <div className="row wrap" style={{ gap: 4 }}><StatusBadge map={CASE_STATUSES} value={r.status} />{r.archived && <Badge>مؤرشفة</Badge>}<StatusBadge map={FOLLOW_STATUSES} value={r.followStatus} /></div> },
              { key: 'prio', header: 'الأولوية', sortValue: (r) => ['low', 'normal', 'high', 'urgent'].indexOf(r.priority), render: (r) => <StatusBadge map={PRIORITIES} value={r.priority} /> },
              { key: 'resp', header: 'المسؤول', sortValue: (r) => r.responsible ?? '', render: (r) => r.responsible ?? '—' },
              { key: 'last', header: 'آخر إجراء', sortValue: (r) => r.lastAction?.at ?? '', render: (r) => <LastActionCell a={r.lastAction} /> },
              { key: 'next', header: 'التالي', sortValue: (r) => r.nextEvent?.at ?? 'z', render: (r) => <NextEventCell ev={r.nextEvent} /> },
            ]}
          />
        )}
      </section>
      {add && <CaseForm onClose={() => setAdd(false)} onSaved={(id) => navigate(`/cases/${id}`)} />}
    </div>
  );
}
