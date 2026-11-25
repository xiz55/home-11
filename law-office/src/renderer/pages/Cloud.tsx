// الحساب السحابي والمزامنة: الدخول (مع التحقق بخطوتين)، حالة المزامنة، الأجهزة، التعارضات، ودعوة المستشارين.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cloud, CloudOff, RefreshCw, ShieldCheck, Smartphone, LogIn, AlertTriangle, CheckCircle2, UploadCloud, DownloadCloud } from 'lucide-react';
import { Alert, Badge, Button, Card, Checkbox, DataTable, Empty, KV, Loading, Select, TextInput, confirmAsync, toast, Ltr } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { When } from '../lib/display';
import { fmtSize } from '../forms/docs';
import { fmtAmount } from '../../shared/money';
import type { MethodOutput } from '../../main/ipc/registry';

type Status = MethodOutput<'cloud.status'>;

export const PHASE: Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' }> = {
  not_configured: { label: 'المزامنة غير مفعّلة', tone: 'neutral' },
  signed_out: { label: 'غير مسجّل في الحساب السحابي', tone: 'neutral' },
  idle: { label: 'متصل', tone: 'success' },
  syncing: { label: 'جارٍ المزامنة', tone: 'info' },
  uploading: { label: 'جارٍ الرفع', tone: 'info' },
  downloading: { label: 'جارٍ التنزيل', tone: 'info' },
  offline: { label: 'دون اتصال', tone: 'warning' },
  error: { label: 'خطأ في المزامنة', tone: 'danger' },
  revoked: { label: 'أُلغي وصول هذا الجهاز', tone: 'danger' },
  mfa_required: { label: 'يلزم رمز التحقق', tone: 'warning' },
};

/** حالة المزامنة الحية (تتحدث بأحداث من العملية الرئيسية). */
export function useCloudStatus(): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    api('cloud.status', {}).then((x) => alive && setS(x), () => undefined);
    const off = window.lawApi.on('cloud:status', (x) => alive && setS(x as Status));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return s;
}

/** مؤشر الحالة أعلى الشاشة: لا يظهر «تمت المزامنة» مع تغييرات معلقة أو مرفقات غير مكتملة. */
export function CloudStatusChip() {
  const s = useCloudStatus();
  const navigate = useNavigate();
  if (!s || s.phase === 'not_configured' || !('officeId' in s) || !s.officeId) return null;
  const pendingBlobs = (s.blobs?.pending_upload ?? 0) + (s.blobs?.uploading ?? 0) + (s.blobs?.failed ?? 0);
  const info = s.phase === 'idle' && (s.pending > 0 || pendingBlobs > 0) ? { label: 'تغييرات معلقة', tone: 'warning' as const } : PHASE[s.phase] ?? PHASE.idle;
  return (
    <button className="cloud-chip" onClick={() => navigate('/settings?tab=cloud')} title="حالة المزامنة" aria-label={`حالة المزامنة: ${info.label}`}>
      {s.phase === 'offline' || s.phase === 'revoked' ? <CloudOff size={16} /> : s.phase === 'syncing' || s.phase === 'uploading' || s.phase === 'downloading' ? <RefreshCw size={16} className="spin" /> : <Cloud size={16} />}
      <Badge tone={info.tone}>{info.label}</Badge>
      {s.pending > 0 && <span className="help">{s.pending} معلّق</span>}
      {s.conflicts > 0 && <Badge tone="danger">{s.conflicts} تعارض</Badge>}
    </button>
  );
}

