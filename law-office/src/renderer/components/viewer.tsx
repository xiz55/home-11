// عارض المستندات المحلي: PDF (pdf.js محلي)، الصور، معاينة نصية لـ DOCX، وشرح لملفات DOC.
import { BlobBadge } from '../pages/Cloud';
import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, FolderOpen, Pencil, Upload, ZoomIn, ZoomOut, Archive, ArchiveRestore, Type } from 'lucide-react';
import { Alert, Badge, Button, ErrorBox, Loading, StatusBadge, toast, confirmAsync, Ltr, Empty } from './ui';
import { api, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { DOC_CATEGORIES, DOC_STATUSES, ALLOWED_EXTENSIONS } from '../../shared/constants';
import { fmtDate, fmtDateTime } from '../../shared/dates';
import { AddVersionForm, DocumentEditForm, extLabel, fmtSize } from '../forms/docs';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfViewer({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: pdfjs.PDFDocumentProxy | null = null;
    const base = new URL('./pdfjs/', window.location.href).href;
    const task = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/' });
    task.promise.then(
      (d) => {
        loaded = d;
        if (alive) {
          setDoc(d);
          setPage(1);
        }
      },
      (e) => alive && setErr('تعذر عرض ملف PDF (قد يكون تالفًا أو محميًا بكلمة مرور). يمكنك فتحه بالبرنامج الافتراضي. ' + (e?.message ?? '')),
    );
    return () => {
      alive = false;
      void task.destroy();
      void loaded?.destroy();
    };
  }, [bytes]);
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: ReturnType<pdfjs.PDFPageProxy['render']> | null = null;
    doc.getPage(page).then((p) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d')!;
      renderTask = p.render({ canvas, canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      renderTask.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page, scale]);
  if (err) return <Alert tone="warning">{err}</Alert>;
  if (!doc) return <Loading label="جارٍ تحميل ملف PDF…" />;
  return (
    <>
      <div className="viewer-toolbar">
        <Button size="sm" iconOnly icon={<ChevronRight />} aria-label="الصفحة السابقة" title="الصفحة السابقة" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} />
        <span className="small">
          صفحة <Ltr>{page}</Ltr> من <Ltr>{doc.numPages}</Ltr>
        </span>
        <Button size="sm" iconOnly icon={<ChevronLeft />} aria-label="الصفحة التالية" title="الصفحة التالية" disabled={page >= doc.numPages} onClick={() => setPage((p) => p + 1)} />
        <span className="grow" />
        <Button size="sm" iconOnly icon={<ZoomOut />} aria-label="تصغير" title="تصغير" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(1)))} />
        <span className="small"><Ltr>{Math.round(scale * 100)}%</Ltr></span>
        <Button size="sm" iconOnly icon={<ZoomIn />} aria-label="تكبير" title="تكبير" onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(1)))} />
      </div>
      <div className="viewer-canvas">
        <canvas ref={canvasRef} aria-label={`صفحة ${page}`} />
      </div>
    </>
  );
}

function ImageViewer({ bytes, mime }: { bytes: Uint8Array; mime: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes.slice()], { type: mime })), [bytes, mime]);
  const [fit, setFit] = useState(true);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <>
      <div className="viewer-toolbar">
        <Button size="sm" onClick={() => setFit((f) => !f)} icon={fit ? <ZoomIn /> : <ZoomOut />}>
          {fit ? 'الحجم الحقيقي' : 'ملاءمة العرض'}
        </Button>
      </div>
      <div className="viewer-canvas">
        <img src={url} alt="معاينة الصورة" className={fit ? 'fit' : ''} />
      </div>
    </>
  );
}

