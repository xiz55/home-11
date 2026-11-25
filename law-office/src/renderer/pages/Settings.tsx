import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderOpen, HardDriveDownload, HardDriveUpload, KeyRound, Plus, ShieldCheck, UserPlus, Pencil, Users, PlugZap, Ban, FileArchive } from 'lucide-react';
import { Alert, Badge, Button, Card, Checkbox, Collapsible, DataTable, ErrorBox, KV, Loading, Modal, StatusBadge, Tabs, TextArea, TextInput, confirmAsync, toast, Ltr } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi, useForm } from '../lib/hooks';
import { useSession, useOs } from '../lib/session';
import { CloudTab } from './Cloud';
import { isIOS } from '../lib/platform';
import { When } from '../lib/display';
import { LOOKUP_LISTS, LOOKUP_LIST_KEYS, PERMISSIONS, ROLES, type LookupListKey, type Permission } from '../../shared/constants';
import { fmtDateTime } from '../../shared/dates';
import { ChangePasswordForm, IntegrationTokenForm, ResetPasswordForm, UserAccessForm, UserForm } from './settingsForms';
import { fmtSize } from '../forms/docs';
import type { MethodOutput } from '../../main/ipc/registry';
import { RecoveryCodeNotice } from './Auth';

type Tab = 'office' | 'users' | 'lists' | 'reminders' | 'storage' | 'cloud' | 'integration' | 'activity' | 'account';

export function SettingsPage() {
  const { isOwner, state } = useSession();
  const cloudLinked = !!(state as { cloudLinked?: boolean } | null)?.cloudLinked;
  const [sp, setSp] = useSearchParams();
  const tab = ((sp.get('tab') as Tab) ?? (isOwner ? 'office' : 'account')) as Tab;
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>الإعدادات</h1>
          <div className="sub">{isOwner ? 'بيانات المكتب والمستخدمون والقوائم ومكان الحفظ والنسخ الاحتياطي' : 'إعدادات حسابك'}</div>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'office', label: 'بيانات المكتب', hidden: !isOwner },
          { key: 'users', label: 'المستخدمون والصلاحيات', hidden: !isOwner },
          { key: 'lists', label: 'القوائم الافتراضية', hidden: !isOwner },
          { key: 'reminders', label: 'التنبيهات والأمان', hidden: !isOwner },
          { key: 'storage', label: 'مكان الحفظ والنسخ الاحتياطي', hidden: !isOwner || isIOS() },
          { key: 'cloud', label: 'الحساب السحابي والمزامنة', hidden: !isOwner && !cloudLinked },
          { key: 'integration', label: 'الربط بأدوات الذكاء الاصطناعي', hidden: !isOwner || isIOS() },
          { key: 'activity', label: 'سجل الأنشطة', hidden: !isOwner },
          { key: 'account', label: 'حسابي' },
        ]}
      />
      {tab === 'office' && isOwner && <OfficeTab />}
      {tab === 'users' && isOwner && <UsersTab />}
      {tab === 'lists' && isOwner && <ListsTab />}
      {tab === 'reminders' && isOwner && <RemindersTab />}
      {tab === 'storage' && isOwner && <StorageTab />}
      {tab === 'cloud' && <CloudTab />}
      {tab === 'integration' && isOwner && <IntegrationTab />}
      {tab === 'activity' && isOwner && <ActivityTab />}
      {tab === 'account' && <AccountTab />}
    </div>
  );
}

function OfficeTab() {
  const q = useApi(() => api('settings.get', {}), []);
  const { refresh } = useSession();
  if (q.loading && !q.data) return <Loading />;
  return <OfficeForm initial={q.data as Record<string, unknown>} onSaved={() => void refresh()} />;
}

