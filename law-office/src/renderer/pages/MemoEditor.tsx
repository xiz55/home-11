import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCheck, Copy, FilePlus2, Send, Undo2, Eye } from 'lucide-react';
import { Alert, Badge, Button, Card, ErrorBox, Loading, Modal, SaveState, Select, StatusBadge, TextInput, toast, Ltr } from '../components/ui';
import { api, ApiError, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAutosave } from '../lib/autosave';
import { When } from '../lib/display';
import { MEMO_STATUSES, MEMO_TYPES } from '../../shared/constants';
import { fmtDate, fmtDateTime } from '../../shared/dates';
import { SubmissionForm } from '../forms/litigation';
import { DocumentAttachForm } from '../forms/docs';
import { DocumentBrowser } from '../components/viewer';
import { optsFrom } from '../forms/common';

export function MemoEditorPage() {
  const { id, memoId } = useParams<{ id: string; memoId: string }>();
  const navigate = useNavigate();
  const q = useApi(() => api('memos.get', { id: memoId! }), [memoId]);
  const caseQ = useApi(() => api('cases.get', { id: id! }), [id]);
  const hearings = useApi(() => api('hearings.list', { caseId: id! }), [id]);
  const docs = useApi(() => api('documents.list', { memoId: memoId! }), [memoId]);
  const [form, setForm] = useState<{ title: string; memoType: string; stageId: string; hearingId: string; body: string } | null>(null);
  const baseUpdatedAt = useRef<string | null>(null);
  const [submit, setSubmit] = useState(false);
  const [attach, setAttach] = useState(false);
  const [rev, setRev] = useState<string | null>(null);
  const [docSel, setDocSel] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (q.data && loaded.current !== memoId) {
      loaded.current = memoId!;
      const m = q.data.memo;
      baseUpdatedAt.current = m.updatedAt;
      setForm({ title: m.title, memoType: m.memoType, stageId: m.stageId ?? '', hearingId: m.hearingId ?? '', body: m.body ?? '' });
    } else if (q.data && baseUpdatedAt.current && q.data.memo.updatedAt > baseUpdatedAt.current) {
      baseUpdatedAt.current = q.data.memo.updatedAt;
    }
  }, [q.data, memoId]);
  const formRef = useRef(form);
  formRef.current = form;
  const auto = useAutosave<'memo'>(async () => {
    const f = formRef.current!;
    try {
      const r = await api('memos.update', { id: memoId!, title: f.title, memoType: f.memoType as never, stageId: f.stageId || null, hearingId: f.hearingId || null, body: f.body, baseUpdatedAt: baseUpdatedAt.current });
      baseUpdatedAt.current = r.updatedAt;
    } catch (e) {
      throw new Error(e instanceof ApiError ? e.message : 'فشل الحفظ');
    }
  }, 2000);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!form || !caseQ.data) return <Loading />;
  const m = q.data!.memo;
  const c = caseQ.data.case;
  const submitted = m.status === 'submitted';
  const writable = !c.archived;
  const update = (p: Partial<typeof form>) => {
    setForm((f) => ({ ...f!, ...p }));
    auto.change('memo', '');
  };
  const setStatus = async (status: 'draft' | 'review' | 'approved') => {
    await auto.flush();
    try {
      await api('memos.setStatus', { id: m.id, status });
      invalidate();
      toast.success(`حالة المذكرة: ${MEMO_STATUSES[status].label}`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div>
      <nav className="breadcrumb">
        <Link to={`/clients/${c.clientId}`}>{caseQ.data.client.name}</Link> / <Link to={`/cases/${c.id}?tab=docs`}>{c.title}</Link> / <span>المذكرات</span>
      </nav>
      <div className="page-head">
        <div>
          <div className="row wrap">
            <h1>{form.title || 'مذكرة'}</h1>
            <StatusBadge map={MEMO_STATUSES} value={m.status} />
          </div>
          <div className="sub">
            أنشأها {m.createdByName} — <When at={m.createdAt} /> — آخر تعديل {m.updatedByName} <When at={m.updatedAt} />
          </div>
        </div>
        <div className="row wrap">
          <SaveState state={auto.status} at={auto.status === 'saved' ? auto.savedAt : null} />
          {auto.status === 'error' && <Button size="sm" onClick={() => void auto.flush()}>إعادة محاولة الحفظ</Button>}
        </div>
      </div>
      {auto.error && <Alert tone="danger">{auto.error}</Alert>}
      {submitted && (
        <Alert tone="success">
          المذكرة مسجلة كمقدمة للجهة. نصها مقفل حفاظًا على ما قُدّم. لإعداد نسخة معدلة أنشئ نسخة مسودة جديدة.
        </Alert>
      )}
      <div className="editor-shell" style={{ marginTop: 12 }}>
        <div className="stack g2">
          <div className="form-grid">
            <TextInput label="العنوان" required value={form.title} onChange={(x) => update({ title: x })} readOnly={!writable} />
            <Select label="النوع" options={optsFrom(MEMO_TYPES)} value={form.memoType} onChange={(x) => update({ memoType: x })} placeholder="—" disabled={!writable} />
            <Select label="المرحلة" options={caseQ.data.stages.map((s) => ({ value: s.id, label: s.stageType }))} value={form.stageId} onChange={(x) => update({ stageId: x, hearingId: '' })} placeholder="غير محددة" disabled={!writable} />
            <Select label="الجلسة" options={(hearings.data ?? []).filter((h) => !form.stageId || h.stageId === form.stageId).map((h) => ({ value: h.id, label: fmtDateTime(h.startsAt) }))} value={form.hearingId} onChange={(x) => update({ hearingId: x })} placeholder="غير مرتبطة" disabled={!writable} />
          </div>
          <div className="field">
            <label htmlFor="memo-body">نص المذكرة</label>
            <textarea id="memo-body" className="editor-area" dir="auto" value={form.body} readOnly={submitted || !writable} onChange={(e) => update({ body: e.target.value })} onBlur={() => void auto.flush()} placeholder="اكتب نص المذكرة هنا. يُحفظ تلقائيًا." />
            <div className="hint">{form.body.length} حرفًا — محرر نصي محلي بسيط. للتنسيق المتقدم استخدم Word وأرفق النسخة.</div>
          </div>
        </div>
        <div className="stack g2">
          <Card title="الحالة والإجراءات">
            <div className="stack">
              {!submitted && writable && (
                <>
                  {m.status !== 'review' && <Button icon={<Eye />} onClick={() => void setStatus('review')}>إرسال للمراجعة</Button>}
                  {m.status !== 'approved' && <Button icon={<CheckCheck />} onClick={() => void setStatus('approved')}>اعتماد داخلي</Button>}
                  {m.status !== 'draft' && <Button icon={<Undo2 />} onClick={() => void setStatus('draft')}>إعادة إلى مسودة</Button>}
                  <Button variant="primary" icon={<Send />} onClick={async () => { await auto.flush(); setSubmit(true); }}>تسجيل التقديم للجهة</Button>
                  <div className="help">الحفظ أو الاعتماد الداخلي لا يجعل المذكرة مقدمة؛ التقديم يُسجل بتاريخه.</div>
                </>
              )}
              {submitted && writable && (
                <>
                  <Button icon={<Send />} onClick={() => setSubmit(true)}>تسجيل تقديم إضافي</Button>
                  <Button
                    icon={<Copy />}
                    onClick={async () => {
                      try {
                        const r = await api('memos.duplicate', { id: m.id });
                        invalidate();
                        navigate(`/cases/${c.id}/memos/${r.id}`);
                      } catch (e) {
                        toast.error(e);
                      }
                    }}
                  >
                    نسخة مسودة جديدة
                  </Button>
                </>
              )}
              {writable && <Button icon={<FilePlus2 />} onClick={() => setAttach(true)}>إرفاق نسخة Word / PDF</Button>}
            </div>
          </Card>
          <Card title="سجل التقديم">
            {q.data!.submissions.length === 0 ? (
              <div className="muted">لم يُسجل تقديم</div>
            ) : (
              <ul className="list-plain">
                {q.data!.submissions.map((s) => (
                  <li key={s.id}>
                    <div>قُدمت <Ltr>{fmtDate(s.submittedOn)}</Ltr> {s.authority && `إلى ${s.authority}`}</div>
                    <div className="help">{s.referenceNo && <>المرجع <Ltr>{s.referenceNo}</Ltr> — </>}{s.proofTitle ? `الإثبات: ${s.proofTitle}` : 'دون إثبات مرفق'} — سجّله {s.byName}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="النسخ المحفوظة عند تغيير الحالة">
            {q.data!.revisions.length === 0 ? (
              <div className="muted">لا توجد</div>
            ) : (
              <ul className="list-plain">
                {q.data!.revisions.map((r) => (
                  <li key={r.id} className="row between">
                    <span className="small">
                      <Badge tone="outline">{MEMO_STATUSES[r.status].label}</Badge> <When at={r.savedAt} /> — {r.byName}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setRev(r.id)}>عرض</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {(docs.data ?? []).length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ marginBottom: 12 }}>الملفات المرفقة بالمذكرة</h2>
          <DocumentBrowser docs={docs.data!} selected={docSel} onSelect={setDocSel} />
        </div>
      )}
      {submit && <SubmissionForm memoId={m.id} caseId={c.id} onClose={() => setSubmit(false)} />}
      {attach && <DocumentAttachForm defaults={{ clientId: c.clientId, caseId: c.id, memoId: m.id, stageId: m.stageId, category: m.memoType === 'reply' ? 'reply' : m.memoType === 'objection' ? 'objection' : m.memoType === 'claim' ? 'claim' : 'memo', title: m.title }} onClose={() => setAttach(false)} />}
      {rev && <RevisionView id={rev} onClose={() => setRev(null)} />}
    </div>
  );
}

function RevisionView({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApi(() => api('memos.revision', { id }), [id]);
  return (
    <Modal title="نسخة محفوظة من المذكرة" size="wide" onClose={onClose}>
      {q.loading ? <Loading /> : q.data && <div><h3>{q.data.title}</h3><div className="help">{fmtDateTime(q.data.savedAt)}</div><div className="long-text" style={{ marginTop: 12 }}>{q.data.body || '—'}</div></div>}
    </Modal>
  );
}
