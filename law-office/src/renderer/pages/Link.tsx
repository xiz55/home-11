// ربط الأجهزة بجهاز المكتب (التخزين محلي في المكتب، دون خدمة سحابية):
// - على جهاز المكتب الدائم: تشغيل «خادم المكتب»، بريد Gmail لإرسال رموز الدخول، بريد كل مستخدم، والأجهزة.
// - على الماك: ربطه بجهاز المكتب ليتزامن معه.
import { useState } from 'react';
import { Server, Link2, RefreshCw, Mail, Unlink, Smartphone, Laptop } from 'lucide-react';
import { Alert, Badge, Button, Card, DataTable, KV, Loading, TextInput, confirmAsync, toast, Ltr } from '../components/ui';
import { ApiError, api, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { When } from '../lib/display';
import { PHASE } from './Cloud';

function ServerSection() {
  const { refresh } = useSession();
  const st = useApi(() => api('hub.state', {}), []);
  const [port, setPort] = useState('8787');
  const [gUser, setGUser] = useState('');
  const [gPass, setGPass] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [emails, setEmails] = useState<Record<string, string>>({});
  if (st.loading) return <Loading />;
  const s = st.data;
  if (!s) return null;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      st.reload();
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack g2">
      <Card title="هذا الجهاز هو جهاز المكتب (الخادم)" actions={s.running ? <Badge tone="success">يعمل</Badge> : <Badge tone="neutral">متوقف</Badge>}>
        <div className="stack g2">
          <div className="help">
            يحفظ جهاز المكتب كل البيانات والمرفقات على قرصه. الماك يتزامن معه، والآيفون يدخل عبر رابط آمن. لا يُرفع شيء إلى خدمة تخزين خارجية. أبقِ هذا الجهاز يعمل ومتصلًا بالإنترنت.
          </div>
          {!s.running ? (
            <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
              <TextInput label="المنفذ" ltr value={port} onChange={setPort} />
              <Button variant="primary" icon={<Server />} loading={busy} onClick={() => run(() => api('hub.enable', { port: Number(port) || 8787 }), 'شُغّل خادم المكتب')}>
                تشغيل خادم المكتب
              </Button>
            </div>
          ) : (
            <KV
              items={[
                ['المنفذ على هذا الجهاز', <Ltr key="p">127.0.0.1:{s.port}</Ltr>],
                ['الرابط الآمن', s.publicUrl ? <Ltr key="u">{s.publicUrl}</Ltr> : 'لم يُضبط بعد — انظر الخطوة 3'],
              ]}
            />
          )}
          {s.running && (
            <Button variant="danger" loading={busy} onClick={async () => (await confirmAsync({ title: 'إيقاف خادم المكتب', message: 'لن يتمكن الماك والآيفون من الاتصال حتى تشغّله مجددًا. البيانات لا تُحذف.', confirmLabel: 'إيقاف' })) && run(() => api('hub.disable', {}))}>
              إيقاف الخادم
            </Button>
          )}
        </div>
      </Card>

      <Card title="1) بريد Gmail لإرسال رموز الدخول">
        <div className="stack g2">
          <div className="help">
            من حساب Google: الأمان ← التحقق بخطوتين (فعّله) ← «كلمات مرور التطبيقات» ← أنشئ كلمة مرور للتطبيق (16 حرفًا) والصقها هنا. لا تستخدم كلمة مرور Gmail نفسها. تُحفظ مشفرة بمخزن ويندوز الآمن.
          </div>
          <div className="help">{s.gmailConfigured ? <Badge tone="success">مضبوط: {s.gmailUser}</Badge> : <Badge tone="warning">غير مضبوط</Badge>}</div>
          <TextInput label="عنوان Gmail" ltr value={gUser} onChange={setGUser} placeholder="office@gmail.com" />
          <TextInput label="كلمة مرور التطبيق من Google" ltr type="password" value={gPass} onChange={setGPass} />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button variant="primary" icon={<Mail />} loading={busy} onClick={() => run(() => api('hub.setGmail', { user: gUser, appPassword: gPass }), 'حُفظ البريد')}>
              حفظ
            </Button>
            <Button loading={busy} disabled={!s.gmailConfigured} onClick={() => run(() => api('hub.sendTest', { to: s.gmailUser! }), `أُرسلت رسالة تجربة إلى ${s.gmailUser}`)}>
              إرسال رسالة تجربة
            </Button>
          </div>
        </div>
      </Card>

      <Card title="2) بريد كل مستخدم (تصله رموز الدخول)">
        <DataTable
          rows={s.users}
          rowKey={(u) => u.id}
          columns={[
            { key: 'n', header: 'المستخدم', render: (u) => u.display_name },
            {
              key: 'e',
              header: 'البريد',
              render: (u) => (
                <input className="input ltr-input" dir="ltr" defaultValue={u.email ?? ''} placeholder="name@gmail.com" onChange={(e) => setEmails((m) => ({ ...m, [u.id]: e.target.value }))} aria-label={`بريد ${u.display_name}`} />
              ),
            },
            {
              key: 'a',
              header: '',
              className: 'actions',
              render: (u) => (
                <Button size="sm" onClick={() => run(() => api('hub.setUserEmail', { userId: u.id, email: (emails[u.id] ?? u.email ?? '').trim() || null }), 'حُفظ البريد')}>
                  حفظ
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title="3) الرابط الآمن من خارج المكتب (Tailscale)">
        <div className="stack g2">
          <ol className="help" style={{ paddingInlineStart: 18, lineHeight: 2 }}>
            <li>ثبّت Tailscale على هذا الجهاز من tailscale.com وسجّل الدخول (الخطة الشخصية مجانية).</li>
            <li>
              افتح «موجّه الأوامر» بصلاحية المسؤول واكتب: <Ltr>tailscale funnel --bg {s.port}</Ltr>
            </li>
            <li>سيظهر رابط يبدأ بـ https وينتهي بـ ts.net — الصقه هنا. هذا الرابط تفتحه من الآيفون، وتستخدمه لربط الماك.</li>
          </ol>
          <TextInput label="الرابط الآمن" ltr value={url} onChange={setUrl} placeholder="https://office-pc.tail1234.ts.net" />
          <Button onClick={() => run(() => api('hub.setPublicUrl', { url: url.trim() || null }), 'حُفظ الرابط')}>حفظ الرابط</Button>
        </div>
      </Card>

      <Card title="الأجهزة المرتبطة">
        <DataTable
          rows={s.devices}
          rowKey={(d) => d.id}
          empty="لا توجد أجهزة مرتبطة بعد"
          columns={[
            { key: 'n', header: 'الجهاز', render: (d) => <span className="row" style={{ gap: 6 }}>{d.kind === 'web' ? <Smartphone size={16} /> : <Laptop size={16} />}{d.name}</span> },
            { key: 'k', header: 'النوع', render: (d) => (d.kind === 'web' ? 'رابط آمن' : 'مزامنة') },
            { key: 'u', header: 'المستخدم', render: (d) => d.user_name },
            { key: 'l', header: 'آخر نشاط', render: (d) => (d.last_seen ? <When at={d.last_seen} /> : '—') },
            { key: 't', header: 'دون رمز حتى', render: (d) => (d.kind === 'web' && d.trusted_until && !d.revoked_at ? <When at={d.trusted_until} /> : '—') },
            {
              key: 'r',
              header: '',
              className: 'actions',
              render: (d) =>
                d.revoked_at ? (
                  <Badge tone="danger">أُلغي</Badge>
                ) : (
                  <Button size="sm" variant="danger" onClick={async () => (await confirmAsync({ title: 'إلغاء هذا الجهاز', message: `يُمنع «${d.name}» فورًا من أي وصول جديد. ما نُزّل سابقًا على جهاز غير متصل لا يمكن محوه عن بُعد.`, confirmLabel: 'إلغاء الجهاز' })) && run(() => api('hub.revokeDevice', { id: d.id }), 'أُلغي الجهاز')}>
                    إلغاء
                  </Button>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function ClientSection() {
  const { refresh } = useSession();
  const st = useApi(() => api('hub.clientState', {}), []);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ch, setCh] = useState<{ challengeId: string; sentTo: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (st.loading) return <Loading />;
  const s = st.data!;
  if (s.linked) {
    const status = s.status;
    return (
      <Card
        title="هذا الجهاز مرتبط بجهاز المكتب"
        actions={
          <Button icon={<RefreshCw />} loading={busy} onClick={async () => { setBusy(true); try { await api('hub.syncNow', {}); invalidate(); st.reload(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>
            مزامنة الآن
          </Button>
        }
      >
        <div className="stack g2">
          <KV
            items={[
              ['جهاز المكتب', <Ltr key="u">{s.url}</Ltr>],
              ['الحالة', status ? <Badge key="p" tone={PHASE[status.phase]?.tone ?? 'neutral'}>{PHASE[status.phase]?.label ?? status.phase}</Badge> : '—'],
              ['تغييرات معلقة', <Ltr key="q">{status?.pending ?? 0}</Ltr>],
              ['آخر مزامنة ناجحة', status?.lastSyncAt ? <When key="l" at={status.lastSyncAt} /> : 'لم تتم بعد'],
            ]}
          />
          <Button variant="danger" icon={<Unlink />} onClick={async () => { if (await confirmAsync({ title: 'فك الربط', message: 'يتوقف هذا الجهاز عن المزامنة مع جهاز المكتب. تبقى بياناته الحالية عليه.', confirmLabel: 'فك الربط' })) { await api('hub.unlink', {}); st.reload(); void refresh(); } }}>
            فك ربط هذا الجهاز
          </Button>
        </div>
      </Card>
    );
  }
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!ch) setCh(await api('hub.linkStart', { url, username, password }));
      else {
        if (!(await confirmAsync({ title: 'استبدال بيانات هذا الجهاز', message: 'تُؤخذ نسخة احتياطية كاملة من بيانات هذا الجهاز أولًا وتبقى محفوظة عليه، ثم تُستبدل ببيانات جهاز المكتب. بعدها تدخل بحسابك في المكتب.', confirmLabel: 'ربط واستبدال' }))) return;
        const r = await api('hub.linkVerify', { url: ch.url, challengeId: ch.challengeId, code });
        toast.success(`رُبط الجهاز بمكتب «${r.officeName}». النسخة الاحتياطية السابقة: ${r.backupFile}`);
        await refresh();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="ربط هذا الجهاز بجهاز المكتب">
      <form className="stack g2" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        {!ch ? (
          <>
            <div className="help">للماك أو أي جهاز آخر لصاحب المكتب: يحتفظ بنسخة كاملة ويعمل دون إنترنت، ويُرسل كل تعديل إلى جهاز المكتب ويستلم تعديلاته.</div>
            <TextInput label="الرابط الآمن لجهاز المكتب" ltr value={url} onChange={setUrl} placeholder="https://office-pc.tail1234.ts.net" autoFocus />
            <TextInput label="اسم المستخدم في المكتب" ltr value={username} onChange={setUsername} />
            <TextInput label="كلمة المرور" type="password" ltr value={password} onChange={setPassword} />
          </>
        ) : (
          <>
            <Alert tone="info">أُرسل رمز تحقق إلى {ch.sentTo}.</Alert>
            <TextInput label="رمز التحقق (6 أرقام)" ltr value={code} onChange={setCode} autoFocus />
          </>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
        <Button type="submit" variant="primary" icon={<Link2 />} loading={busy}>
          {ch ? 'تحقق واربط' : 'متابعة'}
        </Button>
      </form>
    </Card>
  );
}

export function LinkTab() {
  const { isOwner, state } = useSession();
  const st = state as { hubLinked?: boolean; hubServer?: boolean } | null;
  if (!isOwner) return <Alert tone="neutral">ربط الأجهزة يضبطه صاحب المكتب.</Alert>;
  if (st?.hubLinked) return <ClientSection />;
  if (st?.hubServer) return <ServerSection />;
  return (
    <div className="stack g2">
      <Alert tone="info">اختر دور هذا الجهاز: جهاز المكتب الذي يبقى يعمل ويحفظ البيانات، أو جهاز يرتبط به (مثل الماك).</Alert>
      <ServerSection />
      <ClientSection />
    </div>
  );
}