/** نموذج الدخول بالحساب السحابي (يُستخدم في شاشة الدخول وفي الإعدادات). */
export function CloudSignIn({ onDone }: { onDone: (r: { signedIn: boolean; needsOffice: boolean }) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'creds' | 'mfa'>('creds');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (step === 'creds') {
        const r = await api('cloud.signIn', { email, password });
        if (r.mfaRequired) setStep('mfa');
        else {
          if (r.offline) toast.info('دخول دون اتصال: ستُزامن التغييرات عند عودة الاتصال');
          onDone(r);
        }
      } else onDone(await api('cloud.mfaVerify', { code }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="stack g2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {step === 'creds' ? (
        <>
          <TextInput label="البريد الإلكتروني للحساب" ltr value={email} onChange={setEmail} autoFocus name="email" />
          <TextInput label="كلمة المرور" type="password" ltr value={password} onChange={setPassword} name="cloud-password" />
        </>
      ) : (
        <TextInput label="رمز التحقق من تطبيق المصادقة (6 أرقام)" ltr value={code} onChange={setCode} autoFocus name="otp" />
      )}
      {err && <Alert tone="danger">{err}</Alert>}
      <Button type="submit" variant="primary" icon={<LogIn />} loading={busy}>
        {step === 'creds' ? 'الدخول بحساب المكتب' : 'تحقق'}
      </Button>
    </form>
  );
}

