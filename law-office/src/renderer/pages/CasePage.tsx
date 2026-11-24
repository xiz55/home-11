import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  CalendarPlus,
  ClipboardPlus,
  FilePlus2,
  Gavel,
  ListChecks,
  Lock,
  Pencil,
  Plus,
  ScrollText,
  Trash2,
  Unlock,
  ChevronDown,
  ChevronUp,
  FileText,
  ArrowLeftRight,
  BookOpen,
  StickyNote,
} from 'lucide-react';
import { Alert, Badge, Button, Card, DataTable, Dropdown, Empty, ErrorBox, KV, Loading, Modal, StatusBadge, Tabs, confirmAsync, toast, Ltr } from '../components/ui';
import { api, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { LastActionCell, NextEventCell, When } from '../lib/display';
import {
  CASE_STATUSES,
  CONTRACT_KINDS,
  CONTRACT_STATUSES,
  DEADLINE_STATUSES,
  EVIDENCE_RELIABILITY,
  FOLLOW_STATUSES,
  HEARING_STATUSES,
  JUDGMENT_FOLLOW,
  MEMO_STATUSES,
  MEMO_TYPES,
  POA_STATUSES,
  PRIORITIES,
  RELATED_WORK_KINDS,
  RELATED_WORK_STATUSES,
  STAGE_STATUSES,
  TASK_STATUSES,
  DOC_CATEGORIES,
} from '../../shared/constants';
import { ANALYSIS_SECTIONS } from '../../shared/schemas';
import { fmtAmount } from '../../shared/money';
import { addDays, fmtDate, fmtDateTime, todayRiyadh } from '../../shared/dates';
import { CaseForm, PartyForm, StageForm } from '../forms/clientCase';
import { CloseCaseForm, DeadlineForm, HearingForm, HearingRequestForm, JudgmentForm, MemoCreateForm, ReasonForm, RelatedWorkForm, RequestToTaskForm } from '../forms/litigation';
import { DocumentAttachForm, type DocDefaults } from '../forms/docs';
import { ContractForm, ExpenseForm, NoteForm, PaymentForm, PoaForm, TaskForm } from '../forms/finance';
import { DocumentBrowser, DocumentPanel } from '../components/viewer';
import type { MethodOutput } from '../../main/ipc/registry';

type CaseData = MethodOutput<'cases.get'>;
type Hearing = MethodOutput<'hearings.list'>[number];
type Judgment = MethodOutput<'judgments.list'>[number];
type Tab = 'summary' | 'analysis' | 'stages' | 'docs' | 'tasks' | 'finance' | 'timeline';

type ModalState =
  | null
  | { k: 'edit' }
  | { k: 'party'; party?: CaseData['parties'][number] }
  | { k: 'stage'; stage?: CaseData['stages'][number] }
  | { k: 'hearing'; hearing?: Hearing; stageId?: string; previousHearingId?: string }
  | { k: 'judgment'; judgment?: Judgment }
  | { k: 'deadline'; deadline?: MethodOutput<'deadlines.list'>[number]; judgmentId?: string }
  | { k: 'memo' }
  | { k: 'doc'; defaults: DocDefaults }
  | { k: 'task'; hearingId?: string }
  | { k: 'close' }
  | { k: 'reopen' }
  | { k: 'archive' }
  | { k: 'related'; work?: CaseData['relatedWorks'][number] }
  | { k: 'note' }
  | { k: 'contract' }
  | { k: 'poa' }
  | { k: 'payment' }
  | { k: 'expense' };

export function CasePage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'summary';
  const hearingParam = sp.get('hearing');
  const q = useApi(() => api('cases.get', { id: id! }), [id]);
  const hearings = useApi(() => api('hearings.list', { caseId: id! }), [id]);
  const judgments = useApi(() => api('judgments.list', { caseId: id! }), [id]);
  const [modal, setModal] = useState<ModalState>(null);
  const [openHearing, setOpenHearing] = useState<string | null>(hearingParam);
  const navigate = useNavigate();
  useEffect(() => setOpenHearing(hearingParam), [hearingParam]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  const c = d.case;
  const H = hearings.data ?? [];
  const J = judgments.data ?? [];
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  const writable = !c.archived;
  const add = (k: 'hearing' | 'memo' | 'minutes' | 'judgment' | 'task' | 'doc') => {
    if (!writable) return toast.error('الملف مؤرشف. ألغِ الأرشفة أولًا.');
    if (k === 'hearing') setModal({ k: 'hearing' });
    else if (k === 'memo') setModal({ k: 'memo' });
    else if (k === 'judgment') setModal({ k: 'judgment' });
    else if (k === 'task') setModal({ k: 'task' });
    else if (k === 'minutes') setModal({ k: 'doc', defaults: { clientId: c.clientId, caseId: c.id, category: 'minutes', title: 'ضبط جلسة' } });
    else setModal({ k: 'doc', defaults: { clientId: c.clientId, caseId: c.id } });
  };
  return (
    <div>
      <nav className="breadcrumb" aria-label="مسار التنقل">
        <Link to="/clients">العملاء</Link> / <Link to={`/clients/${c.clientId}`}>{d.client.name}</Link> / <span>{c.title}</span>
      </nav>
      <section className="card file-head">
        <div className="row between top wrap">
          <div className="stack" style={{ gap: 6 }}>
            <div className="row wrap">
              <h1>{c.title}</h1>
              <span className="muted">ملف <Ltr>{c.fileNo}</Ltr></span>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {c.caseType && <Badge tone="outline">{c.caseType}</Badge>}
              <StatusBadge map={CASE_STATUSES} value={c.status} />
              {c.archived && <Badge tone="neutral">مؤرشفة</Badge>}
              <StatusBadge map={FOLLOW_STATUSES} value={c.followStatus} />
              <StatusBadge map={PRIORITIES} value={c.priority} />
            </div>
          </div>
          <div className="btn-group">
            <Dropdown
              trigger={(_o, toggle) => (
                <Button variant="primary" icon={<Plus />} onClick={toggle} disabled={!writable}>
                  إضافة
                </Button>
              )}
            >
              {(close) => (
                <>
                  <button onClick={() => { close(); add('hearing'); }}><CalendarPlus /> جلسة</button>
                  <button onClick={() => { close(); add('memo'); }}><ScrollText /> مذكرة</button>
                  <button onClick={() => { close(); add('minutes'); }}><ClipboardPlus /> ضبط</button>
                  <button onClick={() => { close(); add('judgment'); }}><Gavel /> حكم</button>
                  <button onClick={() => { close(); add('task'); }}><ListChecks /> مهمة</button>
                  <button onClick={() => { close(); add('doc'); }}><FilePlus2 /> مستند</button>
                </>
              )}
            </Dropdown>
            {writable && <Button icon={<Pencil />} onClick={() => setModal({ k: 'edit' })}>تعديل</Button>}
            {d.permissions.canReport && <Button icon={<BarChart3 />} onClick={() => navigate(`/reports?type=case&caseId=${c.id}`)}>تقرير</Button>}
            {d.permissions.canClose && writable && (c.status === 'open' ? <Button icon={<Lock />} onClick={() => setModal({ k: 'close' })}>إقفال</Button> : <Button icon={<Unlock />} onClick={() => setModal({ k: 'reopen' })}>إعادة فتح</Button>)}
            {d.permissions.canArchive && (
              <Button
                variant="ghost"
                icon={c.archived ? <ArchiveRestore /> : <Archive />}
                onClick={async () => {
                  if (c.archived) {
                    try {
                      await api('cases.setArchived', { id: c.id, archived: false });
                      invalidate();
                      toast.success('أُلغيت أرشفة الملف');
                    } catch (e) {
                      toast.error(e);
                    }
                  } else setModal({ k: 'archive' });
                }}
              >
                {c.archived ? 'إلغاء الأرشفة' : 'أرشفة'}
              </Button>
            )}
          </div>
        </div>
        {c.archived && <Alert tone="neutral">الملف مؤرشف: كل التاريخ والمرفقات محفوظة ويمكن الاطلاع عليها. لإضافة أو تعديل بيانات ألغِ الأرشفة.</Alert>}
        <div className="meta-grid">
          <div className="meta">
            <div className="k">المرحلة الحالية</div>
            <div className="v">{d.header.stage ? <>{d.header.stage.stageType}{d.header.stage.officialCaseNo && <> — <Ltr>{d.header.stage.officialCaseNo}</Ltr></>}</> : 'لم تُسجل مرحلة'}</div>
          </div>
          <div className="meta">
            <div className="k">آخر إجراء مسجل</div>
            <div className="v"><LastActionCell a={d.header.lastAction} /></div>
          </div>
          <div className="meta">
            <div className="k">الإجراء التالي</div>
            <div className="v"><NextEventCell ev={d.header.nextEvent} /></div>
          </div>
          <div className="meta">
            <div className="k">المسؤول</div>
            <div className="v">{c.responsibleName ?? 'غير محدد'}</div>
          </div>
        </div>
      </section>
      <div style={{ height: 16 }} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'summary', label: 'الملخص' },
          { key: 'analysis', label: 'التحليل' },
          { key: 'stages', label: 'المراحل والجلسات', count: H.length },
          { key: 'docs', label: 'المستندات والمذكرات', count: d.counts.docs + d.counts.memos },
          { key: 'tasks', label: 'المهام والمواعيد', count: d.counts.tasks_open },
          { key: 'finance', label: 'العقود والوكالات والأتعاب' },
          { key: 'timeline', label: 'السجل الزمني' },
        ]}
      />
      {tab === 'summary' && <SummaryTab d={d} onModal={setModal} writable={writable} />}
      {tab === 'analysis' && <AnalysisOverview caseId={c.id} />}
      {tab === 'stages' && <StagesTab d={d} hearings={H} judgments={J} writable={writable} onModal={setModal} onOpenHearing={setOpenHearing} />}
      {tab === 'docs' && <DocsTab d={d} writable={writable} onModal={setModal} />}
      {tab === 'tasks' && <TasksTab d={d} writable={writable} onModal={setModal} />}
      {tab === 'finance' && <FinanceTab d={d} onModal={setModal} />}
      {tab === 'timeline' && <TimelineTab caseId={c.id} onOpenHearing={setOpenHearing} />}

      {openHearing && <HearingDetail hearingId={openHearing} d={d} hearings={H} writable={writable} onClose={() => { setOpenHearing(null); if (hearingParam) setSp({ tab }, { replace: true }); }} onModal={setModal} />}
      {modal?.k === 'edit' && <CaseForm initial={c} onClose={() => setModal(null)} />}
      {modal?.k === 'party' && <PartyForm caseId={c.id} initial={modal.party} onClose={() => setModal(null)} />}
      {modal?.k === 'stage' && <StageForm caseId={c.id} initial={modal.stage} stages={d.stages} onClose={() => setModal(null)} />}
      {modal?.k === 'hearing' && <HearingForm caseId={c.id} stages={d.stages} hearings={H} initial={modal.hearing} defaultStageId={modal.stageId} previousHearingId={modal.previousHearingId} onClose={() => setModal(null)} />}
      {modal?.k === 'judgment' && <JudgmentForm caseId={c.id} stages={d.stages} hearings={H} initial={modal.judgment} onClose={() => setModal(null)} />}
      {modal?.k === 'deadline' && <DeadlineForm caseId={c.id} judgments={J} initial={modal.deadline} judgmentId={modal.judgmentId} onClose={() => setModal(null)} />}
      {modal?.k === 'memo' && <MemoCreateForm caseId={c.id} stages={d.stages} hearings={H} onClose={() => setModal(null)} onCreated={(mid) => navigate(`/cases/${c.id}/memos/${mid}`)} />}
      {modal?.k === 'doc' && <DocumentAttachForm defaults={modal.defaults} onClose={() => setModal(null)} />}
      {modal?.k === 'task' && <TaskForm defaults={{ caseId: c.id, clientId: c.clientId, hearingId: modal.hearingId }} onClose={() => setModal(null)} />}
      {modal?.k === 'close' && <CloseCaseForm caseId={c.id} canFees={d.permissions.canFees} onClose={() => setModal(null)} />}
      {modal?.k === 'reopen' && <ReasonForm title="إعادة فتح الملف" label="سبب إعادة الفتح" required submitLabel="إعادة الفتح" onClose={() => setModal(null)} onSubmit={(reason) => api('cases.reopen', { id: c.id, reason })} />}
      {modal?.k === 'archive' && <ReasonForm title="أرشفة ملف القضية" label="سبب الأرشفة (اختياري)" submitLabel="أرشفة" onClose={() => setModal(null)} onSubmit={(reason) => api('cases.setArchived', { id: c.id, archived: true, reason: reason || null })} />}
      {modal?.k === 'related' && <RelatedWorkForm caseId={c.id} initial={modal.work} onClose={() => setModal(null)} />}
      {modal?.k === 'note' && <NoteForm clientId={c.clientId} caseId={c.id} onClose={() => setModal(null)} />}
      {modal?.k === 'contract' && <ContractForm clientId={c.clientId} caseId={c.id} forCase={{ fileNo: c.fileNo, title: c.title }} onClose={() => setModal(null)} />}
      {modal?.k === 'poa' && <PoaForm clientId={c.clientId} caseId={c.id} onClose={() => setModal(null)} />}
      {modal?.k === 'payment' && <PaymentForm clientId={c.clientId} caseId={c.id} onClose={() => setModal(null)} />}
      {modal?.k === 'expense' && <ExpenseForm clientId={c.clientId} caseId={c.id} onClose={() => setModal(null)} />}
    </div>
  );
}