function DocxPreview({ versionId }: { versionId: string }) {
  const q = useApi(() => api('documents.docxPreview', { versionId }), [versionId]);
  if (q.loading && !q.data) return <Loading label="جارٍ تجهيز المعاينة…" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const html = DOMPurify.sanitize(q.data!.html, { FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'], FORBID_ATTR: ['style', 'onerror', 'onload'] });
  return (
    <>
      <div className="viewer-toolbar">
        <Alert tone="info">معاينة نصية تقريبية للمحتوى؛ قد يختلف التنسيق عن Word. الأصل لا يتغير. للعرض المطابق افتحه ببرنامج Word.</Alert>
      </div>
      <div className="viewer-canvas">
        <div className="docx-preview" dir="auto" dangerouslySetInnerHTML={{ __html: html || '<p>لا يوجد نص قابل للعرض.</p>' }} />
      </div>
    </>
  );
}

function BinaryPreview({ versionId, ext }: { versionId: string; ext: string }) {
  const kind = (ALLOWED_EXTENSIONS as Record<string, { kind: string }>)[ext]?.kind;
  const q = useApi(() => (kind === 'pdf' || kind === 'image' ? api('documents.readBytes', { versionId }) : Promise.resolve(null)), [versionId, kind]);
  if (kind === 'docx') return <DocxPreview versionId={versionId} />;
  if (kind === 'doc')
    return (
      <div className="card-pad">
        <Alert tone="neutral">
          ملف Word بالصيغة القديمة (DOC). محفوظ ومؤرشف في البرنامج كما هو، لكن لا تتوفر له معاينة داخلية. استخدم زر «فتح» لعرضه في Microsoft Word أو برنامج متوافق مثبت على الجهاز. لا يحوله البرنامج إلى PDF.
        </Alert>
      </div>
    );
  if (kind === 'image-external')
    return (
      <div className="card-pad">
        <Alert tone="neutral">هذا النوع من الصور ({extLabel(ext)}) لا يُعرض داخل البرنامج. افتحه بزر «فتح» بالبرنامج الافتراضي في نظام التشغيل، أو أظهره في مجلده.</Alert>
      </div>
    );
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <div className="card-pad"><ErrorBox error={q.error} /></div>;
  if (!q.data) return null;
  if (kind === 'pdf') return <PdfViewer bytes={q.data.bytes} />;
  return <ImageViewer bytes={q.data.bytes} mime={q.data.mime} />;
}

export function DocumentPanel({ documentId, onClose }: { documentId: string; onClose?: () => void }) {
  const q = useApi(() => api('documents.get', { id: documentId }), [documentId]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [addVer, setAddVer] = useState(false);
  const [showText, setShowText] = useState(false);
  useEffect(() => setVersionId(null), [documentId]);
  const textQ = useApi(() => (showText && (versionId ?? q.data?.versions[0]?.id) ? api('documents.text', { versionId: (versionId ?? q.data!.versions[0].id)! }) : Promise.resolve(null)), [showText, versionId, q.data?.versions[0]?.id]);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { document: d, versions, links } = q.data!;
  const v = versions.find((x) => x.id === versionId) ?? versions[0];
  const open = async () => {
    try {
      const r = await api('documents.open', { versionId: v.id });
      if (r.opened) toast.info(r.message);
      else if (await confirmAsync({ title: 'تعذر فتح الملف', message: r.message, confirmLabel: 'إظهار الملف في مجلده', cancelLabel: 'إغلاق' })) await api('documents.showInFolder', { versionId: v.id });
    } catch (e) {
      toast.error(e);
    }
  };
  const exportCopy = async () => {
    try {
      const r = await api('documents.export', { versionId: v.id });
      if (r.saved) toast.success('صُدّرت نسخة من الملف');
    } catch (e) {
      toast.error(e);
    }
  };
  const toggleArchive = async () => {
    if (!d.archivedAt && !(await confirmAsync({ title: 'أرشفة المستند', message: 'سيُخفى المستند من القوائم الافتراضية مع بقاء الملف وكل نسخه محفوظة. هل تريد المتابعة؟', confirmLabel: 'أرشفة' }))) return;
    try {
      await api('documents.setArchived', { id: d.id, archived: !d.archivedAt });
      invalidate();
      toast.success(d.archivedAt ? 'أُلغيت الأرشفة' : 'أُرشف المستند');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <section className="card viewer" aria-label="معاينة المستند">
      <div className="card-head">
        <div className="grow">
          <h2 style={{ fontSize: 17 }}>{d.title}</h2>
          <div className="row wrap small muted" style={{ marginTop: 4 }}>
            <Badge tone="outline">{DOC_CATEGORIES[d.category].label}</Badge>
            <StatusBadge map={DOC_STATUSES} value={d.status} />
            {d.isInternal && <Badge tone="warning">داخلي</Badge>}
            {d.archivedAt && <Badge tone="neutral">مؤرشف</Badge>}
            <span>تاريخ المستند: {d.docDate ? <Ltr>{fmtDate(d.docDate)}</Ltr> : 'غير مسجل'}</span>
            {d.hijriText && <span>الهجري: {d.hijriText}{d.hijriSource ? ` (${d.hijriSource})` : ''}</span>}
          </div>
        </div>
        {onClose && <Button size="sm" variant="ghost" onClick={onClose}>إغلاق</Button>}
      </div>
      <div className="viewer-toolbar">
        <Button size="sm" variant="primary" icon={<ExternalLink />} onClick={() => void open()}>
          فتح
        </Button>
        <Button size="sm" icon={<Download />} onClick={() => void exportCopy()}>
          تصدير
        </Button>
        <Button size="sm" icon={<Upload />} onClick={() => setAddVer(true)}>
          إضافة نسخة
        </Button>
        <Button size="sm" icon={<FolderOpen />} onClick={() => void api('documents.showInFolder', { versionId: v.id }).catch(toast.error)}>
          إظهار في المجلد
        </Button>
        <Button size="sm" icon={<Pencil />} onClick={() => setEdit(true)}>
          البيانات
        </Button>
        <Button size="sm" icon={<Type />} onClick={() => setShowText((s) => !s)}>
          {showText ? 'إخفاء النص المستخرج' : 'النص المستخرج'}
        </Button>
        <Button size="sm" icon={d.archivedAt ? <ArchiveRestore /> : <Archive />} onClick={() => void toggleArchive()}>
          {d.archivedAt ? 'إلغاء الأرشفة' : 'أرشفة'}
        </Button>
      </div>
      <div className="viewer-toolbar small">
        <span>
          الملف: <Ltr>{v.originalName}</Ltr> — {extLabel(v.ext)} — {fmtSize(v.size)}
        </span>
        <span className="grow" />
        {versions.length > 1 && (
          <select className="select" style={{ width: 'auto', height: 34 }} value={v.id} onChange={(e) => setVersionId(e.target.value)} aria-label="اختيار النسخة">
            {versions.map((x) => (
              <option key={x.id} value={x.id}>
                النسخة {x.versionNo} — {fmtDateTime(x.addedAt)}
              </option>
            ))}
          </select>
        )}
        {versions.length === 1 && <span className="muted">النسخة 1</span>}
        <BlobBadge versionId={v.id} />
      </div>
      {links.length > 0 && (
        <div className="viewer-toolbar small">
          مرتبط بـ: {links.map((l) => <Badge key={l.kind + l.id} tone="outline">{l.label}</Badge>)}
        </div>
      )}
      {showText ? (
        <div className="card-pad">
          {textQ.loading ? (
            <Loading />
          ) : textQ.data?.status === 'done' ? (
            <div className="long-text" style={{ maxHeight: '60vh', overflow: 'auto' }} dir="auto">{textQ.data.text}</div>
          ) : textQ.data?.status === 'pending' ? (
            <Alert tone="info">جارٍ استخراج النص محليًا…</Alert>
          ) : (
            <Alert tone="neutral">لا يوجد نص قابل للاستخراج من هذا الملف (قد يكون صورة ممسوحة ضوئيًا أو نوعًا غير مدعوم). البحث يشمل بيانات المستند فقط.</Alert>
          )}
        </div>
      ) : (
        <BinaryPreview key={v.id} versionId={v.id} ext={v.ext} />
      )}
      {versions.length > 1 && (
        <details className="card-pad small">
          <summary>سجل النسخ ({versions.length})</summary>
          <ul className="list-plain">
            {versions.map((x) => (
              <li key={x.id}>
                النسخة {x.versionNo} — <Ltr>{x.originalName}</Ltr> — {fmtDateTime(x.addedAt)} — {x.addedByName ?? ''} {x.note && <span className="muted">({x.note})</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {edit && <DocumentEditForm doc={d} onClose={() => setEdit(false)} />}
      {addVer && <AddVersionForm documentId={d.id} onClose={() => setAddVer(false)} />}
    </section>
  );
}

type DocRow = { id: string; title: string; category: keyof typeof DOC_CATEGORIES; docDate: string | null; createdAt: string; isInternal: boolean; archivedAt: string | null; caseFileNo: string | null; current: { ext: string; originalName: string } | null };

/** قائمة مصنفة مع معاينة مجاورة. */
export function DocumentBrowser({ docs, emptyHint, selected, onSelect }: { docs: DocRow[]; emptyHint?: string; selected: string | null; onSelect: (id: string | null) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, DocRow[]>();
    for (const d of docs) {
      const k = d.category;
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    return [...m.entries()].sort((a, b) => Object.keys(DOC_CATEGORIES).indexOf(a[0]) - Object.keys(DOC_CATEGORIES).indexOf(b[0]));
  }, [docs]);
  return (
    <div className="split">
      <section className="card" aria-label="قائمة المستندات" style={{ maxHeight: '78vh', overflow: 'auto' }}>
        {docs.length === 0 ? (
          <Empty title="لا توجد مستندات" icon={<FileText />}>{emptyHint}</Empty>
        ) : (
          groups.map(([cat, list]) => (
            <div key={cat}>
              <div className="doc-group-title">
                {DOC_CATEGORIES[cat as keyof typeof DOC_CATEGORIES].label} ({list.length})
              </div>
              {list.map((d) => (
                <div key={d.id} className={`doc-list-item ${selected === d.id ? 'selected' : ''}`} onClick={() => onSelect(d.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(d.id)} role="button" aria-pressed={selected === d.id}>
                  <div className="ic">{(d.current?.ext ?? '?').toUpperCase()}</div>
                  <div className="grow">
                    <div style={{ fontWeight: 500 }}>{d.title}</div>
                    <div className="help">
                      {d.docDate ? <Ltr>{fmtDate(d.docDate)}</Ltr> : <span>أُرفق {fmtDate(d.createdAt.slice(0, 10))}</span>}
                      {d.caseFileNo && <> — ملف <Ltr>{d.caseFileNo}</Ltr></>}
                      {d.current && <> — <Ltr>{d.current.originalName}</Ltr></>}
                      {d.isInternal && ' — داخلي'}
                      {d.archivedAt && ' — مؤرشف'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </section>
      <div>{selected ? <DocumentPanel documentId={selected} onClose={() => onSelect(null)} /> : <section className="card"><Empty title="اختر مستندًا لمعاينته" icon={<FileText />}>تظهر المعاينة هنا بجانب القائمة.</Empty></section>}</div>
    </div>
  );
}
