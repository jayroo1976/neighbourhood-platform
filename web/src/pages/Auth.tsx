import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field } from '../ui';
import { InstallSteps } from '../InstallPrompt';

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

/** Where to go after signing in: the page the person was trying to open (same-site paths only). */
function useReturnTo(): string {
  const st = useLocation().state as { from?: unknown } | null;
  const from = typeof st?.from === 'string' ? st.from : '/';
  return from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/';
}

export function Login() {
  const { refresh, me } = useAuth();
  const nav = useNavigate();
  const returnTo = useReturnTo();
  const approval = !!me?.config.approval_required;
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
      nav(r.mfa_enrol_required ? '/mfa' : returnTo, { replace: true });
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
      <div className="join-box">
        <strong>New here?</strong>
        <span>Residents can ask to join. You need your email, tower and apartment number.</span>
        <Link className="btn block" to="/register" state={{ from: returnTo }}>
          {approval ? 'Request to join' : 'Create an account'}
        </Link>
      </div>
      <p className="center">
        <Link to="/forgot">Forgot password?</Link>
      </p>
    </Shell>
  );
}

export function Register() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const returnTo = useReturnTo();
  const [search] = useSearchParams();
  const ref = search.get('ref') || undefined;
  const [requested, setRequested] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', tower: '', unit: '', consent: false, terms: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const approval = !!me?.config.approval_required;
  const towers = me?.community?.towers ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ pending?: boolean }>('/auth/register', { ...f, ref });
      if (r.pending) {
        setRequested(true);
        return;
      }
      await refresh();
      nav(returnTo, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (requested) {
    return (
      <Shell title="Request sent" sub="A moderator will review it.">
        <Banner tone="ok">Thank you. We will email you at {f.email} as soon as your request has been approved, then you can sign in.</Banner>
        <h2>While you wait: add it to your home screen</h2>
        <InstallSteps />
        <p className="center">
          <Link to="/login">Back to sign in</Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={approval ? 'Request to join' : 'Create your account'} sub={approval ? 'A moderator checks each request so only real residents join. You will get an email when you are approved.' : 'Your tower and apartment are saved once and added to every report for you.'}>
      <form onSubmit={submit} className="stack">
        <Field label="Full name">
          <input value={f.name} onChange={set('name')} autoComplete="name" required minLength={2} />
        </Field>
        <Field label="Email">
          <input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
        </Field>
        <div className="row">
          <Field label="Tower / building">
            <select value={f.tower} onChange={set('tower')} required>
              <option value="">Select your tower...</option>
              {towers.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Apartment no.">
            <input value={f.unit} onChange={set('unit')} required inputMode="text" />
          </Field>
        </div>
        <Field label="Password" hint="At least 12 characters. A short phrase of unrelated words works well.">
          <input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required minLength={12} />
        </Field>
        <div className="data-notice">
          <strong>What we store about you</strong>
          <ul>
            <li>Your name, email, tower and apartment number, and a scrambled (hashed) password.</li>
            <li>The reports, photos, comments and "affects me" ticks you add, and when you add them.</li>
            <li>Approximate locations you choose to share, and basic security logs (such as sign-in times).</li>
          </ul>
          <strong>Who sees it</strong>
          <ul>
            <li>The management company sees your report with your tower, apartment, first name and photos so it can act.</li>
            <li>Neighbours see the report and photos, never your name or apartment number.</li>
            <li>Moderators of this service can see everything, to approve people and keep it fair.</li>
          </ul>
          <span>You can download or delete your data from your profile at any time. <Link to="/privacy">Full privacy notice</Link></span>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} required />
          <span>I have read the <Link to="/privacy">privacy notice</Link> and I agree to my details being stored and shared as described above.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} required />
          <span>I accept the <Link to="/terms">terms of use</Link>.</span>
        </label>
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy || !f.consent || !f.terms}>
          {busy ? 'Sending...' : approval ? 'Send my request' : 'Create account'}
        </button>
      </form>
      <p className="center">
        Already registered? <Link to="/login" state={{ from: returnTo }}>Sign in</Link>
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

function Operator() {
  const { me } = useAuth();
  const name = (me?.config as { operator_name?: string } | undefined)?.operator_name;
  const contact = (me?.config as { operator_contact?: string } | undefined)?.operator_contact;
  return name ? (
    <p>
      <strong>Who runs it.</strong> {name}{contact ? <>. Contact: {contact}</> : null}. This is the party responsible for your personal data (the "controller" under the UAE Personal Data Protection Law).
    </p>
  ) : (
    <Banner tone="warn" title="Operator not yet named">
      The legal entity that runs this service, and its contact details, must be shown here before real residents use it.
    </Banner>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy notice">
      <div className="prose">
        <p>
          <em>Pilot notice, version 2026-10-v2. A lawyer will review this before a wider launch.</em>
        </p>
        <Operator />
        <p>
          <strong>What this service is.</strong> Neighbourhood Reports is a private tracking tool for residents of a community. It helps you keep a record of issues and the responses to them. It is independent: it is not operated by your management company, developer or any government body.
        </p>
        <p>
          <strong>What we collect.</strong> Your name, email, tower and apartment number (which you declare yourself), optionally a phone number, the photos and text you submit, the location you choose to share with a report, the actions you take on reports, and basic security logs such as sign-in times.
        </p>
        <p>
          <strong>Why.</strong> To record your report, help you send it to the management company, show progress to you and your neighbours, and calculate response-time figures from what residents record. Our basis is your consent, which you give when you register and can withdraw by deleting your account.
        </p>
        <p>
          <strong>Who sees it.</strong> The management company receives your report, and therefore knows who sent it: by default you send the email from your own email account, and it includes your tower, apartment number, first name, location and secure photo links. Your reports are <strong>not anonymous to the management company</strong>. Neighbours see the report, tower and photos but never your name or apartment number, and location is shown only approximately. Reports marked "Keep private" are not shown to neighbours. Moderators of this service can see everything on a report. Nothing on this service is public: every page needs a sign-in.
        </p>
        <p>
          <strong>Photos.</strong> Please do not photograph people, faces or number plates. Photo metadata (including location) is removed on upload. Residents are responsible for what they photograph.
        </p>
        <p>
          <strong>Where it is stored and who handles it.</strong> During the pilot the service runs on a dedicated server controlled by the operator. Access from the internet goes through Cloudflare, which carries your traffic and photos in transit and may handle it outside the UAE. Encrypted backups are kept in Microsoft Azure in the UAE. If you turn on the optional AI helper with your own key, your photo and note are sent from your browser to that AI provider, which may be outside the UAE; it is off unless you enable it.
        </p>
        <p>
          <strong>How long we keep it.</strong> While your account is active. When you delete your account we remove your name, email, phone and apartment number, and you can also withdraw your reports and photos. Copies in backups age out within the backup retention period (about 30 days for daily copies and up to 12 months for monthly copies).
        </p>
        <p>
          <strong>Your rights.</strong> You can download your data or delete your account from your profile at any time, and ask the operator to correct your details. If there is a data breach that affects you, the operator will tell you and the regulator as the law requires.
        </p>
        <p>
          <strong>Children.</strong> The service is for people aged 18 or over.
        </p>
        <p>
          <strong>Emergencies.</strong> This service is not monitored. In an emergency call <strong>999 (police), 998 (ambulance) or 997 (fire)</strong>, or the building emergency number.
        </p>
      </div>
      <p className="center">
        <Link to="/login">Back</Link>
      </p>
    </Shell>
  );
}

export function Terms() {
  return (
    <Shell title="Terms of use">
      <div className="prose">
        <p>
          <em>Pilot terms, version 2026-10-v2. A lawyer will review these before a wider launch.</em>
        </p>
        <Operator />
        <p>
          <strong>1. What this service is.</strong> Neighbourhood Reports is an independent, resident-run, private tracking tool. It helps residents record issues in their community, see whether neighbours are affected, and keep a record of the responses. It is not operated by, or an official channel of, your management company, developer or any government body, and it is free to use.
        </p>
        <p>
          <strong>2. Who can join.</strong> You must be 18 or over and a genuine resident or authorised occupier of the community. You declare your tower and apartment yourself; a moderator may check them. Give accurate details and do not use someone else's identity. We may approve, decline or remove any account, for example if we cannot confirm you live there.
        </p>
        <p>
          <strong>3. Your account.</strong> Keep your password private and tell us if you think someone else has used your account. You are responsible for what is done through it.
        </p>
        <p>
          <strong>4. What you post.</strong> Post only facts you believe to be true, about the building, services and common areas, in neutral language. Information on this service is supplied by residents and is not verified by us. Do not post anything false, abusive, defamatory, discriminatory or private about a named person, and do not photograph people, faces or number plates. Do not post anything that breaks UAE law, including laws on defamation, privacy and cybercrime. You are responsible for what you post. You keep ownership of it, and you give us permission to store it, show it to residents, moderators and the management company, and use it in statistics such as the scorecard.
        </p>
        <p>
          <strong>5. Moderation and false reports.</strong> Moderators may edit, hide or remove posts that break these terms, and may suspend or remove accounts that post false or misleading reports, impersonate someone, or break these terms repeatedly.
        </p>
        <p>
          <strong>6. Emails to the management company.</strong> By default you send the email to the management company yourself, from your own email account, so it comes from you and the management company will know who you are. Keep it factual and polite. Sending large numbers of near-identical emails may be treated by others as harassment, so use "This affects me too" for the same problem rather than sending new reports.
        </p>
        <p>
          <strong>7. Response figures and statuses.</strong> Response times and "closed, disputed by residents" figures are calculated from the dates and evidence that residents record on this service. They reflect what has been recorded here, are not a finding or opinion about anyone, and are visible only to signed-in residents.
        </p>
        <p>
          <strong>8. Not for emergencies.</strong> This service is not monitored. In an emergency call 999 (police), 998 (ambulance) or 997 (fire), or the building emergency number. Do not rely on this service for urgent safety issues. Any suggested urgency or category is only a suggestion.
        </p>
        <p>
          <strong>9. Your data.</strong> We handle personal data under the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and as set out in the <Link to="/privacy">privacy notice</Link>. You can download or delete your data from your profile.
        </p>
        <p>
          <strong>10. No guarantees, and limits on liability.</strong> This is a free pilot, provided as it is, with best-effort availability and no promise that it will always be available or error free. We cannot promise the management company will act on a report. To the extent UAE law allows, we are not liable for indirect or consequential losses arising from your use of it. Nothing in these terms excludes liability that the law does not allow to be excluded, including for intentional harm or gross negligence, or removes the duties we have under data protection law.
        </p>
        <p>
          <strong>11. Changes.</strong> We may update these terms. If the change is important we will ask you to accept the new version.
        </p>
        <p>
          <strong>12. Law and courts.</strong> These terms are governed by the laws of the United Arab Emirates as applied in the Emirate of Dubai, and the courts of Dubai have jurisdiction, unless mandatory law says otherwise.
        </p>
      </div>
      <p className="center">
        <Link to="/login">Back</Link>
      </p>
    </Shell>
  );
}
