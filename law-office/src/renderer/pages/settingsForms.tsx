import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { Alert, Button, Checkbox, DateInput, Modal, TextInput, toast, Ltr } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { PERMISSIONS, type Permission, DEFAULT_CONSULTANT_PERMISSIONS } from '../../shared/constants';
import { FormModal, save } from '../forms/common';
import type { MethodOutput } from '../../main/ipc/registry';

export function ChangePasswordForm({ onClose }: { onClose: () => void }) {
  const f = useForm({ currentPassword: '', newPassword: '', confirm: '' });
  return (
    <FormModal
      title="تغيير كلمة المرور"
      size="narrow"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        if (f.values.newPassword !== f.values.confirm) {
          f.setErrors({ confirm: 'كلمتا المرور غير متطابقتين' });
          return;
        }
        const r = await save(f, () => api('auth.changePassword', { currentPassword: f.values.currentPassword, newPassword: f.values.newPassword }), 'تغيرت كلمة المرور');
        if (r) onClose();
      }}
    >
      <div className="stack g2">
        <TextInput label="كلمة المرور الحالية" type="password" ltr {...f.bind('currentPassword')} onChange={(x) => f.set('currentPassword', x)} />
        <TextInput label="كلمة المرور الجديدة" type="password" ltr {...f.bind('newPassword')} onChange={(x) => f.set('newPassword', x)} hint="8 أحرف على الأقل" />
        <TextInput label="تأكيد كلمة المرور الجديدة" type="password" ltr {...f.bind('confirm')} onChange={(x) => f.set('confirm', x)} />
      </div>
    </FormModal>
  );
}

type User = MethodOutput<'users.list'>[number];

