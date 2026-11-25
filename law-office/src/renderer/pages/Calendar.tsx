import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CalendarCheck, MessagesSquare, Users, Gavel } from 'lucide-react';
import { Alert, Badge, Button, Card, DataTable, Empty, ErrorBox, Loading, StatusBadge, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession, useOs } from '../lib/session';
import { EVENT_KIND, TimeOf, When, eventPath } from '../lib/display';
import { addDays, fmtDateLong, monthName, todayRiyadh, weekdayOf, pad } from '../../shared/dates';
import { HEARING_STATUSES, TASK_STATUSES, DEADLINE_STATUSES, CONSULT_STATUSES, MEETING_STATUSES } from '../../shared/constants';
import type { MethodOutput } from '../../main/ipc/registry';

type Ev = MethodOutput<'calendar.events'>[number];
type View = 'week' | 'month' | 'list';
const DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function startOfWeek(d: string) {
  return addDays(d, -weekdayOf(d));
}

function statusOf(e: Ev) {
  if (e.kind === 'hearing') return <StatusBadge map={HEARING_STATUSES} value={e.status} />;
  if (e.kind === 'task') return <StatusBadge map={TASK_STATUSES} value={e.status} />;
  if (e.kind === 'consultation') return <StatusBadge map={CONSULT_STATUSES} value={e.status} />;
  if (e.kind === 'meeting') return <StatusBadge map={MEETING_STATUSES} value={e.status} />;
  return <StatusBadge map={DEADLINE_STATUSES} value={e.status} />;
}

/** أيقونة تميّز نوع الموعد بالإضافة إلى اسمه (لا يُعتمد على اللون وحده). */
export function KindIcon({ kind }: { kind: string }) {
  if (kind === 'consultation') return <MessagesSquare size={13} aria-hidden />;
  if (kind === 'meeting') return <Users size={13} aria-hidden />;
  if (kind === 'hearing') return <Gavel size={13} aria-hidden />;
  return null;
}

export function CalendarPage() {
  return <CalendarView />;
}

