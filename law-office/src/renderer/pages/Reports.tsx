import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Eye, FileDown, Printer } from 'lucide-react';
import { Alert, Button, Card, Checkbox, DateInput, Loading, Select, toast } from '../components/ui';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { addDays, todayRiyadh } from '../../shared/dates';
import { Tabs } from '../components/ui';
import { OfficeReportPanel } from './OfficeReport';

type RType = 'case' | 'client' | 'hearings' | 'tasks' | 'fees';
const TYPES: { key: RType; label: string; perm?: 'fees.view' }[] = [
  { key: 'case', label: 'تقرير موقف قضية' },
  { key: 'client', label: 'ملخص شامل لعميل / شركة' },
  { key: 'hearings', label: 'الجلسات القادمة' },
  { key: 'tasks', label: 'المهام المفتوحة' },
  { key: 'fees', label: 'كشف أتعاب', perm: 'fees.view' },
];

export function ReportsPage() {
  const [sp, setSp] = useSearchParams();
  const { can } = useSession();
  const section = sp.get('section') === 'office' || !can('reports.export') ? 'office' : 'client';
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>التقارير</h1>
          <div className="sub">تقارير عربية قابلة للطباعة والحفظ PDF. تقارير العملاء منفصلة عن التقرير الإداري الداخلي للمكتب.</div>
        </div>
      </div>
      <Tabs
        tabs={[
          { key: 'client', label: 'تقارير القضايا والعملاء', hidden: !can('reports.export') },
          { key: 'office', label: 'التقرير الشامل للمكتب', hidden: !can('reports.office') },
        ]}
        value={section}
        onChange={(k) => setSp(k === 'office' ? { section: 'office' } : {}, { replace: true })}
      />
      <div style={{ marginTop: 16 }}>{section === 'office' ? <OfficeReportPanel /> : <ClientReports />}</div>
    </div>
  );
}

function ClientReports() {
  const [sp] = useSearchParams();
  const { can, users } = useSession();
  const [type, setType] = useState<RType>((sp.get('type') as RType) ?? 'case');
  const [caseId, setCaseId] = useState(sp.get('caseId') ?? '');
  const [clientId, setClientId] = useState(sp.get('clientId') ?? '');
  const [from, setFrom] = useState(todayRiyadh());
  const [to, setTo] = useState(addDays(todayRiyadh(), 30));
  const [assignee, setAssignee] = useState('');
  const [opts, setOpts] = useState({ includeInternalNotes: false, includeAnalysis: sp.get('analysis') === '1', includeFees: false, includeTasks: true, includeDocuments: true });
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cases = useApi(() => api('cases.options', {}), []);
  const clients = useApi(() => api('clients.options', {}), []);
  const input = () => ({ type, caseId: type === 'case' ? caseId || null : type === 'hearings' ? caseId || null : null, clientId: ['client', 'fees', 'hearings'].includes(type) ? clientId || null : null, from: type === 'hearings' ? from : null, to: type === 'hearings' ? to : null, assigneeUserId: type === 'tasks' ? assignee || null : null, options: opts });
  const run = async (kind: 'preview' | 'print' | 'pdf') => {
    setBusy(kind);
    try {
      if (kind === 'preview') setHtml((await api('reports.render', input())).html);
      else if (kind === 'print') await api('reports.print', input());
      else {
        const r = await api('reports.savePdf', input());
        if (r.saved) toast.success('حُفظ التقرير PDF');
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  if (!can('reports.export')) return <Alert tone="warning">لا تملك صلاحية استخراج التقارير.</Alert>;
  return (
    <div>
      <div className="split" style={{ gridTemplateColumns: 'minmax(300px, 0.7fr) minmax(0, 1.3fr)' }}>
        <Card title="إعداد التقرير">
          <div className="stack g2">
            <Select label="نوع التقرير" value={type} onChange={(v) => { setType(v as RType); setHtml(null); }} options={TYPES.filter((t) => !t.perm || can(t.perm)).map((t) => ({ value: t.key, label: t.label }))} placeholder="—" />
            {type === 'case' && <Select label="القضية" required value={caseId} onChange={setCaseId} options={(cases.data ?? []).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title}` }))} />}
            {(type === 'client' || type === 'fees') && <Select label="العميل" required value={clientId} onChange={setClientId} options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
            {type === 'hearings' && (
              <>
                <DateInput label="من" value={from} onChange={setFrom} />
                <DateInput label="إلى" value={to} onChange={setTo} />
                <Select label="العميل (اختياري)" value={clientId} onChange={setClientId} options={(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="كل العملاء" />
              </>
            )}
            {type === 'tasks' && <Select label="المسؤول (اختياري)" value={assignee} onChange={setAssignee} options={users.map((u) => ({ value: u.id, label: u.displayName }))} placeholder="الجميع" />}
            {(type === 'case' || type === 'client') && (
              <fieldset>
                <legend>المحتوى</legend>
                <Checkbox label="تضمين الملاحظات الداخلية" checked={opts.includeInternalNotes} onChange={(x) => setOpts({ ...opts, includeInternalNotes: x })} hint="اتركها غير محددة عند إرسال التقرير للعميل" />
                {type === 'case' && <Checkbox label="تضمين التحليل (داخلي)" checked={opts.includeAnalysis} onChange={(x) => setOpts({ ...opts, includeAnalysis: x })} />}
                {type === 'case' && <Checkbox label="تضمين المهام" checked={opts.includeTasks} onChange={(x) => setOpts({ ...opts, includeTasks: x })} />}
                {type === 'case' && <Checkbox label="تضمين قائمة المستندات" checked={opts.includeDocuments} onChange={(x) => setOpts({ ...opts, includeDocuments: x })} />}
                {can('fees.view') && <Checkbox label="تضمين الأتعاب" checked={opts.includeFees} onChange={(x) => setOpts({ ...opts, includeFees: x })} />}
              </fieldset>
            )}
            <div className="btn-group">
              <Button variant="primary" icon={<Eye />} loading={busy === 'preview'} onClick={() => void run('preview')}>معاينة</Button>
              <Button icon={<Printer />} loading={busy === 'print'} onClick={() => void run('print')}>طباعة</Button>
              <Button icon={<FileDown />} loading={busy === 'pdf'} onClick={() => void run('pdf')}>حفظ PDF</Button>
            </div>
            {type === 'fees' && <Alert tone="info">كشف الأتعاب كشف حساب داخلي وليس فاتورة ضريبية متوافقة رسميًا.</Alert>}
          </div>
        </Card>
        <Card title="المعاينة" flush>
          {busy === 'preview' ? <Loading /> : html ? <iframe className="iframe-report" title="معاينة التقرير" sandbox="" srcDoc={html} /> : <div className="card-pad muted">اختر التقرير ثم «معاينة».</div>}
        </Card>
      </div>
    </div>
  );
}
