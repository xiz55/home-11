import { Component, type ReactNode } from 'react';
import { createHashRouter, RouterProvider, useRouteError } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { ConfirmHost, ToastHost, Loading, Button } from './components/ui';
import { Layout } from './components/Layout';
import { LoginScreen, LockScreen, SetupScreen } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { ClientsPage, ClientProfilePage } from './pages/Clients';
import { CasesPage } from './pages/Cases';
import { CasePage } from './pages/CasePage';
import { AnalysisPage } from './pages/Analysis';
import { MemoEditorPage } from './pages/MemoEditor';
import { CalendarPage } from './pages/Calendar';
import { TasksPage, DocumentsPage, SearchPage, FeesPage } from './pages/Misc';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

function RouteError() {
  const err = useRouteError() as Error;
  return (
    <div className="card card-pad" style={{ margin: 24 }}>
      <h2>تعذر عرض هذه الصفحة</h2>
      <p className="muted">{err?.message ?? 'خطأ غير معروف'}</p>
      <Button onClick={() => (window.location.hash = '#/')}>العودة للرئيسية</Button>
    </div>
  );
}

const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'clients', element: <ClientsPage /> },
      { path: 'clients/:id', element: <ClientProfilePage /> },
      { path: 'cases', element: <CasesPage /> },
      { path: 'cases/:id', element: <CasePage /> },
      { path: 'cases/:id/analysis', element: <AnalysisPage /> },
      { path: 'cases/:id/memos/:memoId', element: <MemoEditorPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'fees', element: <FeesPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: '*', element: <DashboardPage /> },
    ],
  },
]);

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  override render() {
    if (this.state.err)
      return (
        <div className="auth-screen">
          <div className="auth-card">
            <h2>حدث خطأ في الواجهة</h2>
            <p className="muted">{this.state.err.message}</p>
            <p className="help">بياناتك محفوظة. أعد تحميل الواجهة للمتابعة.</p>
            <Button variant="primary" onClick={() => window.location.reload()}>إعادة التحميل</Button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function Gate() {
  const { state } = useSession();
  if (!state) return <Loading />;
  if (!state.initialized) return <SetupScreen />;
  if (!state.user) return <LoginScreen />;
  return (
    <>
      <RouterProvider router={router} />
      {state.locked && <LockScreen />}
    </>
  );
}

export function App() {
  return (
    <Boundary>
      <SessionProvider>
        <Gate />
        <ConfirmHost />
        <ToastHost />
      </SessionProvider>
    </Boundary>
  );
}
