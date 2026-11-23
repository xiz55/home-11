import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogIn, Scale } from 'lucide-react';
import { Alert, Button, TextInput, Field } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useForm } from '../lib/hooks';
import { useSession } from '../lib/session';
import { DEFAULT_OFFICE_NAME } from '../../shared/constants';

function PasswordInput({ label, value, onChange, error, autoFocus, name, hint }: { label: string; value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean; name?: string; hint?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="input-wrap">
        <input name={name} className={`input ${error ? 'invalid' : ''}`} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} aria-invalid={!!error} style={{ paddingLeft: 48 }} dir="ltr" />
        <span className="addon">
          <Button size="sm" variant="ghost" iconOnly icon={show ? <EyeOff /> : <Eye />} aria-label={show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} title={show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'} onClick={() => setShow((s) => !s)} />
        </span>
      </div>
    </Field>
  );
}

function OfficeHeader({ name, sub }: { name: string; sub?: string }) {
  return (
    <div className="office">
      <div className="mark">
        <Scale size={28} />
      </div>
      <h1>{name}</h1>
      {sub && <div className="help" style={{ marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function RecoveryCodeNotice({ code, onDone }: { code: string; onDone: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ width: 'min(560px, 100%)' }}>
        <OfficeHeader name="رمز استعادة الوصول" />
        <div className="stack g2">
          <Alert tone="warning">
            احتفظ بهذا الرمز في مكان آمن خارج الجهاز (ورقة مطبوعة في خزنة المكتب مثلًا). يُستخدم فقط إذا نسيت كلمة مرور صاحب المكتب، ولن يظهر مرة أخرى. أي شخص يملكه يستطيع تعيين كلمة مرور جديدة لحسابك.
          </Alert>
          <div className="code-box" data-testid="recovery-code">{code}</div>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            حفظت الرمز في مكان آمن
          </label>
          <Button variant="primary" disabled={!ack} onClick={onDone}>
            متابعة
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SetupScreen() {
  const { refresh } = useSession();
  const f = useForm({ officeName: DEFAULT_OFFICE_NAME, displayName: '', username: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (code) return <RecoveryCodeNotice code={code} onDone={() => void refresh()} />;
  const submit = async () => {
    if (f.values.password !== f.values.confirm) {
      f.setErrors({ confirm: 'كلمتا المرور غير متطابقتين' });
      return;
    }
    setBusy(true);
    try {
      const r = await api('auth.setupOwner', { officeName: f.values.officeName, displayName: f.values.displayName, username: f.values.username, password: f.values.password });
      setCode(r.recoveryCode);
    } catch (e) {
      if (e instanceof ApiError) f.setErrors(Object.keys(e.fields).length ? e.fields : { _: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        style={{ width: 'min(560px, 100%)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <OfficeHeader name="إعداد البرنامج لأول مرة" sub="أنشئ حساب صاحب المكتب. تُحفظ البيانات محليًا على هذا الجهاز فقط." />
        <div className="stack g2">
          <TextInput label="اسم المكتب" required {...f.bind('officeName')} onChange={(x) => f.set('officeName', x)} hint="يمكن تعديله لاحقًا من الإعدادات" />
          <TextInput label="اسمك كما يظهر في البرنامج" required {...f.bind('displayName')} onChange={(x) => f.set('displayName', x)} autoFocus />
          <TextInput label="اسم المستخدم" required ltr {...f.bind('username')} onChange={(x) => f.set('username', x)} hint="حروف وأرقام دون مسافات" />
          <PasswordInput label="كلمة المرور" value={f.values.password} onChange={(x) => f.set('password', x)} error={f.errors.password} hint="8 أحرف على الأقل" />
          <PasswordInput label="تأكيد كلمة المرور" value={f.values.confirm} onChange={(x) => f.set('confirm', x)} error={f.errors.confirm} />
          {f.errors._ && <Alert tone="danger">{f.errors._}</Alert>}
          <Button type="submit" variant="primary" loading={busy} icon={<KeyRound />}>
            إنشاء الحساب
          </Button>
          <div className="help">تسجيل الدخول يحمي الوصول عبر البرنامج، لكنه لا يشفّر الملفات على القرص. احمِ جهازك بكلمة مرور ويندوز وتشفير القرص (BitLocker) إن أمكن.</div>
        </div>
      </form>
    </div>
  );
}

export function LoginScreen() {
  const { state, refresh } = useSession();
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const f = useForm({ username: '', password: '', recoveryCode: '', newPassword: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (code) return <RecoveryCodeNotice code={code} onDone={() => void refresh()} />;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await api('auth.login', { username: f.values.username, password: f.values.password });
      else {
        const r = await api('auth.recover', { username: f.values.username, recoveryCode: f.values.recoveryCode, newPassword: f.values.newPassword });
        setCode(r.recoveryCode);
        return;
      }
      await refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        f.setErrors(e.fields);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <OfficeHeader name={state?.officeName ?? ''} sub={mode === 'recover' ? 'استعادة وصول صاحب المكتب' : undefined} />
        {state?.customDataDir && <Alert tone="info">مساحة بيانات منفصلة: <span dir="ltr">{state.customDataDir}</span></Alert>}
        <div className="stack g2" style={{ marginTop: 8 }}>
          <TextInput label="اسم المستخدم" ltr {...f.bind('username')} onChange={(x) => f.set('username', x)} autoFocus name="username" />
          {mode === 'login' ? (
            <PasswordInput label="كلمة المرور" name="password" value={f.values.password} onChange={(x) => f.set('password', x)} error={f.errors.password} />
          ) : (
            <>
              <TextInput label="رمز الاستعادة" ltr {...f.bind('recoveryCode')} onChange={(x) => f.set('recoveryCode', x)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" />
              <PasswordInput label="كلمة المرور الجديدة" value={f.values.newPassword} onChange={(x) => f.set('newPassword', x)} error={f.errors.newPassword} hint="8 أحرف على الأقل" />
            </>
          )}
          {error && (
            <Alert tone="danger">
              <span role="alert">{error}</span>
            </Alert>
          )}
          <Button type="submit" variant="primary" loading={busy} icon={<LogIn />}>
            {mode === 'login' ? 'تسجيل الدخول' : 'تعيين كلمة المرور والدخول'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setMode(mode === 'login' ? 'recover' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'نسيت كلمة مرور صاحب المكتب؟' : 'العودة لتسجيل الدخول'}
          </Button>
          {mode === 'recover' && <div className="help">حساب المستشار تُعاد كلمة مروره من صاحب المكتب (الإعدادات ← المستخدمون).</div>}
        </div>
      </form>
    </div>
  );
}

export function LockScreen() {
  const { state, refresh } = useSession();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="lock-overlay">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('auth.unlock', { password: pw });
            await refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'تعذر فتح القفل');
          } finally {
            setBusy(false);
          }
        }}
      >
        <OfficeHeader name="الجلسة مقفلة" sub={`أُقفلت بسبب الخمول. ${state?.user?.displayName ?? ''}، أدخل كلمة المرور للمتابعة.`} />
        <div className="stack g2">
          <PasswordInput label="كلمة المرور" value={pw} onChange={setPw} autoFocus error={error ?? undefined} />
          <Button type="submit" variant="primary" loading={busy} icon={<Lock />}>
            فتح القفل
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await api('auth.logout', {}).catch(() => undefined);
              await refresh();
            }}
          >
            تسجيل الخروج والدخول بحساب آخر
          </Button>
        </div>
      </form>
    </div>
  );
}
