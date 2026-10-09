import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Banner, ErrorNote, Spinner } from './ui';
import { Forgot, Login, MfaSetup, Privacy, Register, Reset } from './pages/Auth';
import { Feed } from './pages/Feed';
import { Report } from './pages/Report';
import { IncidentPage } from './pages/Incident';
import { Scorecard } from './pages/Scorecard';
import { Notifications, Profile } from './pages/Account';
import { AdminData, AdminIncident, AdminIncidents, AdminSettings, AdminUsers } from './pages/Admin';

function ConsentGate({ children }: { children: ReactNode }) {
  const { me, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (me?.user && !me.user.consent_current) {
    return (
      <div className="page">
        <h1>Our privacy notice has changed</h1>
        <Banner tone="info">Please review the notice and confirm to carry on. You can also download or delete your data from your profile.</Banner>
        <p><a href="/privacy" target="_blank" rel="noreferrer">Read the privacy notice</a></p>
        <ErrorNote error={error} />
        <button
          className="btn primary block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post('/auth/consent', {});
              await refresh();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          I have read and accept
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

function Protected({ admin }: { admin?: boolean }) {
  const { me, loading, unread } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  const u = me?.user;
  if (!u) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (u.mfa_enrol_required) return loc.pathname === '/mfa' ? <Outlet /> : <Navigate to="/mfa" replace />;
  if (admin && u.role !== 'admin' && u.role !== 'super_admin') return <Navigate to="/" replace />;
  const staff = u.role === 'admin' || u.role === 'super_admin';
  const inAdmin = loc.pathname.startsWith('/admin');
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand"><img src="/icons/any/app-48.png" alt="" className="brand-mark" width={30} height={30} /> {me?.community?.name ?? 'Neighbourhood'}</NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>Community</NavLink>
          <NavLink to="/scorecard">Scorecard</NavLink>
          <NavLink to="/alerts">Alerts{unread > 0 && <span className="badge">{unread}</span>}</NavLink>
          <NavLink to="/profile">Profile</NavLink>
          {staff && <NavLink to="/admin/incidents">Admin</NavLink>}
        </nav>
        <NavLink to="/report" className="btn primary small topreport">+ Report</NavLink>
      </header>
      {inAdmin && (
        <nav className="subnav" aria-label="Admin">
          <NavLink to="/admin/incidents">Reports</NavLink>
          <NavLink to="/admin/users">Users</NavLink>
          <NavLink to="/admin/settings">Settings</NavLink>
          <NavLink to="/admin/data">Data</NavLink>
        </nav>
      )}
      <main>
        <ConsentGate>
          <Outlet />
        </ConsentGate>
      </main>
      <nav className="bottomnav" aria-label="Main">
        <NavLink to="/" end>Community</NavLink>
        <NavLink to="/report" className="fab"><span aria-hidden>+</span> Report</NavLink>
        <NavLink to="/alerts">Alerts{unread > 0 && <span className="badge">{unread}</span>}</NavLink>
        <NavLink to="/scorecard">Scores</NavLink>
        <NavLink to={staff ? '/admin/incidents' : '/profile'}>{staff ? 'Admin' : 'Me'}</NavLink>
      </nav>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset" element={<Reset />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route element={<Protected />}>
        <Route path="/mfa" element={<MfaSetup />} />
        <Route path="/" element={<Feed />} />
        <Route path="/report" element={<Report />} />
        <Route path="/incident/:id" element={<IncidentPage />} />
        <Route path="/alerts" element={<Notifications />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/scorecard" element={<Scorecard />} />
      </Route>
      <Route element={<Protected admin />}>
        <Route path="/admin/incidents" element={<AdminIncidents />} />
        <Route path="/admin/incidents/:id" element={<AdminIncident />} />
        <Route path="/admin/users" element={<AdminUsers />} />
        <Route path="/admin/settings" element={<AdminSettings />} />
        <Route path="/admin/data" element={<AdminData />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