function SummaryTab({ d, onModal, writable }: { d: CaseData; onModal: (m: ModalState) => void; writable: boolean }) {
  const c = d.case;
  const notes = useApi(() => api('notes.list', { clientId: c.clientId, caseId: c.id }), [c.id]);
  const removeParty = async (pid: string, name: string) => {
    if (!(await confirmAsync({ title: 'حذف طرف', message: `حذف «${name}» من أطراف القضية؟ سيُسجل ذلك في سجل الأنشطة.`, confirmLabel: 'حذف', danger: true }))) return;
    try {
      await api('parties.remove', { id: pid });
      invalidate();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="grid c2">
      <div className="span-all">
        <CaseFeesCard d={d} onModal={onModal} writable={writable} />
      </div>
      <div className="stack g2">
        <Card title="بيانات الملف">
          <KV
            items={[
              ['رقم الملف الداخلي', <Ltr>{c.fileNo}</Ltr>],
              ['العميل', <Link to={`/clients/${c.clientId}`}>{d.client.name}</Link>],
              ['نوع القضية', c.caseType],
              ['تاريخ فتح الملف', c.openedOn && <Ltr>{fmtDate(c.openedOn)}</Ltr>],
              ['مبلغ المطالبة', c.claimAmount !== null ? <Ltr>{fmtAmount(c.claimAmount)}</Ltr> : null],
              ['الموضوع', c.subject && <div className="long-text">{c.subject}</div>],
              ['الطلبات', c.requests && <div className="long-text">{c.requests}</div>],
              ['الإجراء التالي (يدوي)', c.nextAction && <span>{c.nextAction} {c.nextActionDue && <Ltr>{fmtDate(c.nextActionDue)}</Ltr>}</span>],
              ['ملاحظات', c.notes && <div className="long-text">{c.notes}</div>],
              ...(c.status === 'closed' ? ([['النتيجة المسجلة', <div className="long-text">{c.outcome} <div className="help">أقفله {c.closedByName} — <When at={c.closedAt} /></div></div>]] as [string, ReactNode][]) : []),
            ]}
          />
        </Card>
        <Card title="الأطراف والخصوم" flush actions={writable ? <Button size="sm" icon={<Plus />} onClick={() => onModal({ k: 'party' })}>إضافة طرف</Button> : undefined}>
          <DataTable
            rows={d.parties}
            rowKey={(r) => r.id}
            empty="لم تُسجل أطراف"
            columns={[
              { key: 'name', header: 'الاسم', sortValue: (r) => r.name, render: (r) => <div>{r.name}{r.representative && <div className="sub">ممثله: {r.representative}</div>}</div> },
              { key: 'role', header: 'الصفة', sortValue: (r) => r.role ?? '', render: (r) => r.role ?? '—' },
              { key: 'opp', header: 'خصم', render: (r) => (r.isOpponent ? <Badge tone="warning">خصم</Badge> : <Badge>طرف</Badge>) },
              {
                key: 'act',
                header: '',
                className: 'actions',
                render: (r) =>
                  writable ? (
                    <div className="row">
                      <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="تعديل" onClick={() => onModal({ k: 'party', party: r })} />
                      <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} aria-label="حذف" onClick={() => void removeParty(r.id, r.name)} />
                    </div>
                  ) : null,
              },
            ]}
          />
        </Card>
      </div>
      <div className="stack g2">
        <Card title="ملاحظات القضية" actions={writable ? <Button size="sm" icon={<StickyNote />} onClick={() => onModal({ k: 'note' })}>إضافة ملاحظة</Button> : undefined}>
          {(notes.data ?? []).length === 0 ? (
            <div className="muted">لا توجد ملاحظات</div>
          ) : (
            <ul className="list-plain">
              {notes.data!.map((n) => (
                <li key={n.id}>
                  <div className="long-text">{n.body}</div>
                  <div className="help">{n.byName} — <When at={n.createdAt} /> {n.isInternal ? <Badge tone="warning">داخلية</Badge> : <Badge tone="outline">تظهر في التقارير</Badge>}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="أعمال مرتبطة (مثل ملف تنفيذ)" actions={writable ? <Button size="sm" icon={<Plus />} onClick={() => onModal({ k: 'related' })}>تسجيل</Button> : undefined}>
          {d.relatedWorks.length === 0 ? (
            <div className="muted">لا توجد أعمال مرتبطة. ملف التنفيذ عمل مرتبط عند الحاجة وليس مرحلة إلزامية.</div>
          ) : (
            <ul className="list-plain">
              {d.relatedWorks.map((w) => (
                <li key={w.id} className="row between">
                  <div>
                    <div className="row wrap" style={{ gap: 6 }}><Badge tone="outline">{RELATED_WORK_KINDS[w.kind].label}</Badge>{w.title}<StatusBadge map={RELATED_WORK_STATUSES} value={w.status} /></div>
                    <div className="help">{w.authority} {w.referenceNo && <>— <Ltr>{w.referenceNo}</Ltr></>} {w.openedOn && <>— <Ltr>{fmtDate(w.openedOn)}</Ltr></>}</div>
                  </div>
                  {writable && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="تعديل" onClick={() => onModal({ k: 'related', work: w })} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** جدول مختصر لأتعاب القضية: مبلغ القضية، المقدم، المسدد، المتبقي. */
function CaseFeesCard({ d, onModal, writable }: { d: CaseData; onModal: (m: ModalState) => void; writable: boolean }) {
  const c = d.case;
  const q = useApi(() => (d.permissions.canFees ? api('contracts.list', { caseId: c.id }) : Promise.resolve([])), [c.id, d.permissions.canFees]);
  if (!d.permissions.canFees) {
    return (
      <Card title="أتعاب القضية">
        <div className="muted">المبالغ مخفية — لا تملك صلاحية الاطلاع على الأتعاب.</div>
      </Card>
    );
  }
  const ks = (q.data ?? []).filter((k) => k.feeType !== 'none' && k.totals);
  const own = ks.filter((k) => !k.sharedAcrossCases);
  const shared = ks.filter((k) => k.sharedAcrossCases);
  const total = (f: 'agreed' | 'advance' | 'paid' | 'remaining') => own.reduce((s, k) => s + (k.totals?.[f] ?? 0), 0);
  const pct = ks.filter((k) => k.percentage !== null);
  const canManage = d.permissions.canManageFees && writable;
  return (
    <Card
      title="أتعاب القضية"
      actions={
        canManage ? (
          <>
            {ks.length > 0 && (
              <Button size="sm" variant="primary" icon={<Plus />} onClick={() => onModal({ k: 'payment' })}>
                تسجيل دفعة
              </Button>
            )}
            <Button size="sm" onClick={() => onModal({ k: 'contract' })}>
              {ks.length ? 'عقد / ملحق آخر' : 'تحديد أتعاب القضية'}
            </Button>
          </>
        ) : undefined
      }
    >
      {q.loading && !q.data ? (
        <Loading />
      ) : ks.length === 0 ? (
        <div className="muted">لم تُحدَّد أتعاب لهذه القضية بعد.{canManage && ' اضغط «تحديد أتعاب القضية» لإدخال المبلغ ثم سجّل الدفعات.'}</div>
      ) : (
        <>
          <table className="fee-mini" aria-label="ملخص أتعاب القضية">
            <thead>
              <tr>
                <th>البيان</th>
                <th>مبلغ القضية</th>
                <th>المقدم</th>
                <th>المسدد</th>
                <th>المتبقي</th>
              </tr>
            </thead>
            <tbody>
              {own.map((k) => (
                <tr key={k.id}>
                  <td>{k.title}</td>
                  <td>{fmtAmount(k.totals!.agreed)}</td>
                  <td>{fmtAmount(k.totals!.advance)}</td>
                  <td>{fmtAmount(k.totals!.paid)}</td>
                  <td className="remaining">{fmtAmount(k.totals!.remaining)}</td>
                </tr>
              ))}
              {own.length > 1 && (
                <tr className="total">
                  <td>الإجمالي</td>
                  <td>{fmtAmount(total('agreed'))}</td>
                  <td>{fmtAmount(total('advance'))}</td>
                  <td>{fmtAmount(total('paid'))}</td>
                  <td className="remaining">{fmtAmount(total('remaining'))}</td>
                </tr>
              )}
              {shared.map((k) => (
                <tr key={k.id} className="shared">
                  <td>
                    {k.title}
                    <div className="help">عقد شامل لـ {k.cases.length} قضايا — المبالغ للعقد كاملًا ولا تُجمع لكل قضية</div>
                  </td>
                  <td>{fmtAmount(k.totals!.agreed)}</td>
                  <td>{fmtAmount(k.totals!.advance)}</td>
                  <td>{fmtAmount(k.totals!.paid)}</td>
                  <td className="remaining">{fmtAmount(k.totals!.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="help" style={{ marginTop: 6 }}>المقدم جزء من المسدد. المتبقي = مبلغ القضية − المسدد.</div>
          {pct.map((k) => (
            <div key={k.id} className="help">
              أتعاب نسبية في «{k.title}»: {k.percentage}% — {k.percentageBasis} (غير محتسبة ضمن المبالغ أعلاه)
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function AnalysisOverview({ caseId }: { caseId: string }) {
  const q = useApi(() => api('analysis.get', { caseId }), [caseId]);
  const navigate = useNavigate();
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const a = q.data!;
  const filled = a.sections.filter((s) => s.text.trim());
  return (
    <div className="stack g2">
      <Card
        title="التحليل القانوني اليدوي"
        sub={a.updatedAt ? `آخر تعديل: ${a.updatedByName ?? ''} — ${fmtDateTime(a.updatedAt)}` : 'لم يُكتب تحليل بعد'}
        actions={<Button variant="primary" icon={<BookOpen />} onClick={() => navigate(`/cases/${caseId}/analysis`)}>فتح صفحة التحليل</Button>}
      >
        <Alert tone="neutral">التحليل يكتبه المحامي في حقول منظمة. لا يولّد البرنامج آراء قانونية أو نصوص أنظمة أو نسب نجاح.</Alert>
        <div className="grid c3" style={{ marginTop: 16 }}>
          {ANALYSIS_SECTIONS.map((s) => {
            const v = a.sections.find((x) => x.key === s.key)!;
            return (
              <div key={s.key} className="card card-pad" style={{ padding: 14 }}>
                <div className="row between"><strong style={{ fontSize: 14 }}>{s.label}</strong>{v.text.trim() ? <Badge tone="success">مكتوب</Badge> : <Badge>فارغ</Badge>}</div>
                {v.text.trim() && <div className="help" style={{ marginTop: 6, maxHeight: 64, overflow: 'hidden' }}>{v.text.slice(0, 160)}</div>}
              </div>
            );
          })}
        </div>
        <div className="help" style={{ marginTop: 12 }}>{filled.length} من {ANALYSIS_SECTIONS.length} أقسام مكتوبة — {a.evidence.length} بند في جدول الأدلة</div>
      </Card>
      {a.evidence.length > 0 && (
        <Card title="جدول الأدلة" flush>
          <DataTable
            rows={a.evidence}
            rowKey={(r) => r.id}
            columns={[
              { key: 's', header: 'الواقعة / الطلب', sortValue: (r) => r.statement, render: (r) => <div className="long-text">{r.statement}</div> },
              { key: 'r', header: 'درجة الثبوت', sortValue: (r) => r.reliability, render: (r) => <StatusBadge map={EVIDENCE_RELIABILITY} value={r.reliability} /> },
              { key: 'd', header: 'المستند المؤيد', sortValue: (r) => r.documentTitle ?? '', render: (r) => r.documentTitle ?? '—' },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

function StagesTab({ d, hearings, judgments, writable, onModal, onOpenHearing }: { d: CaseData; hearings: Hearing[]; judgments: Judgment[]; writable: boolean; onModal: (m: ModalState) => void; onOpenHearing: (id: string) => void }) {
  const deadlines = useApi(() => api('deadlines.list', { caseId: d.case.id }), [d.case.id]);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(d.stages.map((s, i) => [s.id, s.status === 'ongoing' || i === d.stages.length - 1])));
  const removeStage = async (sid: string) => {
    if (!(await confirmAsync({ title: 'حذف مرحلة', message: 'تُحذف المرحلة فقط إذا كانت فارغة تمامًا. هل تريد المتابعة؟', confirmLabel: 'حذف', danger: true }))) return;
    try {
      await api('stages.remove', { id: sid });
      invalidate();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="stack g2">
      {writable && (
        <div className="btn-group">
          <Button variant="primary" icon={<Plus />} onClick={() => onModal({ k: 'stage' })}>{d.stages.length ? 'إضافة مرحلة (مثل الاستئناف)' : 'إضافة المرحلة الأولى'}</Button>
          <Button icon={<CalendarPlus />} onClick={() => onModal({ k: 'hearing' })} disabled={!d.stages.length}>إضافة جلسة</Button>
          <Button icon={<Gavel />} onClick={() => onModal({ k: 'judgment' })} disabled={!d.stages.length}>إضافة حكم</Button>
          <Button icon={<Plus />} onClick={() => onModal({ k: 'deadline' })}>موعد إجرائي</Button>
        </div>
      )}
      {d.stages.length === 0 && <Card><Empty title="لم تُسجل مراحل تقاضٍ">سجّل المرحلة الفعلية فقط (مثل الدرجة الأولى). لا يفترض البرنامج مرور القضية بكل المراحل.</Empty></Card>}
      {d.stages.map((s) => {
        const sh = hearings.filter((h) => h.stageId === s.id);
        const sj = judgments.filter((j) => j.stageId === s.id);
        const prev = d.stages.find((x) => x.id === s.previousStageId);
        const isOpen = open[s.id];
        return (
          <div key={s.id} className="stage">
            <div className="stage-head" onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} role="button" aria-expanded={isOpen} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
              {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              <div className="grow">
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong>{s.stageType}</strong>
                  <StatusBadge map={STAGE_STATUSES} value={s.status} />
                  {s.officialCaseNo && <span className="help">رقم القضية: <Ltr>{s.officialCaseNo}</Ltr></span>}
                  {prev && <Badge tone="outline"><ArrowLeftRight size={12} /> بعد {prev.stageType}</Badge>}
                </div>
                <div className="help">{[s.courtType, s.courtName, s.circuit && `الدائرة: ${s.circuit}`].filter(Boolean).join(' — ') || 'لم تُسجل المحكمة'} {s.startedOn && <>— بدأت <Ltr>{fmtDate(s.startedOn)}</Ltr></>} {s.endedOn && <>— انتهت <Ltr>{fmtDate(s.endedOn)}</Ltr></>}</div>
              </div>
              <span className="help">{sh.length} جلسة — {sj.length} حكم</span>
            </div>
            {isOpen && (
              <div className="stage-body stack g2">
                {writable && (
                  <div className="btn-group">
                    <Button size="sm" icon={<CalendarPlus />} onClick={() => onModal({ k: 'hearing', stageId: s.id })}>جلسة في هذه المرحلة</Button>
                    <Button size="sm" icon={<Pencil />} onClick={() => onModal({ k: 'stage', stage: s })}>تعديل المرحلة</Button>
                    {sh.length === 0 && sj.length === 0 && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => void removeStage(s.id)}>حذف</Button>}
                  </div>
                )}
                <div>
                  <h3 style={{ marginBottom: 8 }}>الجلسات</h3>
                  <DataTable
                    rows={sh}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => onOpenHearing(r.id)}
                    empty="لا توجد جلسات في هذه المرحلة"
                    columns={[
                      { key: 'w', header: 'الموعد', sortValue: (r) => r.startsAt, render: (r) => <div><When at={r.startsAt} />{!r.confirmed && <div><Badge tone="warning">غير مؤكد</Badge></div>}</div> },
                      { key: 's', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <StatusBadge map={HEARING_STATUSES} value={r.status} /> },
                      { key: 'o', header: 'النتيجة / الملخص', render: (r) => <div className="help" style={{ maxWidth: 380 }}>{r.outcome ?? (r.summary ? r.summary.slice(0, 120) : '—')}</div> },
                      { key: 'm', header: 'الضبط', render: (r) => (r.minutesCount ? <Badge tone="success">مرفق ({r.minutesCount})</Badge> : <Badge>غير مرفق</Badge>) },
                      { key: 'rq', header: 'الطلبات', render: (r) => <Ltr>{r.requestCount}</Ltr> },
                    ]}
                  />
                </div>
                <div>
                  <h3 style={{ marginBottom: 8 }}>الأحكام والقرارات</h3>
                  {sj.length === 0 ? (
                    <div className="muted">لا توجد أحكام مسجلة في هذه المرحلة</div>
                  ) : (
                    sj.map((j) => (
                      <div key={j.id} className="card card-pad" style={{ padding: 14, marginBottom: 8 }}>
                        <div className="row between wrap">
                          <div className="row wrap" style={{ gap: 6 }}>
                            <strong>حكم {j.judgmentNo && <Ltr>{j.judgmentNo}</Ltr>}</strong>
                            {j.judgmentDate && <Ltr>{fmtDate(j.judgmentDate)}</Ltr>}
                            <StatusBadge map={JUDGMENT_FOLLOW} value={j.followStatus} />
                          </div>
                          {writable && (
                            <div className="btn-group">
                              <Button size="sm" onClick={() => onModal({ k: 'doc', defaults: { clientId: d.case.clientId, caseId: d.case.id, judgmentId: j.id, stageId: j.stageId, category: 'judgment', title: 'نسخة الحكم' } })}>إرفاق النسخة الرقمية</Button>
                              <Button size="sm" onClick={() => onModal({ k: 'deadline', judgmentId: j.id })}>موعد إجرائي</Button>
                              <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="تعديل الحكم" onClick={() => onModal({ k: 'judgment', judgment: j })} />
                            </div>
                          )}
                        </div>
                        <div className="long-text" style={{ marginTop: 6 }}>{j.summary}</div>
                        {(deadlines.data ?? []).filter((x) => x.judgmentId === j.id).map((x) => (
                          <div key={x.id} className="help">• {x.title}: <Ltr>{fmtDate(x.dueDate)}</Ltr> — <StatusBadge map={DEADLINE_STATUSES} value={x.status} /> — المصدر: {x.source}</div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {(deadlines.data ?? []).length > 0 && (
        <Card title="المواعيد الإجرائية المسجلة يدويًا" flush>
          <DataTable
            rows={deadlines.data!}
            rowKey={(r) => r.id}
            onRowClick={writable ? (r) => onModal({ k: 'deadline', deadline: r }) : undefined}
            columns={[
              { key: 't', header: 'الإجراء', sortValue: (r) => r.title },
              { key: 'd', header: 'الموعد', sortValue: (r) => r.dueDate, render: (r) => <Ltr>{fmtDate(r.dueDate)}</Ltr> },
              { key: 's', header: 'الحالة', render: (r) => <StatusBadge map={DEADLINE_STATUSES} value={r.status} /> },
              { key: 'src', header: 'المصدر', sortValue: (r) => r.source },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

function HearingDetail({ hearingId, d, hearings, writable, onClose, onModal }: { hearingId: string; d: CaseData; hearings: Hearing[]; writable: boolean; onClose: () => void; onModal: (m: ModalState) => void }) {
  const q = useApi(() => api('hearings.get', { id: hearingId }), [hearingId]);
  const docs = useApi(() => api('documents.list', { hearingId }), [hearingId]);
  const [reqForm, setReqForm] = useState<null | { id?: string; text?: string; requestedBy?: string | null; dueDate?: string | null }>(null);
  const [toTask, setToTask] = useState<null | { id: string; text: string; dueDate: string | null }>(null);
  const [docSel, setDocSel] = useState<string | null>(null);
  const h = q.data?.hearing;
  const listed = hearings.find((x) => x.id === hearingId);
  return (
    <Modal title="تفاصيل الجلسة" size="wide" onClose={onClose}>
      {q.loading && !q.data ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        h && (
          <div className="stack g2">
            <div className="row between wrap">
              <div className="row wrap">
                <strong style={{ fontSize: 17 }}><When at={h.startsAt} /></strong>
                <StatusBadge map={HEARING_STATUSES} value={h.status} />
                {!h.confirmed && <Badge tone="warning">موعد غير مؤكد</Badge>}
                <span className="help">{q.data!.stage?.stageType} {q.data!.stage?.officialCaseNo && <>— <Ltr>{q.data!.stage.officialCaseNo}</Ltr></>}</span>
              </div>
              {writable && (
                <div className="btn-group">
                  <Button size="sm" icon={<Pencil />} onClick={() => listed && onModal({ k: 'hearing', hearing: listed })}>تعديل / تحديث النتيجة</Button>
                  <Button size="sm" icon={<ClipboardPlus />} onClick={() => onModal({ k: 'doc', defaults: { clientId: d.case.clientId, caseId: d.case.id, hearingId, category: 'minutes', title: `ضبط جلسة ${fmtDate(h.date)}` } })}>إرفاق ضبط</Button>
                  <Button size="sm" icon={<CalendarPlus />} onClick={() => onModal({ k: 'hearing', stageId: h.stageId, previousHearingId: h.id })}>الجلسة التالية</Button>
                </div>
              )}
            </div>
            <KV
              items={[
                ['المكان', h.location],
                ['رابط الحضور', h.attendanceLink && <Ltr>{h.attendanceLink}</Ltr>],
                ['الحاضر عن المكتب', h.attendee],
                ['التاريخ الهجري', h.hijriText && `${h.hijriText}${h.hijriSource ? ` (المصدر: ${h.hijriSource})` : ''}`],
                ['النتيجة', h.outcome],
                ['الملخص', h.summary && <div className="long-text">{h.summary}</div>],
                ['ما التزم به المكتب', h.officeCommitments && <div className="long-text">{h.officeCommitments}</div>],
                ['الجلسة السابقة', q.data!.previous && <When at={q.data!.previous.startsAt} />],
                ['الموعد اللاحق', q.data!.next ? <span><When at={q.data!.next.startsAt} /> — {HEARING_STATUSES[q.data!.next.status as keyof typeof HEARING_STATUSES]?.label}</span> : null],
              ]}
            />
            <Card title="الطلبات التي وردت في الجلسة" flush actions={writable ? <Button size="sm" icon={<Plus />} onClick={() => setReqForm({})}>تسجيل طلب</Button> : undefined}>
              <DataTable
                rows={q.data!.requests}
                rowKey={(r) => r.id}
                empty="لم تُسجل طلبات"
                columns={[
                  { key: 't', header: 'الطلب', render: (r) => <div className="long-text">{r.text}</div> },
                  { key: 'b', header: 'من', render: (r) => r.requestedBy ?? '—' },
                  { key: 'd', header: 'المهلة', render: (r) => (r.dueDate ? <Ltr>{fmtDate(r.dueDate)}</Ltr> : '—') },
                  { key: 'task', header: 'المهمة', render: (r) => (r.taskId ? <span><StatusBadge map={TASK_STATUSES} value={r.taskStatus} /> <span className="help">{r.taskTitle}</span></span> : writable ? <Button size="sm" icon={<ListChecks />} onClick={() => setToTask({ id: r.id, text: r.text, dueDate: r.dueDate })}>تحويل إلى مهمة</Button> : '—') },
                  {
                    key: 'a',
                    header: '',
                    className: 'actions',
                    render: (r) =>
                      writable && !r.taskId ? (
                        <div className="row">
                          <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="تعديل" onClick={() => setReqForm(r)} />
                          <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} aria-label="حذف" onClick={async () => { try { await api('hearings.removeRequest', { id: r.id }); invalidate(); } catch (e) { toast.error(e); } }} />
                        </div>
                      ) : null,
                  },
                ]}
              />
            </Card>
            <Card title="المستندات المرتبطة (الضبط وغيره)" flush>
              {(docs.data ?? []).length === 0 ? (
                <Empty title="لم يُرفق ضبط لهذه الجلسة" icon={<FileText />} />
              ) : (
                <DocumentBrowser docs={docs.data!} selected={docSel} onSelect={setDocSel} />
              )}
            </Card>
            {q.data!.changes.length > 0 && (
              <Card title="أثر التعديلات على الجلسة">
                <ul className="list-plain">
                  {q.data!.changes.map((ch) => (
                    <li key={ch.id}>
                      {ch.field === 'starts_at' ? (
                        <span>تعديل الموعد من <When at={ch.oldValue} /> إلى <When at={ch.newValue} /></span>
                      ) : ch.field === 'status' ? (
                        <span>تغيير الحالة من {HEARING_STATUSES[ch.oldValue as keyof typeof HEARING_STATUSES]?.label} إلى {HEARING_STATUSES[ch.newValue as keyof typeof HEARING_STATUSES]?.label}</span>
                      ) : (
                        <span>تعديل {ch.field === 'location' ? 'المكان' : 'تأكيد الموعد'}: {ch.oldValue ?? '—'} ← {ch.newValue ?? '—'}</span>
                      )}
                      <div className="help">{ch.by} — <When at={ch.changedAt} /> {ch.reason && `— السبب: ${ch.reason}`}</div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {reqForm && <HearingRequestForm hearingId={hearingId} initial={reqForm.id ? (reqForm as never) : undefined} onClose={() => setReqForm(null)} />}
            {toTask && <RequestToTaskForm request={toTask} onClose={() => setToTask(null)} />}
          </div>
        )
      )}
    </Modal>
  );
}

function DocsTab({ d, writable, onModal }: { d: CaseData; writable: boolean; onModal: (m: ModalState) => void }) {
  const memos = useApi(() => api('memos.list', { caseId: d.case.id }), [d.case.id]);
  const docs = useApi(() => api('documents.list', { caseId: d.case.id, archived: 'all' }), [d.case.id]);
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();
  const list = (docs.data ?? []).filter((x) => (showArchived || !x.archivedAt) && (!cat || x.category === cat));
  return (
    <div className="stack g2">
      <Card title="المذكرات" flush actions={writable ? <Button size="sm" variant="primary" icon={<ScrollText />} onClick={() => onModal({ k: 'memo' })}>مذكرة جديدة</Button> : undefined}>
        <DataTable
          rows={memos.data ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/cases/${d.case.id}/memos/${r.id}`)}
          empty="لا توجد مذكرات"
          columns={[
            { key: 't', header: 'العنوان', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div><div className="sub">{r.bodyLength ? `${r.bodyLength} حرفًا مكتوبًا` : 'لا يوجد نص مكتوب'}</div></div> },
            { key: 'ty', header: 'النوع', render: (r) => MEMO_TYPES[r.memoType].label },
            { key: 'st', header: 'الحالة', sortValue: (r) => r.status, render: (r) => <StatusBadge map={MEMO_STATUSES} value={r.status} /> },
            { key: 'sub', header: 'التقديم', sortValue: (r) => r.lastSubmittedOn ?? '', render: (r) => (r.lastSubmittedOn ? <span>قُدمت <Ltr>{fmtDate(r.lastSubmittedOn)}</Ltr></span> : <span className="muted">لم يُسجل تقديم</span>) },
            { key: 'u', header: 'آخر تعديل', sortValue: (r) => r.updatedAt, render: (r) => <div className="help"><When at={r.updatedAt} /> — {r.updatedByName}</div> },
          ]}
        />
      </Card>
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="تصنيف المستندات">
          <option value="">كل التصنيفات</option>
          {Object.entries(DOC_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> إظهار المؤرشفة</label>
        <span className="grow" />
        {writable && <Button variant="primary" icon={<FilePlus2 />} onClick={() => onModal({ k: 'doc', defaults: { clientId: d.case.clientId, caseId: d.case.id } })}>إرفاق مستند</Button>}
      </div>
      {docs.loading && !docs.data ? <Loading /> : <DocumentBrowser docs={list} selected={sel} onSelect={setSel} emptyHint="أرفق صحيفة الدعوى والضبوط والأحكام والأدلة. يُحفظ الملف داخل البرنامج." />}
    </div>
  );
}

function TasksTab({ d, writable, onModal }: { d: CaseData; writable: boolean; onModal: (m: ModalState) => void }) {
  const tasks = useApi(() => api('tasks.list', { caseId: d.case.id, status: 'all' }), [d.case.id]);
  const [editTask, setEditTask] = useState<MethodOutput<'tasks.list'>[number] | null>(null);
  const setStatus = async (id: string, status: string) => {
    try {
      await api('tasks.setStatus', { id, status: status as never });
      invalidate();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="stack g2">
      <Card title="المهام" flush actions={writable ? <Button size="sm" variant="primary" icon={<ListChecks />} onClick={() => onModal({ k: 'task' })}>إضافة مهمة</Button> : undefined}>
        <DataTable
          rows={tasks.data ?? []}
          rowKey={(r) => r.id}
          empty="لا توجد مهام"
          onRowClick={writable ? (r) => setEditTask(r) : undefined}
          columns={[
            { key: 't', header: 'المهمة', sortValue: (r) => r.title, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.title}</div>{r.hearingRequestId && <div className="sub">من طلب ورد في جلسة</div>}</div> },
            { key: 'a', header: 'المسؤول', sortValue: (r) => r.assigneeName ?? '', render: (r) => r.assigneeName ?? '—' },
            { key: 'd', header: 'الاستحقاق', sortValue: (r) => r.dueDate ?? 'z', render: (r) => (r.dueDate ? <span><Ltr>{fmtDate(r.dueDate)}</Ltr> {r.overdue && <Badge tone="danger">متأخرة</Badge>}</span> : '—') },
            { key: 'p', header: 'الأولوية', render: (r) => <StatusBadge map={PRIORITIES} value={r.priority} /> },
            {
              key: 's',
              header: 'الحالة',
              render: (r) => (
                <select className="select" style={{ height: 34, width: 'auto' }} value={r.status} onClick={(e) => e.stopPropagation()} onChange={(e) => void setStatus(r.id, e.target.value)} disabled={!writable} aria-label="حالة المهمة">
                  {Object.entries(TASK_STATUSES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              ),
            },
          ]}
        />
      </Card>
      <UpcomingForCase caseId={d.case.id} />
      {editTask && <TaskForm initial={editTask} defaults={{ caseId: d.case.id, clientId: d.case.clientId }} onClose={() => setEditTask(null)} />}
    </div>
  );
}

function UpcomingForCase({ caseId }: { caseId: string }) {
  const today = todayRiyadh();
  const ev = useApi(() => api('calendar.events', { from: today, to: addDays(today, 730), caseId }), [caseId]);
  return (
    <Card title="المواعيد القادمة لهذه القضية" flush>
      <DataTable
        rows={(ev.data ?? []).filter((e) => e.kind !== 'task')}
        rowKey={(r) => r.kind + r.id}
        empty="لا توجد مواعيد قادمة مسجلة"
        columns={[
          { key: 'w', header: 'الموعد', render: (r) => (r.startsAt ? <When at={r.startsAt} /> : <When at={r.date} dateOnly />) },
          { key: 'k', header: 'النوع', render: (r) => (r.kind === 'hearing' ? 'جلسة' : 'موعد إجرائي') },
          { key: 't', header: 'البيان', render: (r) => <span>{r.title} {!r.confirmed && <Badge tone="warning">غير مؤكد</Badge>}</span> },
        ]}
      />
    </Card>
  );
}

function FinanceTab({ d, onModal }: { d: CaseData; onModal: (m: ModalState) => void }) {
  const contracts = useApi(() => api('contracts.list', { caseId: d.case.id }), [d.case.id]);
  const poas = useApi(() => api('poas.list', { caseId: d.case.id }), [d.case.id]);
  const expenses = useApi(() => (d.permissions.canFees ? api('expenses.list', { caseId: d.case.id }) : Promise.resolve([])), [d.case.id]);
  return (
    <div className="stack g2">
      <Card title="العقود المرتبطة بهذه القضية" actions={d.permissions.canManageFees ? <Button size="sm" icon={<Plus />} onClick={() => onModal({ k: 'contract' })}>عقد جديد</Button> : undefined}>
        {(contracts.data ?? []).length === 0 ? (
          <div className="muted">لا توجد عقود مرتبطة. اربط عقدًا قائمًا من صفحة العميل أو أضف عقدًا جديدًا.</div>
        ) : (
          <ul className="list-plain">
            {contracts.data!.map((k) => (
              <li key={k.id}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong>{k.title}</strong>
                  <Badge tone="outline">{CONTRACT_KINDS[k.kind].label}</Badge>
                  <StatusBadge map={CONTRACT_STATUSES} value={k.status} />
                  {k.sharedAcrossCases && <Badge tone="info">شامل لـ {k.cases.length} قضايا</Badge>}
                </div>
                <div className="help long-text">النطاق: {k.scope}</div>
                {k.totals ? (
                  <div className="help">
                    المتفق عليه <Ltr>{fmtAmount(k.totals.agreed)}</Ltr> — المدفوع <Ltr>{fmtAmount(k.totals.paid)}</Ltr> — المتبقي <Ltr>{fmtAmount(k.totals.remaining)}</Ltr>
                    {k.sharedAcrossCases && ' — المبالغ تخص العقد كاملًا ولا تُجمع لكل قضية'}
                    {k.percentage !== null && <> — نسبية <Ltr>{k.percentage}%</Ltr> ({k.percentageBasis})</>}
                  </div>
                ) : (
                  <div className="help">المبالغ مخفية — لا تملك صلاحية الأتعاب</div>
                )}
              </li>
            ))}
          </ul>
        )}
        {d.permissions.canManageFees && <div style={{ marginTop: 12 }}><Button size="sm" onClick={() => onModal({ k: 'payment' })}>تسجيل دفعة</Button></div>}
      </Card>
      <Card title="الوكالات المشمولة" actions={<Button size="sm" icon={<Plus />} onClick={() => onModal({ k: 'poa' })}>تسجيل وكالة</Button>}>
        {(poas.data ?? []).length === 0 ? (
          <div className="muted">لم تُربط وكالة بهذه القضية. لا يُفترض أن وكالات العميل تشمل كل قضاياه.</div>
        ) : (
          <ul className="list-plain">
            {poas.data!.map((p) => (
              <li key={p.id}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <strong>وكالة {p.poaNo && <Ltr>{p.poaNo}</Ltr>}</strong>
                  <StatusBadge map={POA_STATUSES} value={p.status} />
                  {p.expiresOn && <span className="help">تنتهي <Ltr>{fmtDate(p.expiresOn)}</Ltr></span>}
                </div>
                <div className="help long-text">النطاق: {p.scope}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {d.permissions.canFees && (
        <Card title="مصاريف القضية" flush actions={d.permissions.canManageFees ? <Button size="sm" onClick={() => onModal({ k: 'expense' })}>تسجيل مصروف</Button> : undefined}>
          <DataTable
            rows={expenses.data ?? []}
            rowKey={(r) => r.id}
            empty="لا توجد مصاريف"
            columns={[
              { key: 'd', header: 'التاريخ', sortValue: (r) => r.spentOn, render: (r) => <Ltr>{fmtDate(r.spentOn)}</Ltr> },
              { key: 't', header: 'البيان', sortValue: (r) => r.title },
              { key: 'a', header: 'المبلغ', sortValue: (r) => r.amount, render: (r) => <Ltr>{fmtAmount(r.amount)}</Ltr> },
              { key: 'r', header: 'الاسترداد', render: (r) => (r.recoverable ? (r.reimbursedOn ? 'سُدد' : 'يُسترد') : 'على المكتب') },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

const TL_KINDS: Record<string, string> = {
  opened: 'فتح الملف',
  stage: 'مراحل',
  hearing: 'جلسات',
  reschedule: 'تعديل مواعيد',
  request: 'طلبات',
  judgment: 'أحكام',
  deadline: 'مواعيد إجرائية',
  memo: 'مذكرات',
  submission: 'تقديم',
  document: 'مستندات',
  task: 'مهام منجزة',
  close: 'إقفال',
  reopen: 'إعادة فتح',
  archive: 'أرشفة',
  related: 'أعمال مرتبطة',
};

function TimelineTab({ caseId, onOpenHearing }: { caseId: string; onOpenHearing: (id: string) => void }) {
  const q = useApi(() => api('cases.timeline', { id: caseId }), [caseId]);
  const [kind, setKind] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const evs = (q.data ?? []).filter((e) => !kind || e.kind === kind);
  return (
    <div className="split">
      <Card title="السجل الزمني" sub="يعرض ما سُجّل فعلًا مع مصدر كل واقعة؛ لا يفترض إجراءات لم تُسجل" actions={
        <select className="select" style={{ width: 'auto', height: 36 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="تصفية السجل">
          <option value="">كل الوقائع</option>
          {Object.entries(TL_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      }>
        {evs.length === 0 ? (
          <Empty title="لا توجد وقائع" />
        ) : (
          <div className="timeline">
            {evs.map((e) => (
              <div key={e.key} className="tl-item">
                <span className={`tl-dot ${['opened', 'document', 'task'].includes(e.kind) ? 'muted' : ''}`} />
                <div className="tl-date"><When at={e.at} dateOnly={e.isDateOnly} /></div>
                <div className="tl-title">
                  {e.refType === 'hearing' ? <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenHearing(e.refId); }}>{e.title}</a> : e.title}
                </div>
                {e.detail && <div className="long-text help" style={{ color: 'var(--text)' }}>{e.detail}</div>}
                <div className="tl-src">المصدر: {e.source}</div>
                {e.documents.length > 0 && (
                  <div className="chip-list" style={{ marginTop: 6 }}>
                    {e.documents.map((x) => (
                      <Button key={x.documentId} size="sm" icon={<FileText />} onClick={() => setDoc(x.documentId)}>
                        {x.title}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <div>{doc ? <DocPanelLazy id={doc} onClose={() => setDoc(null)} /> : <Card><Empty title="افتح المستند الأصلي من أي واقعة" icon={<FileText />} /></Card>}</div>
    </div>
  );
}

function DocPanelLazy({ id, onClose }: { id: string; onClose: () => void }) {
  return <DocumentPanel documentId={id} onClose={onClose} />;
}