export function UserForm({ initial, onClose }: { initial?: User; onClose: () => void }) {
  const f = useForm({ displayName: initial?.displayName ?? '', username: initial?.username ?? '', password: '', active: initial?.active ?? true, permissions: (initial?.permissions ?? DEFAULT_CONSULTANT_PERMISSIONS) as Permission[] });
  const isOwnerUser = initial?.role === 'owner';
  return (
    <FormModal
      title={initial ? 'تعديل الحساب' : 'إضافة حساب مستشار'}
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const v = f.values;
        const r = initial
          ? await save(f, () => api('users.update', { id: initial.id, displayName: v.displayName, active: v.active, permissions: v.permissions }), 'حُفظ الحساب')
          : await save(f, () => api('users.create', { displayName: v.displayName, username: v.username, password: v.password, permissions: v.permissions }), 'أُنشئ حساب المستشار — حدّد الملفات المسموحة له');
        if (r) onClose();
      }}
    >
      <div className="form-grid">
        <TextInput label="الاسم" required {...f.bind('displayName')} onChange={(x) => f.set('displayName', x)} />
        <TextInput label="اسم المستخدم" required ltr {...f.bind('username')} onChange={(x) => f.set('username', x)} disabled={!!initial} />
        {!initial && <TextInput label="كلمة المرور المؤقتة" type="password" required ltr {...f.bind('password')} onChange={(x) => f.set('password', x)} hint="أبلغها للمستشار ليغيرها بعد الدخول" />}
        {initial && !isOwnerUser && (
          <div className="full">
            <Checkbox label="الحساب نشط" checked={f.values.active} onChange={(x) => f.set('active', x)} hint="إيقاف الحساب ينهي جلسته فورًا دون حذف أي بيانات" />
          </div>
        )}
        {!isOwnerUser && (
          <fieldset className="full">
            <legend>صلاحيات إضافية</legend>
            <div className="help" style={{ marginBottom: 8 }}>الافتراضي: إعداد وتحديث الملفات المسندة فقط، دون إدارة المستخدمين أو النسخ الاحتياطية أو الأتعاب.</div>
            <div className="grid c2">
              {(Object.keys(PERMISSIONS) as Permission[]).map((p) => (
                <Checkbox key={p} label={PERMISSIONS[p]} checked={f.values.permissions.includes(p)} onChange={(x) => f.set('permissions', x ? [...f.values.permissions, p] : f.values.permissions.filter((q) => q !== p))} />
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </FormModal>
  );
}

export function ResetPasswordForm({ user, onClose }: { user: User; onClose: () => void }) {
  const f = useForm({ newPassword: '' });
  return (
    <FormModal
      title={`كلمة مرور جديدة لـ ${user.displayName}`}
      size="narrow"
      onClose={onClose}
      dirty={f.dirty}
      onSubmit={async () => {
        const r = await save(f, () => api('users.resetPassword', { id: user.id, newPassword: f.values.newPassword }), 'عُيّنت كلمة مرور جديدة');
        if (r) onClose();
      }}
    >
      <TextInput label="كلمة المرور الجديدة" type="password" ltr {...f.bind('newPassword')} onChange={(x) => f.set('newPassword', x)} hint="8 أحرف على الأقل" />
    </FormModal>
  );
}

function SelectionList({ title, items, selected, onChange, hint }: { title: string; items: { id: string; label: string; sub?: string }[]; selected: string[]; onChange: (s: string[]) => void; hint?: string }) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => !q || (i.label + (i.sub ?? '')).includes(q));
  return (
    <div className="field">
      <span className="label">{title}</span>
      {hint && <div className="hint">{hint}</div>}
      <input className="input" placeholder="تصفية…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="check-list">
        {shown.length === 0 ? (
          <div className="help">لا توجد عناصر</div>
        ) : (
          shown.map((i) => (
            <Checkbox key={i.id} label={<span>{i.label} {i.sub && <span className="muted small">— {i.sub}</span>}</span>} checked={selected.includes(i.id)} onChange={(x) => onChange(x ? [...selected, i.id] : selected.filter((s) => s !== i.id))} />
          ))
        )}
      </div>
      <div className="hint">المحدد: {selected.length}</div>
    </div>
  );
}

export function UserAccessForm({ user, onClose }: { user: User; onClose: () => void }) {
  const access = useApi(() => api('users.getAccess', { userId: user.id }), [user.id]);
  const cases = useApi(() => api('cases.options', {}), []);
  const clients = useApi(() => api('clients.options', {}), []);
  const [caseIds, setCaseIds] = useState<string[] | null>(null);
  const [clientIds, setClientIds] = useState<string[] | null>(null);
  const ci = caseIds ?? access.data?.caseIds ?? [];
  const cli = clientIds ?? access.data?.clientIds ?? [];
  const dirty = caseIds !== null || clientIds !== null;
  return (
    <FormModal
      title={`الملفات المسموحة لـ ${user.displayName}`}
      size="wide"
      onClose={onClose}
      dirty={dirty}
      onSubmit={async () => {
        try {
          await api('users.setAccess', { userId: user.id, caseIds: ci, clientIds: cli });
          toast.success('حُفظت الملفات المسموحة');
          onClose();
        } catch (e) {
          toast.error(e);
        }
      }}
    >
      <div className="grid c2">
        <SelectionList title="القضايا المسندة" hint="يستطيع إعدادها وتحديثها" items={(cases.data ?? []).map((c) => ({ id: c.id, label: `${c.fileNo} — ${c.title}`, sub: c.clientName }))} selected={ci} onChange={setCaseIds} />
        <SelectionList title="عملاء بوصول كامل" hint="يشمل بيانات العميل العامة ومستنداته وملاحظاته، ويتيح فتح قضايا جديدة له إن مُنح صلاحية ذلك" items={(clients.data ?? []).map((c) => ({ id: c.id, label: c.name }))} selected={cli} onChange={setClientIds} />
      </div>
    </FormModal>
  );
}

export function IntegrationTokenForm({ onClose }: { onClose: () => void }) {
  const cases = useApi(() => api('cases.options', {}), []);
  const clients = useApi(() => api('clients.options', {}), []);
  const f = useForm({ name: '', clientIds: [] as string[], caseIds: [] as string[], allowDocumentText: false, expiresOn: '' });
  const [result, setResult] = useState<MethodOutput<'integration.createToken'> | null>(null);
  const copy = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => toast.success('نُسخ'));
  };
  const snippets = useMemo(() => result?.snippets, [result]);
  if (result && snippets) {
    return (
      <Modal title="رمز الربط الجديد" size="wide" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>تم</Button>}>
        <div className="stack g2">
          <Alert tone="warning">انسخ الرمز الآن؛ لن يظهر مرة أخرى. يحفظ البرنامج بصمته فقط. يمكنك إلغاؤه في أي وقت.</Alert>
          <div className="code-box" style={{ fontSize: 14 }}>{result.token}</div>
          <div className="row"><Button size="sm" icon={<Copy />} onClick={() => copy(result.token)}>نسخ الرمز</Button></div>
          <h3>إعداد Claude Code (أمر سطر الأوامر)</h3>
          <pre className="snippet">{snippets.claudeCli}</pre>
          <div className="row"><Button size="sm" icon={<Copy />} onClick={() => copy(snippets.claudeCli)}>نسخ</Button></div>
          <h3>أو ملف ‎.mcp.json لمشروع Claude Code</h3>
          <pre className="snippet">{snippets.claudeJson}</pre>
          <div className="row"><Button size="sm" icon={<Copy />} onClick={() => copy(snippets.claudeJson)}>نسخ</Button></div>
          <h3>إعداد Codex (ملف ‎~/.codex/config.toml)</h3>
          <pre className="snippet">{snippets.codexToml}</pre>
          <div className="row"><Button size="sm" icon={<Copy />} onClick={() => copy(snippets.codexToml)}>نسخ</Button></div>
          <h3>أو بأمر Codex</h3>
          <pre className="snippet">{snippets.codexCli}</pre>
          <div className="row"><Button size="sm" icon={<Copy />} onClick={() => copy(snippets.codexCli)}>نسخ</Button></div>
          <div className="help">الخطوات التفصيلية في دليل «ربط أدوات الذكاء الاصطناعي» المرفق مع البرنامج. لا يغيّر البرنامج إعدادات أي أداة تلقائيًا.</div>
        </div>
      </Modal>
    );
  }
  return (
    <FormModal
      title="إصدار رمز ربط للقراءة فقط"
      size="wide"
      onClose={onClose}
      dirty={f.dirty}
      submitLabel="إصدار الرمز"
      onSubmit={async () => {
        try {
          const r = await api('integration.createToken', { name: f.values.name, clientIds: f.values.clientIds, caseIds: f.values.caseIds, allowDocumentText: f.values.allowDocumentText, expiresOn: f.values.expiresOn || null });
          setResult(r);
        } catch (e) {
          if (e instanceof ApiError) f.setErrors(e.fields);
          toast.error(e);
        }
      }}
    >
      <div className="stack g2">
        <div className="form-grid">
          <TextInput label="اسم الربط" required {...f.bind('name')} onChange={(x) => f.set('name', x)} placeholder="مثال: Claude Code على جهاز المكتب" />
          <DateInput label="ينتهي في (اختياري)" {...f.bind('expiresOn')} onChange={(x) => f.set('expiresOn', x)} />
        </div>
        <div className="grid c2">
          <SelectionList title="عملاء (كل قضاياهم)" items={(clients.data ?? []).map((c) => ({ id: c.id, label: c.name }))} selected={f.values.clientIds} onChange={(x) => f.set('clientIds', x)} />
          <SelectionList title="قضايا محددة" items={(cases.data ?? []).map((c) => ({ id: c.id, label: `${c.fileNo} — ${c.title}`, sub: c.clientName }))} selected={f.values.caseIds} onChange={(x) => f.set('caseIds', x)} />
        </div>
        {f.errors.caseIds && <Alert tone="danger">{f.errors.caseIds}</Alert>}
        <Checkbox label="السماح بقراءة نصوص المذكرات والنص المستخرج من المستندات" checked={f.values.allowDocumentText} onChange={(x) => f.set('allowDocumentText', x)} hint="بدونه تتاح البيانات المنظمة فقط (الملخصات والمواعيد وقوائم المستندات)" />
        <Alert tone="info">الرمز يمنح قراءة فقط لما اخترته. لا كتابة ولا حذف ولا SQL ولا وصول لملفات الجهاز. <Ltr>stdio</Ltr> محلي دون أي منفذ شبكة.</Alert>
      </div>
    </FormModal>
  );
}
