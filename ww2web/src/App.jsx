import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from '@/components/layout/app-layout.jsx';
import { FullPageLoader } from '@/components/common/loading.jsx';
import { useAuth } from '@/hooks/use-auth.jsx';
import ConfigPage from '@/pages/config.jsx';
import ConnectionPage from '@/pages/connection.jsx';
import AutoRepliesPage from '@/pages/autoreplies.jsx';
import DashboardPage from '@/pages/dashboard.jsx';
import DataPage from '@/pages/data.jsx';
import DocPage from '@/pages/doc.jsx';
import DocsPage from '@/pages/docs.jsx';
import InstancesPage from '@/pages/instances.jsx';
import LoginPage from '@/pages/login.jsx';
import LogsPage from '@/pages/logs.jsx';
import MessagingPage from '@/pages/messaging.jsx';
import NotFoundPage from '@/pages/not-found.jsx';
import SecurityPage from '@/pages/security.jsx';
import SettingsPage from '@/pages/settings.jsx';

/** Gate the administration shell behind a validated owner session. */
function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageLoader label="Validating session" />;
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="connection" element={<ConnectionPage />} />
        <Route path="instances" element={<InstancesPage />} />
        <Route path="messaging" element={<MessagingPage />} />
        <Route path="autoreplies" element={<AutoRepliesPage />} />
        <Route path="data" element={<DataPage />} />
        <Route path="config" element={<ConfigPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="docs/:docId" element={<DocPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
