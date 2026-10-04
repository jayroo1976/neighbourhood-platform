import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field } from '../ui';

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden />
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </main>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ mfa_enrol_required: boolean }>('/auth/login', { email, password, ...(useRecovery ? { recovery_code: mfa } : mfa ? { mfa_code: mfa } : {}) });
      await refresh();
      nav(r.mfa_enrol_required ? '/mfa' : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedMfa(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Neighbourhood Reports" sub="Report it in seconds. Track whether it really gets fixed.">
      <form onSubmit={submit} className="stack">
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {needMfa && (
          <Field label={useRecovery ? 'Recovery code' : 'Authentication code'} hint={useRecovery ? undefined : 'From your authenticator app'}>
            <input inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={mfa} onChange={(e) => setMfa(e.target.value)} required autoFocus />
          </Field>
        )}
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Signing in...' : needMfa ? 'Verify and sign in' : 'Sign in'}
        </button>
        {needMfa && (
          <button type="button" className="btn ghost block" onClick={() => (setUseRecovery(!useRecovery), setMfa(''))}>
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
        )}
      </form>
      <p className="center">
        <Link to="/forgot">Forgot password?</Link> · <Link to="/register">Create account</Link>
      </p>
    </Shell>
  );
}

export function Register() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', tower: '', unit: '', invite_code: '', consent: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const towers = me?.community?.towers ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/register', { ...f, invite_code: f.invite_code || undefined });
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Create your account" sub="Your tower and apartment are saved once and added to every report for you.">
      <form onSubmit={submit} className="stack">
        <Field label="Full name">
          <input value={f.name} onChange={set('name')} autoComplete="name" required minLength={2} />
        </Field>
        <Field label="Email">
          <input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
        </Field>
        <div className="row">
          <Field label="Tower / building">
            {towers.length ? (
              <select value={f.tower} onChange={set('tower')} required>
                <option value="">Select...</option>
                {towers.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input value={f.tower} onChange={set('tower')} required />
            )}
          </Field>
          <Field label="Apartment no.">
            <input value={f.unit} onChange={set('unit')} required inputMode="text" />
          </Field>
        </div>
        <Field label="Password" hint="At least 12 characters. A short phrase of unrelated words works well.">
          <input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={12} />
        </Field>
        {me?.config.invite_required && (
          <Field label="Invite code" hint="Ask the person who invited you to the pilot.">
            <input value={f.invite_code} onChange={set('invite_code')} required />
          </Field>
        )}
        <label className="check">
          <input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} required />
          <span>
            I have read the <Link to="/privacy">privacy notice</Link> and agree my reports, photos and apartment number are shared with Dubai Holding to get issues fixed.
          </span>
        </label>
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy || !f.consent}>
          {busy ? 'Creating...' : 'Create account'}
        </button>
      </form>
      <p className="center">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </Shell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/auth/forgot', { email });
      setDone(true);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Shell title="Reset password">
      {done ? (
        <Banner tone="ok">If that email has an account, a reset link is on its way. It works for one hour.</Banner>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <ErrorNote error={error} />
          <button className="btn primary block">Send reset link</button>
        </form>
      )}
      <p className="center">
        <Link to="/login">Back to sign in</Link>
      </p>
    </Shell>
  );
}

export function Reset() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/auth/reset', { token: params.get('token') ?? '', password });
      nav('/login', { replace: true });
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Shell title="Choose a new password">
      <form onSubmit={submit} className="stack">
        <Field label="New password" hint="At least 12 characters.">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} autoFocus />
        </Field>
        <ErrorNote error={error} />
        <button className="btn primary block">Save password</button>
      </form>
    </Shell>
  );
}

export function MfaSetup() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [setup, setSetup] = useState<{ secret: string; qr_data_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    try {
      setSetup(await api.post('/auth/mfa/setup'));
    } catch (e) {
      setError(e);
    }
  }
  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ recovery_codes: string[] }>('/auth/mfa/enable', { code });
      setRecovery(r.recovery_codes);
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  if (me?.user?.mfa_enabled && !recovery) {
    return (
      <Shell title="Two-factor authentication">
        <Banner tone="ok">Two-factor authentication is on for your account.</Banner>
        <button className="btn block" onClick={() => nav('/')}>
          Continue
        </button>
      </Shell>
    );
  }

  return (
    <Shell title="Secure your account" sub="Moderator and committee accounts need an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password...).">
      {recovery ? (
        <div className="stack">
          <Banner tone="warn" title="Save these recovery codes now">
            Each works once if you lose your phone. They will not be shown again.
          </Banner>
          <pre className="codes">{recovery.join('\n')}</pre>
          <button className="btn primary block" onClick={() => nav('/')}>
            I have saved them
          </button>
        </div>
      ) : !setup ? (
        <div className="stack">
          <ErrorNote error={error} />
          <button className="btn primary block" onClick={start}>
            Start setup
          </button>
        </div>
      ) : (
        <form onSubmit={enable} className="stack">
          <img className="qr" src={setup.qr_data_url} alt="QR code to scan with your authenticator app" width={220} height={220} />
          <p className="muted small">
            Can't scan? Enter this key manually: <code>{setup.secret}</code>
          </p>
          <Field label="6-digit code from the app">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </Field>
          <ErrorNote error={error} />
          <button className="btn primary block">Turn on</button>
        </form>
      )}
    </Shell>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy notice">
      <div className="prose">
        <p>
          <strong>Who we are.</strong> Neighbourhood Reports is an independent, resident-run service. It is not operated by Dubai Holding. This is a pilot notice; the final text will be reviewed before wider launch.
        </p>
        <p>
          <strong>What we collect.</strong> Your name, email, tower and apartment number, the photos and text you submit, the location you choose to share with a report, and the actions you take on reports.
        </p>
        <p>
          <strong>Why.</strong> To send your report to Dubai Holding Community Support, show progress to you and your neighbours, and measure how quickly issues are acknowledged and fixed.
        </p>
        <p>
          <strong>Who sees it.</strong> Dubai Holding receives your report by email, including your tower, apartment number, first name, location and secure photo links. Neighbours see the report, tower and photos but never your name or apartment number, and location is shown only approximately. Moderators of this service can see everything on a report.
        </p>
        <p>
          <strong>Photos.</strong> Please do not photograph people, faces or number plates. Photo metadata (including location) is removed on upload.
        </p>
        <p>
          <strong>Where it is stored.</strong> In Microsoft Azure in the UAE (UAE North). Data is encrypted in transit and at rest.
        </p>
        <p>
          <strong>Your rights.</strong> You can download your data or delete your account from your profile at any time. Deleting removes your name, email, phone and apartment number; you can also withdraw your reports and photos.
        </p>
        <p>
          <strong>Emergencies.</strong> This service is not monitored. In an emergency call 999 or the building emergency number.
        </p>
      </div>
      <p className="center">
        <Link to="/login">Back</Link>
      </p>
    </Shell>
  );
}