export function CalendarView({ only, embedded }: { only?: ('consultation' | 'meeting')[]; embedded?: boolean }) {
  const today = todayRiyadh();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [clientId, setClientId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [resp, setResp] = useState('');
  const { users } = useSession();
  const os = useOs();
  const clients = useApi(() => api('clients.options', {}), []);
  const cases = useApi(() => api('cases.options', { clientId: clientId || null }), [clientId]);
  const navigate = useNavigate();
  const range = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(anchor);
      return { from: s, to: addDays(s, 6) };
    }
    if (view === 'month') {
      const first = `${anchor.slice(0, 7)}-01`;
      const s = startOfWeek(first);
      return { from: s, to: addDays(s, 41) };
    }
    return { from: anchor, to: addDays(anchor, 60) };
  }, [view, anchor]);
  const q = useApi(() => api('calendar.events', { from: range.from, to: range.to, clientId: clientId || null, caseId: caseId || null, responsibleUserId: resp || null }), [range.from, range.to, clientId, caseId, resp]);
  const events = useMemo(() => (q.data ?? []).filter((e) => !only || (only as string[]).includes(e.kind)), [q.data, only]);
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [events]);
  const move = (dir: 1 | -1) => {
    if (view === 'week') setAnchor(addDays(anchor, 7 * dir));
    else if (view === 'month') {
      const [y, mo] = anchor.split('-').map(Number);
      const d = new Date(Date.UTC(y, mo - 1 + dir, 1));
      setAnchor(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`);
    } else setAnchor(addDays(anchor, 30 * dir));
  };
  const title =
    view === 'month'
      ? `${monthName(Number(anchor.slice(5, 7)))} ${anchor.slice(0, 4)}`
      : view === 'week'
        ? `أسبوع ${fmtDateLong(range.from)}`
        : `من ${fmtDateLong(range.from)} — 60 يومًا`;
  const dayEvents = byDay.get(selected) ?? [];
  const evChip = (e: Ev) => (
    <div key={e.kind + e.id} className={`cal-ev ${e.kind} ${e.confirmed ? '' : 'unconfirmed'}`} title={e.title}>
      <KindIcon kind={e.kind} /> {e.time && <Ltr>{e.time}</Ltr>} {e.kind === 'hearing' ? e.caseTitle : e.title}
    </div>
  );
  return (
    <div>
      <div className="page-head">
        {embedded ? (
          <div className="sub">الاستشارات والاجتماعات فقط. التقويم العام للمكتب يعرضها مع الجلسات والمهام.</div>
        ) : (
          <div>
            <h1>التقويم والجلسات</h1>
            <div className="sub">تقويم موحد للمكتب بتوقيت الرياض: الجلسات والمهام والمواعيد الإجرائية والاستشارات والاجتماعات. المواعيد غير المؤكدة تظهر بإطار متقطع.</div>
          </div>
        )}
        <div className="seg" role="tablist" aria-label="طريقة العرض">
          {(['week', 'month', 'list'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} role="tab" aria-selected={view === v}>
              {v === 'week' ? 'أسبوع' : v === 'month' ? 'شهر' : 'قائمة'}
            </button>
          ))}
        </div>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar">
          <Button size="sm" iconOnly icon={<ChevronRight />} aria-label="السابق" title="السابق" onClick={() => move(-1)} />
          <strong style={{ minWidth: 200, textAlign: 'center' }}>{title}</strong>
          <Button size="sm" iconOnly icon={<ChevronLeft />} aria-label="التالي" title="التالي" onClick={() => move(1)} />
          <Button size="sm" icon={<CalendarCheck />} onClick={() => { setAnchor(today); setSelected(today); }}>اليوم</Button>
          <span className="grow" />
          <select className="select" value={clientId} onChange={(e) => { setClientId(e.target.value); setCaseId(''); }} aria-label="العميل">
            <option value="">كل العملاء</option>
            {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" value={caseId} onChange={(e) => setCaseId(e.target.value)} aria-label="القضية">
            <option value="">كل القضايا</option>
            {(cases.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.fileNo} — {c.title}</option>)}
          </select>
          <select className="select" value={resp} onChange={(e) => setResp(e.target.value)} aria-label="المسؤول">
            <option value="">كل المسؤولين</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>
      </section>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : q.loading && !q.data ? (
        <Loading />
      ) : view === 'list' ? (
        <Card flush>
          <DataTable
            rows={events}
            rowKey={(r) => r.kind + r.id}
            onRowClick={(r) => {
              const p = eventPath(r);
              if (p) navigate(p);
            }}
            empty="لا توجد مواعيد في هذه الفترة"
            columns={[
              { key: 'w', header: 'الموعد', sortValue: (r) => r.date + (r.time ?? ''), render: (r) => (r.startsAt ? <When at={r.startsAt} /> : <When at={r.date} dateOnly />) },
              { key: 'k', header: 'النوع', render: (r) => <div className="row" style={{ gap: 4 }}><Badge tone={EVENT_KIND[r.kind].tone}><KindIcon kind={r.kind} /> {EVENT_KIND[r.kind].label}</Badge>{!r.confirmed && <Badge tone="warning">غير مؤكد</Badge>}</div> },
              { key: 't', header: 'البيان', sortValue: (r) => r.title, render: (r) => <div>{r.kind === 'hearing' ? r.caseTitle : r.title}{r.stageType && <div className="sub">{r.stageType}{r.location ? ` — ${r.location}` : ''}</div>}</div> },
              { key: 'c', header: 'العميل / الملف', render: (r) => <div>{r.clientName ?? '—'}{(r.fileNo ?? r.refNo) && <div className="sub"><Ltr>{r.fileNo ?? r.refNo}</Ltr></div>}</div> },
              { key: 'r', header: 'المسؤول', render: (r) => r.responsible ?? '—' },
              { key: 's', header: 'الحالة', render: (r) => statusOf(r) },
            ]}
          />
        </Card>
      ) : (
        <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 0.8fr)' }}>
          {view === 'month' ? (
            <section className="card" aria-label="عرض الشهر">
              <div className="cal-grid">
                {DOW.map((d) => <div key={d} className="dow">{d}</div>)}
                {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((d) => {
                  const evs = byDay.get(d) ?? [];
                  const other = d.slice(0, 7) !== anchor.slice(0, 7);
                  return (
                    <button key={d} className={`cal-cell ${other ? 'other' : ''} ${d === today ? 'today' : ''} ${d === selected ? 'selected' : ''}`} onClick={() => setSelected(d)} aria-label={`${fmtDateLong(d)}: ${evs.length} موعد`}>
                      <span className="dnum"><Ltr>{Number(d.slice(8))}</Ltr></span>
                      {evs.slice(0, 3).map(evChip)}
                      {evs.length > 3 && <span className="help">+{evs.length - 3} أخرى</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : (
            <div className="week-grid" aria-label="عرض الأسبوع">
              {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => (
                <div key={d} className={`week-day ${d === today ? 'today' : ''}`}>
                  <div className="wd-head" onClick={() => setSelected(d)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(d)}>
                    {DOW[weekdayOf(d)]} <Ltr>{Number(d.slice(8))}</Ltr>
                  </div>
                  <div className="wd-body">
                    {(byDay.get(d) ?? []).map((e) => (
                      <button key={e.kind + e.id} className="ev-card" onClick={() => setSelected(d)} style={{ borderStyle: e.confirmed ? 'solid' : 'dashed' }}>
                        <div className="row" style={{ gap: 4 }}><Badge tone={EVENT_KIND[e.kind].tone}><KindIcon kind={e.kind} /> {EVENT_KIND[e.kind].label}</Badge>{e.time && <Ltr>{e.time}</Ltr>}</div>
                        <div>{e.kind === 'hearing' ? e.caseTitle : e.title}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <Card title={fmtDateLong(selected)} sub={`${dayEvents.length} موعد`}>
            {dayEvents.length === 0 ? (
              <Empty title="لا مواعيد مسجلة في هذا اليوم" />
            ) : (
              <ul className="list-plain">
                {dayEvents.map((e) => (
                  <li key={e.kind + e.id}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <Badge tone={EVENT_KIND[e.kind].tone}><KindIcon kind={e.kind} /> {EVENT_KIND[e.kind].label}</Badge>
                      {e.startsAt && <TimeOf iso={e.startsAt} />}
                      {statusOf(e)}
                      {!e.confirmed && <Badge tone="warning">غير مؤكد</Badge>}
                    </div>
                    <div style={{ fontWeight: 500, marginTop: 4 }}>{e.kind === 'hearing' ? e.caseTitle : e.title}</div>
                    <div className="help">
                      {e.clientName} {(e.fileNo ?? e.refNo) && <>— <Ltr>{e.fileNo ?? e.refNo}</Ltr></>} {e.stageType && `— ${e.stageType}`} {e.location && `— ${e.location}`} {e.responsible && `— ${e.responsible}`}
                    </div>
                    {(e.kind === 'consultation' || e.kind === 'meeting') && (
                      <div className="btn-group" style={{ marginTop: 6 }}>
                        <Button size="sm" onClick={() => navigate(eventPath(e)!)}>{e.kind === 'consultation' ? 'فتح الاستشارة' : 'فتح الاجتماع'}</Button>
                      </div>
                    )}
                    {e.caseId && e.kind !== 'consultation' && e.kind !== 'meeting' && (
                      <div className="btn-group" style={{ marginTop: 6 }}>
                        <Button size="sm" onClick={() => navigate(`/cases/${e.caseId}`)}>فتح القضية</Button>
                        {e.kind === 'hearing' && <Button size="sm" onClick={() => navigate(`/cases/${e.caseId}?tab=stages&hearing=${e.id}`)}>فتح الجلسة</Button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div style={{ marginTop: 12 }}>
              <Alert tone="neutral">{os.notifications} تصل فقط أثناء تشغيل البرنامج وبإذن الإشعارات في النظام. ما يفوت أثناء الإغلاق يُعرض عند الفتح التالي.</Alert>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