/** ضبط بيانات مشروع Supabase (العنوان والمفتاح العام فقط — لا مفاتيح إدارية في التطبيق). */
function CloudConfigForm({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack g2">
      <Alert tone="info">أدخل عنوان مشروع Supabase الخاص بالمكتب ومفتاحه العام (anon / publishable). المفتاح الإداري لا يُدخل في التطبيق أبدًا.</Alert>
      <TextInput label="عنوان المشروع" ltr value={url} onChange={setUrl} placeholder="https://xxxx.supabase.co" />
      <TextInput label="المفتاح العام (anon / publishable)" ltr value={key} onChange={setKey} />
      <Button
        variant="primary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api('cloud.configure', { url, anonKey: key });
            toast.success('حُفظت بيانات المشروع السحابي على هذا الجهاز');
            onDone();
          } catch (e) {
            toast.error(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        حفظ
      </Button>
    </div>
  );
}

/** جهاز إضافي جديد (بلا بيانات): ربطه بالمكتب السحابي بدل إنشاء مكتب محلي جديد. */
export function JoinDevice({ onDone }: { onDone: () => void }) {
  const cfg = useApi(() => api('cloud.config', {}), []);
  const [stage, setStage] = useState<'config' | 'signin' | 'office'>('config');
  const offices = useApi(() => (stage === 'office' ? api('cloud.offices', {}) : Promise.resolve([])), [stage]);
  useEffect(() => {
    if (cfg.data?.configured && stage === 'config') setStage('signin');
  }, [cfg.data, stage]);
  if (cfg.loading) return <Loading />;
  if (stage === 'config') return <CloudConfigForm onDone={() => setStage('signin')} />;
  if (stage === 'signin') return <CloudSignIn onDone={(r) => (r.signedIn ? onDone() : setStage('office'))} />;
  return (
    <div className="stack g2">
      {(offices.data ?? []).length === 0 ? (
        <Alert tone="warning">هذا الحساب غير مضاف إلى أي مكتب. اطلب من صاحب المكتب دعوتك من الإعدادات ← الحساب السحابي.</Alert>
      ) : (
        (offices.data ?? []).map((o) => (
          <Button
            key={o.office_id}
            variant="primary"
            onClick={async () => {
              try {
                await api('cloud.joinOffice', { officeId: o.office_id });
                toast.success('اكتملت المزامنة الأولى');
                onDone();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            ربط هذا الجهاز بمكتب «{o.name}» وتنزيل بياناته
          </Button>
        ))
      )}
      <div className="help">لا تُدمج بيانات محلية سابقة تلقائيًا؛ الربط متاح لجهاز بلا بيانات فقط.</div>
    </div>
  );
}

function Mfa() {
  const factors = useApi(() => api('cloud.mfaFactors', {}), []);
  const [enroll, setEnroll] = useState<MethodOutput<'cloud.mfaEnroll'> | null>(null);
  const [code, setCode] = useState('');
  const active = (factors.data ?? []).some((f) => f.status === 'verified');
  return (
    <Card title="التحقق بخطوتين" sub="رمز متغير من تطبيق مصادقة (مثل Google Authenticator أو Microsoft Authenticator أو كلمات السر في iOS)">
      {active ? (
        <Alert tone="success">مفعّل لحسابك.</Alert>
      ) : enroll ? (
        <div className="stack g2">
          <div>امسح الرمز بتطبيق المصادقة، أو أدخل المفتاح يدويًا:</div>
          <img src={enroll.qr} alt="رمز QR للتحقق بخطوتين" style={{ width: 180, height: 180, background: '#fff' }} />
          <Ltr>{enroll.secret}</Ltr>
          <TextInput label="الرمز المكون من 6 أرقام" ltr value={code} onChange={setCode} />
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api('cloud.mfaEnrollVerify', { factorId: enroll.factorId, code });
                toast.success('فُعّل التحقق بخطوتين');
                setEnroll(null);
                factors.reload();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            تفعيل
          </Button>
        </div>
      ) : (
        <Button icon={<ShieldCheck />} onClick={async () => setEnroll(await api('cloud.mfaEnroll', {}))}>
          تفعيل التحقق بخطوتين
        </Button>
      )}
    </Card>
  );
}

function Devices() {
  const q = useApi(() => api('cloud.devices', {}), []);
  if (q.error) return <Alert tone="warning">{q.error.message}</Alert>;
  return (
    <Card title="الأجهزة والجلسات" sub="إلغاء جهاز يمنع وصوله الجديد عند اتصاله فورًا؛ لا يمكن محو ملفات سبق تنزيلها على جهاز غير متصل." flush>
      <DataTable
        rows={q.data ?? []}
        rowKey={(r) => r.id}
        empty="لا أجهزة مسجلة"
        columns={[
          { key: 'n', header: 'الجهاز', render: (r) => <span>{r.device_name} {r.current && <Badge tone="info">هذا الجهاز</Badge>}</span> },
          { key: 'p', header: 'النظام', render: (r) => ({ windows: 'ويندوز', mac: 'ماك', ios: 'آيفون', linux: 'لينكس' })[r.platform as string] ?? r.platform },
          { key: 'v', header: 'الإصدار', render: (r) => <Ltr>{r.app_version ?? '—'}</Ltr> },
          { key: 'l', header: 'آخر نشاط', render: (r) => <When at={r.last_seen} /> },
          { key: 's', header: 'الحالة', render: (r) => (r.revoked_at ? <Badge tone="danger">ملغى</Badge> : <Badge tone="success">نشط</Badge>) },
          {
            key: 'x',
            header: '',
            render: (r) =>
              !r.revoked_at && (
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!(await confirmAsync({ title: 'إلغاء جلسة الجهاز', message: `سيُمنع «${r.device_name}» من الوصول الجديد لبيانات المكتب. الملفات التي نُزّلت عليه سابقًا لا يمكن محوها عن بُعد.`, confirmLabel: 'إلغاء الجلسة', danger: true }))) return;
                    try {
                      await api('cloud.revokeDevice', { id: r.id });
                      q.reload();
                    } catch (e) {
                      toast.error(e);
                    }
                  }}
                >
                  إلغاء الجلسة
                </Button>
              ),
          },
        ]}
      />
    </Card>
  );
}

const TABLE_AR: Record<string, string> = { memos: 'مذكرة', consultation_opinions: 'استشارة مكتوبة', case_analysis: 'تحليل قضية', notes: 'ملاحظة', hearings: 'جلسة', consultations: 'استشارة', meetings: 'اجتماع', cases: 'قضية', clients: 'عميل', judgments: 'حكم', tasks: 'مهمة' };

function Conflicts() {
  const q = useApi(() => api('cloud.conflicts', {}), []);
  const open = (q.data ?? []).filter((c) => !c.resolvedAt);
  return (
    <Card title="تعارضات تحتاج مراجعة" sub="عُدّل الحقل نفسه من جهازين: بقيت نسخة الخادم معتمدة، وحُفظت نسخة هذا الجهاز هنا دون فقد.">
      {open.length === 0 ? (
        <Empty title="لا توجد تعارضات" />
      ) : (
        <ul className="list-plain">
          {open.map((c) => (
            <li key={c.id}>
              <div className="row wrap" style={{ gap: 6 }}>
                <AlertTriangle size={16} /> <strong>{TABLE_AR[c.tbl.split('$')[0]] ?? c.tbl}</strong> — الحقول: {c.fields.join('، ')} — <When at={c.createdAt} />
              </div>
              {c.fields.map((f) => (
                <div key={f} className="split" style={{ marginTop: 6 }}>
                  <div>
                    <div className="help">نسخة الخادم (المعتمدة الآن)</div>
                    <div className="text-pre card-pad" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>{String(c.server[f] ?? '')}</div>
                  </div>
                  <div>
                    <div className="help">نسخة هذا الجهاز</div>
                    <div className="text-pre card-pad" style={{ border: '1px solid var(--border)', borderRadius: 8 }}>{String(c.client[f] ?? '')}</div>
                  </div>
                </div>
              ))}
              <div className="btn-group" style={{ marginTop: 6 }}>
                <Button size="sm" onClick={async () => { await api('cloud.resolveConflict', { id: c.id, keep: 'server' }); q.reload(); invalidate(); }}>إبقاء نسخة الخادم</Button>
                <Button size="sm" variant="primary" onClick={async () => { await api('cloud.resolveConflict', { id: c.id, keep: 'device' }); q.reload(); invalidate(); }}>اعتماد نسخة هذا الجهاز</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Invite() {
  const users = useApi(() => api('users.list', {}), []);
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<string | null>(null);
  return (
    <Card title="دعوة مستشار للحساب السحابي" sub="يُنشأ له حساب بالبريد ويُربط بمستخدمه في المكتب وصلاحياته">
      <div className="form-grid">
        <Select label="المستشار" value={userId} onChange={setUserId} options={(users.data ?? []).filter((u) => u.role === 'consultant').map((u) => ({ value: u.id, label: u.displayName }))} />
        <TextInput label="بريده الإلكتروني" ltr value={email} onChange={setEmail} />
      </div>
      <Button
        variant="primary"
        onClick={async () => {
          try {
            const r = await api('cloud.invite', { userId, email });
            setResult(r.temporaryPassword ? `كلمة المرور المؤقتة (تظهر مرة واحدة، سلّمها له ويغيرها بعد الدخول): ${r.temporaryPassword}` : 'رُبط حسابه الموجود بالمكتب.');
          } catch (e) {
            toast.error(e);
          }
        }}
      >
        دعوة
      </Button>
      {result && <Alert tone="success"><Ltr>{result}</Ltr></Alert>}
    </Card>
  );
}

export function CloudTab() {
  const { isOwner, refresh } = useSession();
  const s = useCloudStatus();
  const cfg = useApi(() => api('cloud.config', {}), []);
  const [busy, setBusy] = useState(false);
  if (!s || cfg.loading) return <Loading />;
  if (!cfg.data?.configured) {
    if (!isOwner) return <Alert tone="neutral">المزامنة السحابية غير مفعّلة على هذا الجهاز. يضبطها صاحب المكتب.</Alert>;
    return (
      <Card title="ربط المكتب بالحساب السحابي">
        <CloudConfigForm onDone={() => cfg.reload()} />
      </Card>
    );
  }
  if (s.phase === 'signed_out' || s.phase === 'mfa_required') {
    return (
      <Card title="الدخول بحساب المكتب السحابي">
        <CloudSignIn onDone={() => { void refresh(); cfg.reload(); }} />
      </Card>
    );
  }
  const linked = 'officeId' in s && !!s.officeId;
  return (
    <div className="stack g2">
      <Card
        title="المزامنة"
        actions={
          linked && (
            <Button icon={<RefreshCw />} loading={busy} onClick={async () => { setBusy(true); try { await api('cloud.syncNow', {}); invalidate(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>
              مزامنة الآن
            </Button>
          )
        }
      >
        {linked ? (
          <KV
            items={[
              ['المكتب', 'officeName' in s ? s.officeName : '—'],
              ['الحساب', 'email' in s ? s.email : '—'],
              ['الحالة', <Badge key="p" tone={PHASE[s.phase]?.tone ?? 'neutral'}>{PHASE[s.phase]?.label ?? s.phase}</Badge>],
              ['تغييرات معلقة', <Ltr key="q">{'pending' in s ? s.pending : 0}</Ltr>],
              ['آخر مزامنة ناجحة', 'lastSyncAt' in s && s.lastSyncAt ? <When key="l" at={s.lastSyncAt} /> : 'لم تتم بعد'],
              ['المرفقات', 'blobs' in s ? <span key="b"><UploadCloud size={14} /> بانتظار الرفع {(s.blobs.pending_upload ?? 0) + (s.blobs.failed ?? 0)} — <CheckCircle2 size={14} /> مرفوعة {s.blobs.uploaded ?? 0} — <DownloadCloud size={14} /> على الخادم فقط {s.blobs.remote ?? 0} — محلية {s.blobs.local ?? 0}</span> : '—'],
              ['مساحة المرفقات على هذا الجهاز', 'localBytes' in s ? fmtSize(s.localBytes) : '—'],
              ...('lastError' in s && s.lastError ? ([['آخر خطأ', <span key="e" className="help">{s.lastError}</span>]] as [string, React.ReactNode][]) : []),
            ]}
          />
        ) : isOwner ? (
          <div className="stack g2">
            <Alert tone="info">
              نقل بيانات هذا الجهاز إلى المكتب السحابي يتم مرة واحدة من جهاز واحد فقط (الجهاز المعتمد). تُؤخذ أولًا نسخة احتياطية كاملة محلية، ولا تُحذف بيانات هذا الجهاز. الأجهزة الأخرى تنضم بعد ذلك وتنزّل البيانات.
            </Alert>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                if (!(await confirmAsync({ title: 'نقل بيانات المكتب إلى الحساب السحابي', message: 'ستُرفع بيانات هذا الجهاز ومرفقاته إلى خدمة Supabase وBackblaze B2 المضبوطة. تأكد أنك اعتمدت الخدمة ومنطقة الاستضافة قبل نقل بيانات العملاء الحقيقية.', confirmLabel: 'نقل البيانات الآن' }))) return;
                setBusy(true);
                try {
                  const r = await api('cloud.createOffice', {});
                  toast.success(`أُنشئ المكتب السحابي. النسخة الاحتياطية قبل النقل: ${r.backupFile}`);
                  await api('cloud.syncNow', {}).catch(toast.error);
                } catch (e) {
                  toast.error(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              إنشاء المكتب السحابي ونقل بيانات هذا الجهاز
            </Button>
          </div>
        ) : (
          <Alert tone="warning">هذا الحساب غير مضاف لمكتب بعد.</Alert>
        )}
      </Card>
      {linked && <Conflicts />}
      {linked && <Devices />}
      <Mfa />
      {linked && isOwner && <Invite />}
      {linked && isOwner && <OfficePolicy officeId={'officeId' in s ? s.officeId : null} />}
      {linked && isOwner && <MigrationCheck />}
      <Card title="هذا الجهاز">
        <Button icon={<Smartphone />} onClick={async () => { await api('cloud.signOut', {}); await refresh(); }}>
          الخروج من الحساب السحابي على هذا الجهاز
        </Button>
      </Card>
    </div>
  );
}

function OfficePolicy({ officeId }: { officeId: string | null }) {
  const offices = useApi(() => api('cloud.offices', {}), []);
  const cur = offices.data?.find((o) => o.office_id === officeId);
  return (
    <Card title="سياسة المكتب">
      <Checkbox
        label="إلزام كل الأعضاء بالتحقق بخطوتين"
        checked={!!cur?.require_mfa}
        onChange={async (on) => {
          try {
            await api('cloud.requireMfa', { on });
            toast.success('حُفظت السياسة');
          } catch (e) {
            toast.error(e);
          }
          offices.reload();
        }}
        hint="فعّله لحسابك أولًا"
      />
    </Card>
  );
}

/** تقرير التحقق من نقل البيانات: يقارن هذا الجهاز بالخادم (أعداد، معرّفات، مجموع الدفعات). لا يغيّر شيئًا. */
function MigrationCheck() {
  const [r, setR] = useState<MethodOutput<'cloud.migrationReport'> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setR(await api('cloud.migrationReport', {}));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="التحقق من نقل البيانات" actions={<Button loading={busy} onClick={run}>تحقق الآن</Button>}>
      {!r ? (
        <div className="help">يقارن السجلات على هذا الجهاز بما على الخادم: العدد لكل جدول، وتطابق المعرّفات والأرقام، ومجموع الدفعات. يمكن تشغيله أي عدد من المرات.</div>
      ) : (
        <div className="stack g2">
          {r.ok ? (
            <Alert tone="success">متطابق: كل السجلات والمعرّفات ومجموع الدفعات على الخادم مطابقة لهذا الجهاز.</Alert>
          ) : (
            <Alert tone="warning">
              يوجد فرق{r.pending ? ` — ${r.pending} تغيير لم يُرسل بعد؛ اضغط «مزامنة الآن» ثم أعد التحقق` : ''}. راجع الصفوف المعلّمة أدناه.
            </Alert>
          )}
          <KV items={[['مجموع الدفعات (هذا الجهاز)', <span key="a">{fmtAmount(r.paymentsLocal)}</span>], ['مجموع الدفعات (الخادم)', <span key="b">{fmtAmount(r.paymentsServer)}</span>]]} />
          <DataTable
            rows={r.rows}
            rowKey={(x) => x.table}
            columns={[
              { key: 't', header: 'الجدول', render: (x) => <Ltr>{x.table}</Ltr> },
              { key: 'l', header: 'هذا الجهاز', render: (x) => x.local },
              { key: 's', header: 'الخادم', render: (x) => x.server },
              { key: 'm', header: 'النتيجة', render: (x) => (x.local === x.server && x.idsMatch ? <Badge tone="success">متطابق</Badge> : <Badge tone="warning">فرق</Badge>) },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

/** حالة ملف مرفق في وضع المزامنة + «إتاحة دون اتصال». */
export function BlobBadge({ versionId }: { versionId: string }) {
  const { state } = useSession();
  const linked = !!(state as { cloudLinked?: boolean } | null)?.cloudLinked;
  const q = useApi(() => (linked ? api('cloud.blobState', { versionIds: [versionId] }) : Promise.resolve({} as Record<string, null>)), [versionId, linked]);
  if (!linked) return null;
  const st = q.data?.[versionId];
  if (!st) return null;
  const label: Record<string, [string, 'success' | 'warning' | 'neutral' | 'info' | 'danger']> = {
    pending_upload: ['بانتظار الرفع', 'warning'],
    uploading: ['جارٍ الرفع', 'info'],
    uploaded: ['مرفوع ومتحقق منه', 'success'],
    remote: ['على الخادم فقط', 'neutral'],
    downloading: ['جارٍ التنزيل', 'info'],
    local: ['متاح على هذا الجهاز', 'success'],
    failed: ['فشل الرفع — ستُعاد المحاولة', 'danger'],
  };
  const [l, tone] = label[st.state] ?? [st.state, 'neutral'];
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge tone={tone}>{l}</Badge>
      <Checkbox label="إتاحة دون اتصال" checked={st.pinned} onChange={async (p) => { await api('cloud.blobPin', { versionId, pinned: p }); q.reload(); }} />
    </span>
  );
}