function OfficeForm({ initial, onSaved }: { initial: Record<string, unknown>; onSaved: () => void }) {
  const f = useForm({
    name: String(initial['office.name'] ?? ''),
    phone: String(initial['office.phone'] ?? ''),
    email: String(initial['office.email'] ?? ''),
    address: String(initial['office.address'] ?? ''),
    license: String(initial['office.license'] ?? ''),
    footer: String(initial['reports.footer'] ?? ''),
  });
  const [busy, setBusy] = useState(false);
  return (
    <Card title="بيانات المكتب" sub="يظهر الاسم في رأس البرنامج وشاشة الدخول والتقارير">
      <div className="form-grid">
        <TextInput className="full" label="اسم المكتب" required {...f.bind('name')} onChange={(x) => f.set('name', x)} error={f.errors['office.name']} />
        <TextInput label="الهاتف" ltr {...f.bind('phone')} onChange={(x) => f.set('phone', x)} />
        <TextInput label="البريد" ltr {...f.bind('email')} onChange={(x) => f.set('email', x)} />
        <TextInput label="العنوان" {...f.bind('address')} onChange={(x) => f.set('address', x)} />
        <TextInput label="رقم الترخيص (اختياري)" ltr {...f.bind('license')} onChange={(x) => f.set('license', x)} />
        <TextArea className="full" label="تذييل التقارير (اختياري)" {...f.bind('footer')} onChange={(x) => f.set('footer', x)} rows={2} />
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <Button
          variant="primary"
          loading={busy}
          disabled={!f.dirty}
          onClick={async () => {
            setBusy(true);
            try {
              await api('settings.update', { 'office.name': f.values.name, 'office.phone': f.values.phone || null, 'office.email': f.values.email || null, 'office.address': f.values.address || null, 'office.license': f.values.license || null, 'reports.footer': f.values.footer || null } as never);
              f.reset(f.values);
              toast.success('حُفظت بيانات المكتب');
              onSaved();
            } catch (e) {
              if (e instanceof ApiError) f.setErrors(e.fields);
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          حفظ
        </Button>
      </div>
    </Card>
  );
}

type User = MethodOutput<'users.list'>[number];
function UsersTab() {
  const q = useApi(() => api('users.list', {}), []);
  const [modal, setModal] = useState<null | { k: 'new' } | { k: 'edit' | 'access' | 'reset'; u: User }>(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="stack g2">
      <Alert tone="info">
        الحسابات محلية على هذا الجهاز فقط ولا توجد مزامنة بين أجهزة مختلفة. يعمل المستشار على هذا الجهاز بحسابه. صلاحيات المستشار الافتراضية: إعداد وتحديث الملفات المسندة إليه فقط.
      </Alert>
      <Card title="المستخدمون" flush actions={<Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setModal({ k: 'new' })}>إضافة مستشار</Button>}>
        <DataTable
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: 'الاسم', sortValue: (r) => r.displayName, render: (r) => <div><div style={{ fontWeight: 500 }}>{r.displayName}</div><div className="sub"><Ltr>{r.username}</Ltr></div></div> },
            { key: 'r', header: 'الدور', render: (r) => <StatusBadge map={ROLES} value={r.role} /> },
            { key: 's', header: 'الحالة', render: (r) => (r.active ? <Badge tone="success" dot>نشط</Badge> : <Badge tone="neutral" dot>موقوف</Badge>) },
            { key: 'p', header: 'الصلاحيات الإضافية', render: (r) => (r.role === 'owner' ? 'كل الصلاحيات' : r.permissions.length ? <div className="chip-list">{r.permissions.map((p) => <Badge key={p} tone="outline">{PERMISSIONS[p as Permission]}</Badge>)}</div> : 'الافتراضية') },
            { key: 'f', header: 'الملفات المسموحة', render: (r) => (r.role === 'owner' ? 'الكل' : `${r.caseCount} قضية، ${r.clientCount} عميل`) },
            { key: 'l', header: 'آخر دخول', render: (r) => <When at={r.lastLoginAt} /> },
            {
              key: 'a',
              header: '',
              className: 'actions',
              render: (r) =>
                r.role === 'owner' ? null : (
                  <div className="row">
                    <Button size="sm" icon={<Pencil />} onClick={() => setModal({ k: 'edit', u: r })}>تعديل</Button>
                    <Button size="sm" icon={<Users />} onClick={() => setModal({ k: 'access', u: r })}>الملفات</Button>
                    <Button size="sm" icon={<KeyRound />} onClick={() => setModal({ k: 'reset', u: r })}>كلمة مرور</Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>
      {modal?.k === 'new' && <UserForm onClose={() => { setModal(null); q.reload(); }} />}
      {modal?.k === 'edit' && <UserForm initial={modal.u} onClose={() => { setModal(null); q.reload(); }} />}
      {modal?.k === 'access' && <UserAccessForm user={modal.u} onClose={() => { setModal(null); q.reload(); }} />}
      {modal?.k === 'reset' && <ResetPasswordForm user={modal.u} onClose={() => setModal(null)} />}
    </div>
  );
}

function ListsTab() {
  const q = useApi(() => api('lookups.list', {}), []);
  const { reloadLookups } = useSession();
  const [adding, setAdding] = useState<Record<string, string>>({});
  if (q.loading && !q.data) return <Loading />;
  const add = async (k: LookupListKey) => {
    const label = (adding[k] ?? '').trim();
    if (!label) return;
    try {
      await api('lookups.add', { listKey: k, label });
      setAdding({ ...adding, [k]: '' });
      q.reload();
      reloadLookups();
    } catch (e) {
      toast.error(e);
    }
  };
  const toggle = async (id: string, active: boolean) => {
    try {
      await api('lookups.update', { id, active });
      q.reload();
      reloadLookups();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="grid c2">
      {LOOKUP_LIST_KEYS.map((k) => (
        <Card key={k} title={LOOKUP_LISTS[k].label}>
          <ul className="list-plain">
            {(q.data ?? [])
              .filter((l) => l.list_key === k)
              .map((l) => (
                <li key={l.id} className="row between">
                  <span className={l.active ? '' : 'muted'}>{l.label} {!l.active && '(موقوفة)'}</span>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(l.id, !l.active)}>{l.active ? 'إيقاف' : 'تفعيل'}</Button>
                </li>
              ))}
          </ul>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" placeholder="قيمة جديدة" value={adding[k] ?? ''} onChange={(e) => setAdding({ ...adding, [k]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add(k)} aria-label={`قيمة جديدة في ${LOOKUP_LISTS[k].label}`} />
            <Button icon={<Plus />} onClick={() => void add(k)}>إضافة</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function RemindersTab() {
  const os = useOs();
  const q = useApi(() => api('settings.get', {}), []);
  const [v, setV] = useState<{ idle: string; r24: boolean; r30: boolean; custom: string; taskTime: string; enabled: boolean; backupDays: string } | null>(null);
  useEffect(() => {
    if (q.data && !v) {
      const s = q.data as Record<string, unknown>;
      const offs = (s['reminders.hearingOffsets'] as number[]) ?? [];
      setV({
        idle: String(s['security.idleLockMinutes']),
        r24: offs.includes(1440),
        r30: offs.includes(30),
        custom: offs.filter((o) => o !== 1440 && o !== 30).join('، '),
        taskTime: String(s['reminders.taskTime'] ?? '09:00'),
        enabled: s['reminders.enabled'] !== false,
        backupDays: String(s['backup.reminderDays'] ?? 7),
      });
    }
  }, [q.data, v]);
  if (!v) return <Loading />;
  const save = async () => {
    const custom = v.custom
      .split(/[،,\s]+/)
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x >= 5);
    try {
      await api('settings.update', {
        'security.idleLockMinutes': Number(v.idle),
        'reminders.hearingOffsets': [...(v.r24 ? [1440] : []), ...(v.r30 ? [30] : []), ...custom].slice(0, 5),
        'reminders.taskTime': v.taskTime,
        'reminders.enabled': v.enabled,
        'backup.reminderDays': Number(v.backupDays),
      });
      toast.success('حُفظت الإعدادات وأعيد حساب التنبيهات');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="grid c2">
      <Card title="القفل بعد الخمول">
        <TextInput label="مدة الخمول قبل قفل الجلسة (بالدقائق)" ltr value={v.idle} onChange={(x) => setV({ ...v, idle: x })} hint="يُطلب إدخال كلمة المرور بعدها. القفل يحمي الشاشة ولا يشفّر الملفات على القرص." />
      </Card>
      <Card title="تنبيهات الجلسات والمهام">
        <div className="stack">
          <Checkbox label="تفعيل التنبيهات المحلية" checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} />
          <Checkbox label="قبل الجلسة بـ 24 ساعة" checked={v.r24} onChange={(x) => setV({ ...v, r24: x })} />
          <Checkbox label="قبل الجلسة بـ 30 دقيقة" checked={v.r30} onChange={(x) => setV({ ...v, r30: x })} />
          <TextInput label="مدد إضافية بالدقائق (اختياري)" ltr value={v.custom} onChange={(x) => setV({ ...v, custom: x })} placeholder="مثال: 120" />
          <TextInput label="وقت تذكير المهام في يوم الاستحقاق" type="time" ltr value={v.taskTime} onChange={(x) => setV({ ...v, taskTime: x })} />
          <Alert tone="neutral">التنبيهات تظهر ك{os.notifications} أثناء تشغيل البرنامج فقط، وتتطلب السماح بإشعارات البرنامج في إعدادات {os.mac ? 'النظام (الإشعارات)' : 'ويندوز'}. لا توجد رسائل واتساب أو اتصالات أو تنبيهات بعد إغلاق البرنامج كليًا. ما يفوت يُعرض عند الفتح التالي.</Alert>
        </div>
      </Card>
      <Card title="تذكير النسخ الاحتياطي">
        <TextInput label="التذكير إذا مضى على آخر نسخة (أيام)" ltr value={v.backupDays} onChange={(x) => setV({ ...v, backupDays: x })} />
      </Card>
      <div className="span-all">
        <Button variant="primary" onClick={() => void save()}>حفظ الإعدادات</Button>
      </div>
    </div>
  );
}

function StorageTab() {
  const info = useApi(() => api('system.info', {}), []);
  const st = useApi(() => api('backup.status', {}), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [restore, setRestore] = useState<Extract<MethodOutput<'backup.inspectRestore'>, { ok: true }> | null>(null);
  const [verify, setVerify] = useState<MethodOutput<'system.verifyAttachments'> | null>(null);
  const { refresh } = useSession();
  const os = useOs();
  const doBackup = async (kind: 'backup.create' | 'backup.export') => {
    setBusy(kind);
    try {
      const r = await api(kind, {});
      if (r.saved) {
        toast.success(`حُفظت الحزمة (${fmtSize(r.size)}) وتم التحقق من قراءتها`);
        if (r.sameDriveWarning) toast.info('تنبيه: الحزمة محفوظة على القرص نفسه الذي يحمل البيانات؛ انسخها إلى قرص خارجي أو جهاز آخر لحمايتها من تلف الجهاز.');
        st.reload();
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack g2">
      <Card title="مكان حفظ البيانات" actions={<Button icon={<FolderOpen />} onClick={() => void api('system.openDataFolder', {}).catch(toast.error)}>فتح المجلد</Button>}>
        {info.data && (
          <KV
            items={[
              ['مجلد البيانات', <Ltr>{info.data.dataDir}</Ltr>],
              ['قاعدة البيانات', <span>{fmtSize(info.data.dbBytes)}</span>],
              ['المرفقات', <span>{info.data.attachmentsCount} ملف — {fmtSize(info.data.attachmentsBytes)}</span>],
            ]}
          />
        )}
        <div style={{ marginTop: 12 }}>
          <Alert tone="warning">لا تنقل أو تعدّل الملفات داخل مجلد البيانات يدويًا. البيانات غير مشفرة على القرص؛ احمِ الجهاز ب{os.diskEncryption} إن أمكن.</Alert>
        </div>
        <Collapsible title="تفاصيل تقنية">
          {info.data && (
            <KV
              items={[
                ['ملف قاعدة البيانات', <Ltr>{info.data.dbFile}</Ltr>],
                ['مجلد المرفقات', <Ltr>{info.data.attachmentsDir}</Ltr>],
                ['النسخ التلقائية', <Ltr>{info.data.autoBackupsDir}</Ltr>],
                ['إصدار البرنامج', <Ltr>{info.data.appVersion}</Ltr>],
              ]}
            />
          )}
        </Collapsible>
      </Card>
      <Card title="النسخ الاحتياطي والاستعادة">
        <div className="stack g2">
          <div>
            آخر نسخة احتياطية: {st.data?.lastBackupAt ? <When at={st.data.lastBackupAt} /> : <strong>لم تُنشأ بعد</strong>} {st.data?.lastBackupPath && <div className="help">في: <Ltr>{st.data.lastBackupPath}</Ltr></div>}
          </div>
          <div className="btn-group">
            <Button variant="primary" icon={<HardDriveDownload />} loading={busy === 'backup.create'} onClick={() => void doBackup('backup.create')}>إنشاء نسخة احتياطية الآن</Button>
            <Button icon={<FileArchive />} loading={busy === 'backup.export'} onClick={() => void doBackup('backup.export')}>تصدير كامل للبيانات</Button>
            <Button
              icon={<HardDriveUpload />}
              loading={busy === 'restore'}
              onClick={async () => {
                setBusy('restore');
                try {
                  const r = await api('backup.inspectRestore', {});
                  if (!r.selected) return;
                  if (!r.ok) toast.error('رُفضت الحزمة ولم تُمس البيانات الحالية: ' + r.errors.slice(0, 3).join(' — '));
                  else setRestore(r);
                } catch (e) {
                  toast.error(e);
                } finally {
                  setBusy(null);
                }
              }}
            >
              استعادة من نسخة
            </Button>
          </div>
          <Alert tone="info">
            الحزمة ملف واحد يضم قاعدة البيانات كاملة والمرفقات وبيانًا بالبصمات، ويمكن استعادتها أو نقلها لجهاز آخر. احفظها خارج هذا الجهاز (قرص خارجي أو ذاكرة USB أو جهاز آخر)؛ النسخة على القرص نفسه لا تحمي من تلف الجهاز.
          </Alert>
          <div className="help">إضافة لذلك يحتفظ البرنامج يوميًا بلقطة تلقائية لقاعدة البيانات داخل مجلد البيانات (آخر 7 أيام) — تفيد عند الخطأ، لا عند تلف القرص.</div>
          <div>
            <Button
              size="sm"
              icon={<ShieldCheck />}
              loading={busy === 'verify'}
              onClick={async () => {
                setBusy('verify');
                try {
                  setVerify(await api('system.verifyAttachments', { hash: true }));
                } catch (e) {
                  toast.error(e);
                } finally {
                  setBusy(null);
                }
              }}
            >
              فحص سلامة المرفقات
            </Button>
            {verify && (
              <div style={{ marginTop: 8 }}>
                {verify.missing.length === 0 && verify.corrupted.length === 0 ? (
                  <Alert tone="success">كل المرفقات ({verify.total}) سليمة وتطابق بصماتها.</Alert>
                ) : (
                  <Alert tone="danger">مفقود: {verify.missing.map((x) => x.originalName).join('، ') || 'لا شيء'} — تالف: {verify.corrupted.map((x) => x.originalName).join('، ') || 'لا شيء'}. استعد آخر نسخة احتياطية سليمة.</Alert>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
      {restore && (
        <Modal
          title="تأكيد الاستعادة"
          onClose={async () => {
            await api('backup.cancelRestore', { token: restore.token }).catch(() => undefined);
            setRestore(null);
          }}
          footer={
            <>
              <Button
                variant="danger"
                className="solid"
                loading={busy === 'apply'}
                onClick={async () => {
                  setBusy('apply');
                  try {
                    const r = await api('backup.applyRestore', { token: restore.token, confirm: true });
                    setRestore(null);
                    toast.success('اكتملت الاستعادة. حُفظت نسخة من البيانات السابقة: ' + r.preRestoreBackup);
                    invalidate();
                    await refresh();
                  } catch (e) {
                    toast.error(e);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                استبدال البيانات الحالية بالنسخة
              </Button>
              <Button onClick={async () => { await api('backup.cancelRestore', { token: restore.token }).catch(() => undefined); setRestore(null); }}>إلغاء</Button>
            </>
          }
        >
          <div className="stack g2">
            <Alert tone="success">فُحصت الحزمة: البصمات وسلامة قاعدة البيانات وإصدار البنية ووجود كل المرفقات سليمة.</Alert>
            <KV
              items={[
                ['الملف', <Ltr>{restore.fileName}</Ltr>],
                ['تاريخ النسخة', <When at={restore.manifest.createdAt} />],
                ['اسم المكتب في النسخة', restore.manifest.officeName],
                ['العملاء / القضايا', `${restore.manifest.counts.clients ?? 0} / ${restore.manifest.counts.cases ?? 0}`],
                ['المستندات / المرفقات', `${restore.manifest.counts.documents ?? 0} / ${restore.manifest.attachments}`],
              ]}
            />
            <Alert tone="warning">ستُستبدل كل البيانات الحالية بمحتوى النسخة. يأخذ البرنامج قبل ذلك نسخة تلقائية من الحالة الحالية. بعد الاستعادة يلزم تسجيل الدخول بحسابات النسخة المستعادة.</Alert>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IntegrationTab() {
  const q = useApi(() => api('integration.state', {}), []);
  const log = useApi(() => api('integration.accessLog', {}), []);
  const [ack, setAck] = useState(false);
  const [tokenForm, setTokenForm] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  return (
    <div className="stack g2">
      <Card title="الربط الاختياري عبر MCP (قراءة فقط)" sub="البرنامج يعمل كاملًا دون ذكاء اصطناعي. هذه الوحدة غير مفعلة افتراضيًا.">
        <div className="stack g2">
          <div className="row">
            الحالة: {s.enabled ? <Badge tone="success" dot>مفعّل منذ {s.enabledAt ? fmtDateTime(s.enabledAt) : ''}</Badge> : <Badge tone="neutral" dot>غير مفعّل</Badge>}
          </div>
          <Alert tone="warning">
            عند تفعيل الربط واستخدامه من أداة مثل Claude Code أو Codex، فإن النص الذي تسمح به قد يُرسل إلى مزود الذكاء الاصطناعي الخارجي لمعالجته — هذه المعالجة ليست محلية. البرنامج نفسه لا يرسل شيئًا تلقائيًا ولا يفتح أي منفذ شبكة؛ الأداة تشغّل خادم القراءة محليًا عبر stdio بالرمز الذي تصدره هنا. قفل جلسة البرنامج لا يغني عن مصادقة الربط.
          </Alert>
          {!s.enabled ? (
            <>
              <Checkbox label="فهمت أن النص المسموح قد يُرسل إلى مزود خارجي عند استخدامي للأداة، وأتحمل اختيار ما أسمح به" checked={ack} onChange={setAck} />
              <div>
                <Button
                  variant="primary"
                  icon={<PlugZap />}
                  disabled={!ack}
                  onClick={async () => {
                    try {
                      await api('integration.setEnabled', { enabled: true, acknowledged: ack });
                      q.reload();
                    } catch (e) {
                      toast.error(e);
                    }
                  }}
                >
                  تفعيل وحدة التكامل
                </Button>
              </div>
            </>
          ) : (
            <div className="btn-group">
              <Button variant="primary" icon={<KeyRound />} onClick={() => setTokenForm(true)}>إصدار رمز ربط</Button>
              <Button
                icon={<Ban />}
                onClick={async () => {
                  if (!(await confirmAsync({ title: 'تعطيل التكامل', message: 'يتوقف كل وصول عبر الربط فورًا (تبقى الرموز مسجلة ويمكن إلغاؤها).', confirmLabel: 'تعطيل' }))) return;
                  await api('integration.setEnabled', { enabled: false });
                  q.reload();
                }}
              >
                تعطيل التكامل
              </Button>
            </div>
          )}
        </div>
      </Card>
      <Card title="رموز الربط" flush>
        <DataTable
          rows={s.tokens}
          rowKey={(r) => r.id}
          empty="لا توجد رموز"
          columns={[
            { key: 'n', header: 'الاسم', render: (r) => <div><div>{r.name}</div><div className="sub">…<Ltr>{r.hint}</Ltr></div></div> },
            { key: 's', header: 'النطاق', render: (r) => <div className="help">{[...r.clientNames, ...r.caseLabels].join('، ')}</div> },
            { key: 't', header: 'نصوص المستندات', render: (r) => (r.allowDocumentText ? <Badge tone="warning">مسموحة</Badge> : <Badge>غير مسموحة</Badge>) },
            { key: 'e', header: 'الانتهاء', render: (r) => r.expiresOn ?? '—' },
            { key: 'st', header: 'الحالة', render: (r) => (r.revokedAt ? <Badge tone="neutral">ملغى</Badge> : <Badge tone="success">ساري</Badge>) },
            {
              key: 'a',
              header: '',
              className: 'actions',
              render: (r) =>
                !r.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (!(await confirmAsync({ title: 'إلغاء الرمز', message: `إلغاء «${r.name}» يوقف وصوله فورًا.`, confirmLabel: 'إلغاء الرمز', danger: true }))) return;
                      await api('integration.revokeToken', { id: r.id });
                      q.reload();
                    }}
                  >
                    إلغاء
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      <Card title="سجل وصول الربط" flush>
        <DataTable
          rows={log.data ?? []}
          rowKey={(r) => r.id}
          bounded
          empty="لا يوجد وصول مسجل"
          columns={[
            { key: 'at', header: 'الوقت', render: (r) => <When at={r.at} /> },
            { key: 't', header: 'الرمز', render: (r) => r.tokenName ?? '—' },
            { key: 'tool', header: 'الأداة', render: (r) => <Ltr>{r.tool}</Ltr> },
            { key: 'a', header: 'النتيجة', render: (r) => (r.allowed ? <Badge tone="success">مسموح</Badge> : <Badge tone="danger">مرفوض: {r.error}</Badge>) },
          ]}
        />
      </Card>
      {tokenForm && <IntegrationTokenForm onClose={() => { setTokenForm(false); q.reload(); }} />}
    </div>
  );
}

function ActivityTab() {
  const q = useApi(() => api('activity.list', { limit: 500 }), []);
  const [search, setSearch] = useState('');
  return (
    <Card title="سجل الأنشطة" sub="الإضافة والتعديل والأرشفة وتغيير الحالات والاستعادة — بالمستخدم والوقت والعنصر" flush>
      <div className="toolbar">
        <input className="input search-input" placeholder="تصفية السجل…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="تصفية السجل" />
      </div>
      {q.loading && !q.data ? (
        <Loading />
      ) : (
        <DataTable
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          search={search}
          bounded
          columns={[
            { key: 'at', header: 'الوقت', sortValue: (r) => r.at, render: (r) => <When at={r.at} /> },
            { key: 'u', header: 'المستخدم', sortValue: (r) => r.username ?? '', render: (r) => <Ltr>{r.username}</Ltr> },
            { key: 'a', header: 'الإجراء', sortValue: (r) => r.action, searchValue: (r) => r.action },
            { key: 's', header: 'التفاصيل', sortValue: (r) => r.summary, searchValue: (r) => r.summary },
          ]}
        />
      )}
    </Card>
  );
}

function AccountTab() {
  const { state, isOwner } = useSession();
  const [pw, setPw] = useState(false);
  const [rc, setRc] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const f = useForm({ password: '' });
  if (code) return <RecoveryCodeNotice code={code} onDone={() => setCode(null)} />;
  return (
    <div className="grid c2">
      <Card title="حسابي">
        <KV items={[['الاسم', state?.user?.displayName], ['اسم المستخدم', <Ltr>{state?.user?.username}</Ltr>], ['الدور', state?.user ? ROLES[state.user.role].label : '']]} />
        <div className="btn-group" style={{ marginTop: 16 }}>
          <Button icon={<KeyRound />} onClick={() => setPw(true)}>تغيير كلمة المرور</Button>
          <Button onClick={() => void api('system.openGuide', {}).then((r) => !r.ok && toast.error(r.message ?? 'تعذر فتح الدليل'), toast.error)}>فتح دليل الاستخدام</Button>
        </div>
      </Card>
      {isOwner && (
        <Card title="استعادة وصول صاحب المكتب">
          <p className="long-text">
            إذا نسيت كلمة المرور: في شاشة الدخول اختر «نسيت كلمة مرور صاحب المكتب؟» وأدخل رمز الاستعادة الذي ظهر عند إنشاء الحساب. إن فقدت الرمز، أصدر رمزًا جديدًا الآن (يُلغى السابق) واحفظه مطبوعًا في مكان آمن.
          </p>
          <Button onClick={() => setRc(true)}>إصدار رمز استعادة جديد</Button>
          {rc && (
            <Modal
              title="إصدار رمز استعادة جديد"
              size="narrow"
              onClose={() => setRc(false)}
              footer={
                <Button
                  variant="primary"
                  onClick={async () => {
                    try {
                      const r = await api('auth.regenerateRecoveryCode', { password: f.values.password });
                      setRc(false);
                      setCode(r.recoveryCode);
                    } catch (e) {
                      if (e instanceof ApiError) f.setErrors(e.fields);
                      toast.error(e);
                    }
                  }}
                >
                  إصدار
                </Button>
              }
            >
              <TextInput label="كلمة المرور الحالية للتأكيد" type="password" ltr {...f.bind('password')} onChange={(x) => f.set('password', x)} />
            </Modal>
          )}
        </Card>
      )}
      {pw && <ChangePasswordForm onClose={() => setPw(false)} />}
    </div>
  );
}
