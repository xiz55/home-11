import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Printer, History } from 'lucide-react';
import { Alert, Button, Card, Collapsible, DataTable, ErrorBox, Loading, Modal, SaveState, StatusBadge, Badge, confirmAsync, toast, Ltr } from '../components/ui';
import { api, ApiError, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAutosave } from '../lib/autosave';
import { When } from '../lib/display';
import { EVIDENCE_KINDS, EVIDENCE_RELIABILITY } from '../../shared/constants';
import { ANALYSIS_SECTIONS, type AnalysisSectionKey } from '../../shared/schemas';
import { fmtDate } from '../../shared/dates';
import { EvidenceForm } from '../forms/litigation';
import { useSession } from '../lib/session';
import type { MethodOutput } from '../../main/ipc/registry';

type Evidence = MethodOutput<'analysis.get'>['evidence'][number];

export function AnalysisPage() {
  const { id } = useParams<{ id: string }>();
  const caseQ = useApi(() => api('cases.get', { id: id! }), [id]);
  const q = useApi(() => api('analysis.get', { caseId: id! }), [id]);
  const [texts, setTexts] = useState<Record<string, string> | null>(null);
  const revision = useRef(0);
  const [evForm, setEvForm] = useState<null | { initial?: Evidence }>(null);
  const [history, setHistory] = useState(false);
  const { can } = useSession();
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (q.data && loadedFor.current !== id) {
      loadedFor.current = id!;
      revision.current = q.data.revision;
      setTexts(Object.fromEntries(q.data.sections.map((s) => [s.key, s.text])));
    }
  }, [q.data, id]);
  const auto = useAutosave<AnalysisSectionKey>(async (key, text) => {
    try {
      const r = await api('analysis.saveSection', { caseId: id!, key, text, baseRevision: revision.current });
      revision.current = r.revision;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') throw new Error(e.message);
      throw e;
    }
  });
  if ((q.loading && !q.data) || caseQ.loading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (caseQ.error) return <ErrorBox error={caseQ.error} />;
  const c = caseQ.data!.case;
  const a = q.data!;
  const writable = !c.archived;
  return (
    <div>
      <nav className="breadcrumb">
        <Link to="/clients">العملاء</Link> / <Link to={`/clients/${c.clientId}`}>{caseQ.data!.client.name}</Link> / <Link to={`/cases/${c.id}?tab=analysis`}>{c.title}</Link> / <span>التحليل</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>تحليل القضية</h1>
          <div className="sub">تحليل يدوي يكتبه المحامي — لا يولّد البرنامج آراء أو نصوص أنظمة أو نسب نجاح</div>
        </div>
        <div className="row wrap">
          <SaveState state={auto.status} at={auto.status === 'saved' ? auto.savedAt : a.updatedAt} />
          {auto.status === 'error' && <Button size="sm" onClick={() => void auto.flush()}>إعادة محاولة الحفظ</Button>}
          <Button icon={<History />} onClick={() => setHistory(true)}>سجل التعديلات</Button>
          {can('reports.export') && <Link className="btn" to={`/reports?type=case&caseId=${c.id}&analysis=1`}><Printer size={18} /> طباعة ضمن تقرير القضية</Link>}
        </div>
      </div>
      {auto.error && <Alert tone="danger">{auto.error} — نصك ما زال في الصفحة ولم يُفقد؛ انسخه قبل إعادة التحميل.</Alert>}
      {!writable && <Alert tone="neutral">الملف مؤرشف: التحليل للاطلاع فقط.</Alert>}
      <div className="stack g2" style={{ marginTop: 12 }}>
        {texts &&
          ANALYSIS_SECTIONS.map((s, i) => {
            const meta = a.sections.find((x) => x.key === s.key)!;
            return (
              <Collapsible
                key={s.key}
                defaultOpen={i < 2 || !!texts[s.key]}
                title={<strong>{s.label}</strong>}
                right={texts[s.key]?.trim() ? <Badge tone="success">مكتوب</Badge> : <Badge>فارغ</Badge>}
              >
                <textarea
                  className="textarea"
                  style={{ minHeight: 140, fontSize: 15.5 }}
                  value={texts[s.key] ?? ''}
                  readOnly={!writable}
                  aria-label={s.label}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTexts((t) => ({ ...t!, [s.key]: v }));
                    auto.change(s.key, v);
                  }}
                  onBlur={() => void auto.flush()}
                />
                {meta.updatedAt && (
                  <div className="help" style={{ marginTop: 4 }}>
                    آخر تعديل: {meta.updatedByName} — <When at={meta.updatedAt} />
                  </div>
                )}
              </Collapsible>
            );
          })}
      </div>
      <div style={{ height: 24 }} />
      <Card
        title="جدول الأدلة"
        sub="اربط كل واقعة أو طلب بالمستند المؤيد، وميّز بين المؤكد بمستند وإفادة العميل وما يحتاج تحققًا"
        flush
        actions={writable ? <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEvForm({})}>إضافة بند</Button> : undefined}
      >
        <DataTable
          rows={a.evidence}
          rowKey={(r) => r.id}
          empty="لا توجد بنود في جدول الأدلة"
          columns={[
            { key: 'k', header: 'النوع', render: (r) => EVIDENCE_KINDS[r.kind].label },
            { key: 'd', header: 'التاريخ', sortValue: (r) => r.factDate ?? '', render: (r) => (r.factDate ? <Ltr>{fmtDate(r.factDate)}</Ltr> : '—') },
            { key: 's', header: 'الواقعة / الطلب', render: (r) => <div className="long-text">{r.statement}</div> },
            { key: 'r', header: 'درجة الثبوت', sortValue: (r) => r.reliability, render: (r) => <StatusBadge map={EVIDENCE_RELIABILITY} value={r.reliability} /> },
            { key: 'doc', header: 'المستند المؤيد', render: (r) => (r.documentTitle ? <span>{r.documentTitle}{r.locationRef && <span className="help"> ({r.locationRef})</span>}</span> : <span className="muted">—</span>) },
            { key: 'n', header: 'ملاحظات', render: (r) => <div className="help">{r.notes}</div> },
            {
              key: 'a',
              header: '',
              className: 'actions',
              render: (r) =>
                writable ? (
                  <div className="row">
                    <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} aria-label="تعديل" onClick={() => setEvForm({ initial: r })} />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Trash2 />}
                      aria-label="حذف"
                      onClick={async () => {
                        if (!(await confirmAsync({ title: 'حذف بند', message: 'حذف هذا البند من جدول الأدلة؟', confirmLabel: 'حذف', danger: true }))) return;
                        try {
                          await api('evidence.remove', { id: r.id });
                          invalidate();
                        } catch (e) {
                          toast.error(e);
                        }
                      }}
                    />
                  </div>
                ) : null,
            },
          ]}
        />
      </Card>
      {evForm && <EvidenceForm caseId={c.id} initial={evForm.initial} onClose={() => setEvForm(null)} />}
      {history && <AnalysisHistory caseId={c.id} onClose={() => setHistory(false)} />}
    </div>
  );
}

function AnalysisHistory({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const q = useApi(() => api('analysis.history', { caseId }), [caseId]);
  return (
    <Modal title="سجل تعديلات التحليل" onClose={onClose}>
      {q.loading ? (
        <Loading />
      ) : (q.data ?? []).length === 0 ? (
        <div className="muted">لا توجد تعديلات بعد</div>
      ) : (
        <ul className="list-plain">
          {q.data!.map((r) => (
            <li key={r.id}>
              {r.sectionLabel} — {r.byName} — <When at={r.savedAt} /> <span className="help">({r.oldLength} ← {r.newLength} حرفًا)</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
