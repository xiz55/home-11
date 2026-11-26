import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Building2,
  Briefcase,
  CalendarDays,
  ListChecks,
  FileText,
  Wallet,
  BarChart3,
  Settings,
  Search,
  Plus,
  ChevronsRight,
  ChevronsLeft,
  UserRound,
  LogOut,
  Lock,
  KeyRound,
  Scale,
  BellRing,
  UserPlus,
  Gavel,
  FilePlus2,
  ScrollText,
  CalendarPlus,
  Banknote,
  ClipboardPlus,
  MessagesSquare,
  Menu,
} from 'lucide-react';
import { Button, Dropdown, Modal, Select, toast, Ltr } from './ui';
import { api, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { ClientForm, CaseForm } from '../forms/clientCase';
import { HearingForm, JudgmentForm, MemoCreateForm } from '../forms/litigation';
import { DocumentAttachForm } from '../forms/docs';
import { PaymentForm, TaskForm } from '../forms/finance';
import { useCaseLinks } from '../forms/common';
import { ChangePasswordForm } from '../pages/settingsForms';
import { ConsultationForm, MeetingForm } from '../forms/appointments';
import { CloudStatusChip } from '../pages/Cloud';
import { fmtDateTime } from '../../shared/dates';

const NAV = [
  { to: '/', label: 'الرئيسية', icon: LayoutDashboard, end: true },
  { to: '/clients', label: 'العملاء والشركات', icon: Building2 },
  { to: '/cases', label: 'القضايا', icon: Briefcase },
  { to: '/calendar', label: 'التقويم والجلسات', icon: CalendarDays },
  { to: '/appointments', label: 'الاستشارات والاجتماعات', icon: MessagesSquare },
  { to: '/tasks', label: 'المهام', icon: ListChecks },
  { to: '/documents', label: 'المستندات والمذكرات', icon: FileText },
  { to: '/fees', label: 'الأتعاب', icon: Wallet, perm: 'fees.view' as const },
  { to: '/reports', label: 'التقارير', icon: BarChart3, perm: ['reports.export', 'reports.office'] as const },
  { to: '/settings', label: 'الإعدادات', icon: Settings },
];

type QuickKind = 'client' | 'case' | 'hearing' | 'minutes' | 'memo' | 'judgment' | 'task' | 'document' | 'payment' | 'consultation' | 'meeting';

/** يختار المستخدم القضية أولًا ثم يظهر النموذج المرتبط بها. */
function CaseScoped({ kind, onClose }: { kind: 'hearing' | 'minutes' | 'memo' | 'judgment'; onClose: () => void }) {
  const navigate = useNavigate();
  const cases = useApi(() => api('cases.options', {}), []);
  const [caseId, setCaseId] = useState('');
  const [chosen, setChosen] = useState(false);
  const links = useCaseLinks(chosen ? caseId : null);
  if (!chosen || !links.data) {
    return (
      <Modal
        title="اختر القضية"
        size="narrow"
        onClose={onClose}
        footer={
          <>
            <Button variant="primary" disabled={!caseId} loading={chosen && links.loading} onClick={() => setChosen(true)}>
              متابعة
            </Button>
            <Button onClick={onClose}>إلغاء</Button>
          </>
        }
      >
        <Select label="القضية" options={(cases.data ?? []).filter((c) => !c.archived).map((c) => ({ value: c.id, label: `${c.fileNo} — ${c.title} (${c.clientName})` }))} value={caseId} onChange={setCaseId} />
      </Modal>
    );
  }
  const L = links.data;
  if (kind === 'hearing') return <HearingForm caseId={caseId} stages={L.c.stages} hearings={L.hearings} onClose={onClose} />;
  if (kind === 'judgment') return <JudgmentForm caseId={caseId} stages={L.c.stages} hearings={L.hearings} onClose={onClose} />;
  if (kind === 'memo')
    return (
      <MemoCreateForm
        caseId={caseId}
        stages={L.c.stages}
        hearings={L.hearings}
        onClose={onClose}
        onCreated={(id) => {
          onClose();
          navigate(`/cases/${caseId}/memos/${id}`);
        }}
      />
    );
  return <DocumentAttachForm defaults={{ clientId: L.c.case.clientId, caseId, category: 'minutes', title: 'ضبط جلسة' }} onClose={onClose} />;
}

function MissedReminders() {
  const { state } = useSession();
  const q = useApi(() => api('reminders.missed', {}), [state?.user?.id]);
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !q.data || q.data.length === 0) return null;
  return (
    <Modal
      title="مواعيد وتنبيهات فاتت أثناء إغلاق البرنامج"
      onClose={() => setDismissed(true)}
      footer={
        <>
          <Button
            variant="primary"
            onClick={async () => {
              await api('reminders.acknowledge', { ids: q.data!.map((r) => r.id) });
              setDismissed(true);
              invalidate();
            }}
          >
            تم الاطلاع
          </Button>
          <Button onClick={() => setDismissed(true)}>لاحقًا</Button>
        </>
      }
    >
      <p className="help">التنبيهات تعمل أثناء تشغيل البرنامج فقط. هذه التنبيهات حان وقتها والبرنامج مغلق أو صدرت أثناء عدم اطلاعك:</p>
      <ul className="list-plain">
        {q.data.map((r) => (
          <li key={r.id} className="row between">
            <div>
              <div>{r.label}</div>
              <div className="help">موعد التنبيه: {fmtDateTime(r.remindAt)}</div>
            </div>
            {r.caseId && (
              <Button
                size="sm"
                onClick={() => {
                  setDismissed(true);
                  navigate(`/cases/${r.caseId}`);
                }}
              >
                فتح الملف
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function Layout() {
  const { state, refresh, can, isOwner } = useSession();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar') === 'collapsed');
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<QuickKind | null>(null);
  const [pw, setPw] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const lastPing = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'open');
    } catch {
      /* */
    }
  }, [collapsed]);

  // إشارات النشاط الفعلي للمستخدم لاحتساب مدة الخمول
  useEffect(() => {
    const onAct = () => {
      const now = Date.now();
      if (now - lastPing.current > 45_000) {
        lastPing.current = now;
        void api('session.ping', {}).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onAct);
    window.addEventListener('mousedown', onAct);
    window.addEventListener('wheel', onAct, { passive: true });
    const offNav = window.lawApi.on('app:navigate', (p) => typeof p === 'string' && p.startsWith('/') && navigate(p));
    const offRem = window.lawApi.on('reminders:fired', () => invalidate());
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener('keydown', onAct);
      window.removeEventListener('mousedown', onAct);
      window.removeEventListener('wheel', onAct);
      offNav();
      offRem();
      clearInterval(timer);
    };
  }, [navigate, refresh]);

  useEffect(() => {
    if (location.pathname !== '/search') setQ('');
  }, [location.pathname]);

  const [navOpen, setNavOpen] = useState(false);
  const logout = async () => {
    await api('auth.logout', {}).catch(() => undefined);
    await refresh();
  };

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="القائمة الرئيسية" onClick={(e) => (e.target as HTMLElement).closest('a') && setNavOpen(false)}>
        <div className="brand">
          <div className="mark" aria-hidden>
            <Scale size={22} />
          </div>
          <div className="name" title={state?.officeName}>{state?.officeName}</div>
        </div>
        <nav>
          {NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? n.perm.some((p) => can(p)) : can(n.perm as never))).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`} data-tip={n.label} aria-label={n.label} title={collapsed ? n.label : undefined}>
              <n.icon />
              <span className="nav-label">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'توسيع القائمة' : 'طي القائمة'} title={collapsed ? 'توسيع القائمة' : 'طي القائمة'}>
          {collapsed ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
          <span className="nav-label">طي القائمة</span>
        </button>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="القائمة" aria-expanded={navOpen}>
            <Menu size={22} />
          </button>
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <Search />
            <input className="input" placeholder="بحث عام: عميل، قضية، رقم، خصم، مذكرة، ملاحظة، مستند…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="البحث العام" />
          </form>
          <CloudStatusChip />
          <span className="grow" />
          <Dropdown
            trigger={(_o, toggle) => (
              <Button variant="primary" icon={<Plus />} onClick={toggle} aria-haspopup="menu">
                إضافة سريعة
              </Button>
            )}
          >
            {(close) => (
              <>
                {can('clients.create') && (
                  <button onClick={() => { close(); setQuick('client'); }}>
                    <UserPlus /> إضافة عميل
                  </button>
                )}
                {can('cases.create') && (
                  <button onClick={() => { close(); setQuick('case'); }}>
                    <Briefcase /> إضافة قضية
                  </button>
                )}
                <button onClick={() => { close(); setQuick('hearing'); }}>
                  <CalendarPlus /> إضافة جلسة
                </button>
                <button onClick={() => { close(); setQuick('minutes'); }}>
                  <ClipboardPlus /> إرفاق ضبط
                </button>
                <button onClick={() => { close(); setQuick('memo'); }}>
                  <ScrollText /> إضافة مذكرة
                </button>
                <button onClick={() => { close(); setQuick('judgment'); }}>
                  <Gavel /> إضافة حكم
                </button>
                <button onClick={() => { close(); setQuick('task'); }}>
                  <ListChecks /> إضافة مهمة
                </button>
                {can('consultations.manage') && (
                  <>
                    <button onClick={() => { close(); setQuick('consultation'); }}>
                      <MessagesSquare /> إضافة استشارة
                    </button>
                    <button onClick={() => { close(); setQuick('meeting'); }}>
                      <UserPlus /> إضافة اجتماع
                    </button>
                  </>
                )}
                <button onClick={() => { close(); setQuick('document'); }}>
                  <FilePlus2 /> إرفاق مستند
                </button>
                {can('fees.manage') && (
                  <button onClick={() => { close(); setQuick('payment'); }}>
                    <Banknote /> تسجيل دفعة
                  </button>
                )}
              </>
            )}
          </Dropdown>
          <Dropdown
            trigger={(_o, toggle) => (
              <Button variant="ghost" icon={<UserRound />} onClick={toggle} aria-haspopup="menu">
                {state?.user?.displayName}
              </Button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-title">{isOwner ? 'صاحب المكتب' : 'مستشار قانوني'} — <Ltr>{state?.user?.username}</Ltr></div>
                <button onClick={() => { close(); setPw(true); }}>
                  <KeyRound /> تغيير كلمة المرور
                </button>
                <button
                  onClick={async () => {
                    close();
                    await api('auth.lock', {});
                    await refresh();
                  }}
                >
                  <Lock /> قفل الشاشة
                </button>
                <div className="sep" />
                <button onClick={() => { close(); void logout(); }}>
                  <LogOut /> تسجيل الخروج
                </button>
              </>
            )}
          </Dropdown>
        </header>
        {state?.customDataDir && (
          <div className="banner info">
            <BellRing size={16} /> مساحة بيانات منفصلة (تجريبية): <Ltr>{state.customDataDir}</Ltr>
          </div>
        )}
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
      {quick === 'client' && <ClientForm onClose={() => setQuick(null)} onSaved={(id) => navigate(`/clients/${id}`)} />}
      {quick === 'case' && <CaseForm onClose={() => setQuick(null)} onSaved={(id) => navigate(`/cases/${id}`)} />}
      {(quick === 'hearing' || quick === 'minutes' || quick === 'memo' || quick === 'judgment') && <CaseScoped kind={quick} onClose={() => setQuick(null)} />}
      {quick === 'task' && <TaskForm onClose={() => setQuick(null)} />}
      {quick === 'consultation' && <ConsultationForm onClose={() => setQuick(null)} onSaved={(id) => navigate(`/appointments/consultations/${id}`)} />}
      {quick === 'meeting' && <MeetingForm onClose={() => setQuick(null)} onSaved={(id) => navigate(`/appointments/meetings/${id}`)} />}
      {quick === 'document' && <DocumentAttachForm onClose={() => setQuick(null)} />}
      {quick === 'payment' && <PaymentForm onClose={() => setQuick(null)} onSaved={() => toast.info('يمكنك إرفاق سند الدفع من صفحة الأتعاب')} />}
      {pw && <ChangePasswordForm onClose={() => setPw(false)} />}
      <MissedReminders />
    </div>
  );
}
