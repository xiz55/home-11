import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Briefcase, CalendarClock, HardDriveDownload, ListTodo, Wallet } from 'lucide-react';
import { Alert, Badge, Button, Card, Empty, ErrorBox, Loading, StatusBadge, Ltr } from '../components/ui';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { EVENT_KIND, When, TimeOf } from '../lib/display';
import { fmtAmount } from '../../shared/money';
import { fmtDateLong, fmtDate } from '../../shared/dates';
import { PRIORITIES, TASK_STATUSES, HEARING_STATUSES } from '../../shared/constants';

export function DashboardPage() {
  const q = useApi(() => api('dashboard.get', {}), []);
  const navigate = useNavigate();
  const { state } = useSession();
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  return (
    <div className="stack g3">
      <div className="page-head">
        <div>
          <h1>مرحبًا، {state?.user?.displayName}</h1>
          <div className="sub">{fmtDateLong(d.today)} — بتوقيت الرياض</div>
        </div>
      </div>
      {d.backup?.due && (
        <Alert tone="warning">
          <div className="row between wrap">
            <span>{d.backup.lastBackupAt ? `مضى أكثر من ${d.backup.reminderDays} أيام على آخر نسخة احتياطية (${fmtDate(d.backup.lastBackupAt.slice(0, 10))}).` : 'لم تُنشأ أي نسخة احتياطية بعد.'} احفظ نسخة على قرص خارجي.</span>
            <Button size="sm" icon={<HardDriveDownload />} onClick={() => navigate('/settings?tab=storage')}>
              نسخ احتياطي الآن
            </Button>
          </div>
        </Alert>
      )}
      <div className="grid c4">
        <button className="card stat" style={{ textAlign: 'right', cursor: 'pointer', font: 'inherit' }} onClick={() => navigate('/cases')}>
          <span className="label"><Briefcase size={18} /> الملفات النشطة</span>
          <span className="value"><Ltr>{d.counts.activeCases}</Ltr></span>
          <span className="note">قضايا مفتوحة غير مؤرشفة</span>
        </button>
        <button className="card stat" style={{ textAlign: 'right', cursor: 'pointer', font: 'inherit' }} onClick={() => navigate('/calendar')}>
          <span className="label"><CalendarClock size={18} /> جلسات اليوم</span>
          <span className="value"><Ltr>{d.counts.todayHearings}</Ltr></span>
          <span className="note">المسجلة لتاريخ اليوم</span>
        </button>
        <button className="card stat" style={{ textAlign: 'right', cursor: 'pointer', font: 'inherit' }} onClick={() => navigate('/tasks?status=overdue')}>
          <span className="label"><AlertTriangle size={18} /> المهام المتأخرة</span>
          <span className="value" style={{ color: d.counts.overdueTasks ? 'var(--danger-text)' : undefined }}><Ltr>{d.counts.overdueTasks}</Ltr></span>
          <span className="note">تجاوزت موعد استحقاقها</span>
        </button>
        <div className="card stat">
          <span className="label"><Wallet size={18} /> المستحقات المسجلة</span>
          {d.finance ? (
            <>
              <span className="value" style={{ fontSize: 22 }}><Ltr>{fmtAmount(d.finance.remaining)}</Ltr></span>
              <span className="note">المتبقي من الأتعاب الثابتة في {d.finance.contractCount} عقد</span>
            </>
          ) : (
            <>
              <span className="value muted" style={{ fontSize: 18 }}>غير متاح</span>
              <span className="note">لا تملك صلاحية عرض الأتعاب</span>
            </>
          )}
        </div>
      </div>

      {d.needsUpdate.length > 0 && (
        <Card title="جلسات مرّ موعدها ولم تُحدَّث حالتها" sub="حدّث حالة الجلسة ونتيجتها حتى يبقى السجل دقيقًا">
          <ul className="list-plain">
            {d.needsUpdate.map((h) => (
              <li key={h.id} className="row between">
                <span>
                  <When at={h.startsAt} /> — {h.caseTitle} (<Ltr>{h.fileNo}</Ltr>)
                </span>
                <Button size="sm" onClick={() => navigate(`/cases/${h.caseId}?tab=stages&hearing=${h.id}`)}>تحديث</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid c2">
        <Card title="جلسات اليوم" flush>
          {d.todayHearings.length === 0 ? (
            <Empty title="لا توجد جلسات مسجلة اليوم" />
          ) : (
            <ul className="list-plain" style={{ padding: '0 24px' }}>
              {d.todayHearings.map((e) => (
                <li key={e.id} className="row between top">
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      <TimeOf iso={e.startsAt!} /> — {e.caseTitle}
                    </div>
                    <div className="help">
                      {e.clientName} — {e.stageType} {e.location ? `— ${e.location}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    <StatusBadge map={HEARING_STATUSES} value={e.status} />
                    {!e.confirmed && <Badge tone="warning">غير مؤكد</Badge>}
                    <Button size="sm" onClick={() => navigate(`/cases/${e.caseId}?tab=stages&hearing=${e.id}`)}>فتح</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="المهام المتأخرة" flush>
          {d.overdueTasks.length === 0 ? (
            <Empty title="لا توجد مهام متأخرة" />
          ) : (
            <ul className="list-plain" style={{ padding: '0 24px' }}>
              {d.overdueTasks.map((t) => (
                <li key={t.id} className="row between top">
                  <div>
                    <div style={{ fontWeight: 500 }}>{t.title}</div>
                    <div className="help">
                      مستحقة <Ltr>{fmtDate(t.dueDate)}</Ltr> {t.fileNo && <>— ملف <Ltr>{t.fileNo}</Ltr></>} {t.assignee && `— ${t.assignee}`}
                    </div>
                  </div>
                  <div className="row">
                    <Badge tone="danger">متأخرة</Badge>
                    <StatusBadge map={PRIORITIES} value={t.priority} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid c2">
        <Card title="المواعيد القادمة (14 يومًا)" flush actions={<Button size="sm" onClick={() => navigate('/calendar')}>التقويم</Button>}>
          {d.upcoming.length === 0 ? (
            <Empty title="لا توجد مواعيد قادمة مسجلة" />
          ) : (
            <ul className="list-plain" style={{ padding: '0 24px' }}>
              {d.upcoming.slice(0, 15).map((e) => (
                <li key={e.kind + e.id} className="row between top">
                  <div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <Badge tone={EVENT_KIND[e.kind].tone}>{EVENT_KIND[e.kind].label}</Badge>
                      {!e.confirmed && <Badge tone="warning">غير مؤكد</Badge>}
                      <span style={{ fontWeight: 500 }}>{e.kind === 'hearing' ? e.caseTitle : e.title}</span>
                    </div>
                    <div className="help">
                      {e.startsAt ? <When at={e.startsAt} /> : <When at={e.date} dateOnly />} {e.clientName && `— ${e.clientName}`} {e.responsible && `— ${e.responsible}`}
                    </div>
                  </div>
                  {e.caseId && <Button size="sm" variant="ghost" onClick={() => navigate(`/cases/${e.caseId}`)}>الملف</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="مهام مفتوحة" flush actions={<Button size="sm" icon={<ListTodo />} onClick={() => navigate('/tasks')}>كل المهام</Button>}>
          {d.openTasks.length === 0 ? (
            <Empty title="لا توجد مهام مفتوحة" />
          ) : (
            <ul className="list-plain" style={{ padding: '0 24px' }}>
              {d.openTasks.map((t) => (
                <li key={t.id} className="row between top">
                  <div>
                    <div style={{ fontWeight: 500 }}>{t.title}</div>
                    <div className="help">
                      {t.dueDate ? <>مستحقة <Ltr>{fmtDate(t.dueDate)}</Ltr></> : 'بدون موعد'} {t.fileNo && <>— ملف <Ltr>{t.fileNo}</Ltr></>} {t.assignee && `— ${t.assignee}`}
                    </div>
                  </div>
                  <StatusBadge map={TASK_STATUSES} value={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
