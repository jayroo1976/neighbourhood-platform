import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ago } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field, Spinner, Toggle, copyText, useAsync } from '../ui';
import { loadOwnAi, saveOwnAi, type Provider } from '../ownAi';

function OwnAiPanel() {
  const [cfg, setCfg] = useState(loadOwnAi());
  const [provider, setProvider] = useState<Provider>(cfg?.provider ?? 'anthropic');
  const [key, setKey] = useState('');
  return (
    <section className="panel stack">
      <h2>Smart drafting (optional)</h2>
      <p className="muted small">
        Off by default. If you want a title and category drafted from your photo, you can connect your own AI account. Your key stays on this device only, and your photo goes from your phone straight to that provider (outside the UAE, under their terms). We never see the key and the service works fully without it.
      </p>
      {cfg ? (
        <>
          <Banner tone="ok">Connected to {cfg.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} on this device.</Banner>
          <button className="btn bad block" onClick={() => (saveOwnAi(null), setCfg(null))}>Disconnect and forget key</button>
        </>
      ) : (
        <>
          <Field label="Provider">
            <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
            </select>
          </Field>
          <Field label="Your API key">
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <button className="btn block" disabled={key.trim().length < 20} onClick={() => { const v = { provider, key: key.trim() }; saveOwnAi(v); setCfg(v); setKey(''); }}>Connect on this device</button>
        </>
      )}
    </section>
  );
}

interface Notif {
  id: string;
  incident_id: string | null;
  type: string;
  message: string;
  created_at: string;
  read_at: string | null;
}

export function Notifications() {
  const { refreshUnread } = useAuth();
  const q = useAsync(() => api.get<{ items: Notif[] }>('/notifications'), []);
  async function markAll() {
    await api.post('/notifications/read', {});
    q.reload();
    void refreshUnread();
  }
  return (
    <div className="page">
      <header className="page-head row between">
        <h1>Alerts</h1>
        {q.data?.items.some((n) => !n.read_at) && (
          <button className="btn small" onClick={markAll}>
            Mark all read
          </button>
        )}
      </header>
      {q.loading && !q.data ? (
        <Spinner />
      ) : q.data?.items.length ? (
        <ul className="list notif">
          {q.data.items.map((n) => (
            <li key={n.id} className={n.read_at ? '' : 'unread'}>
              <Link to={n.incident_id ? `/incident/${n.incident_id}` : '/'} onClick={() => api.post('/notifications/read', { ids: [n.id] }).then(refreshUnread)}>
                <span>{n.message}</span>
                <time className="muted small">{ago(n.created_at)}</time>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <p>Nothing yet. We'll tell you when management replies, a case number is due, or a neighbour joins your report.</p>
        </div>
      )}
    </div>
  );
}

function InvitePanel() {
  const q = useAsync(() => api.get<{ url: string; invited: number; auto_approved: boolean; approval_required: boolean }>('/me/invite'), []);
  const [note, setNote] = useState<string | null>(null);
  if (!q.data) return null;
  const msg = `Join our building's issue reporting platform so we can get problems fixed together: ${q.data.url}`;
  return (
    <section className="panel stack">
      <h2>Invite neighbours</h2>
      <p className="muted small">
        Send your personal link to neighbours who live here.{' '}
        {q.data.approval_required && !q.data.auto_approved ? 'A moderator approves each new person, and sees that you invited them.' : 'They can join straight away.'}
        {q.data.invited > 0 ? ` ${q.data.invited} joined so far through your link.` : ''}
      </p>
      <a className="btn block whatsapp-btn" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">
        Invite on WhatsApp
      </a>
      <button
        className="btn block"
        onClick={async () => {
          setNote((await copyText(msg)) ? 'Invitation and link copied.' : 'Could not copy automatically.');
          setTimeout(() => setNote(null), 3000);
        }}
      >
        Copy invitation
      </button>
      {note && <p className="share-note" role="status">{note}</p>}
    </section>
  );
}

export function Profile() {
  const { me, refresh, signOut } = useAuth();
  const nav = useNavigate();
  const u = me!.user!;
  const towers = me?.community?.towers ?? [];
  const [f, setF] = useState({ name: u.name, tower: u.tower ?? '', unit: u.unit ?? '', notify_email: u.notify_email });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [del, setDel] = useState<null | { password: string; withdraw: boolean }>(null);
  const staff = u.role !== 'resident';

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await api.patch('/me/profile', f);
      await refresh();
      setMsg('Saved. New reports will use this tower and apartment.');
    } catch (err) {
      setError(err);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/me/password', { current: pw.current, next: pw.next });
      await refresh();
      nav('/login');
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    if (!del) return;
    setError(null);
    try {
      await api.post('/me/delete', { password: del.password, withdraw_reports: del.withdraw });
      await refresh();
      nav('/login');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Your profile</h1>
        <p className="muted">{u.email}</p>
      </header>

      <form className="panel stack" onSubmit={save}>
        <h2>Your home</h2>
        <p className="muted small">Saved once and added to every report so you never retype it. Neighbours never see your apartment number.</p>
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <div className="row">
          <Field label="Tower / building">
            {towers.length ? (
              <select value={f.tower} onChange={(e) => setF({ ...f, tower: e.target.value })} required>
                <option value="">Select...</option>
                {towers.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input value={f.tower} onChange={(e) => setF({ ...f, tower: e.target.value })} required />
            )}
          </Field>
          <Field label="Apartment no.">
            <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required />
          </Field>
        </div>
        <Toggle checked={f.notify_email} onChange={(v) => setF({ ...f, notify_email: v })} label="Email me reminders" hint="Case number reminders and updates on your reports." />
        {msg && <Banner tone="ok">{msg}</Banner>}
        <ErrorNote error={error} />
        <button className="btn primary block">Save</button>
      </form>

      {staff && !u.mfa_enabled && (
        <Banner tone="warn" title="Two-factor authentication is off">
          <Link to="/mfa">Turn it on</Link>
        </Banner>
      )}

      <InvitePanel />

      <form className="panel stack" onSubmit={changePassword}>
        <h2>Change password</h2>
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        </Field>
        <Field label="New password" hint="At least 12 characters. You'll be signed out on all devices.">
          <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={12} />
        </Field>
        <button className="btn block">Change password</button>
      </form>

      <OwnAiPanel />

      <section className="panel stack">
        <h2>Your data</h2>
        <a className="btn block" href="/api/me/export" download>
          Download everything we hold about me
        </a>
        <Link to="/privacy" className="center">
          Privacy notice
        </Link>
        {!del ? (
          <button className="btn bad block" onClick={() => setDel({ password: '', withdraw: false })} disabled={['admin', 'super_admin'].includes(u.role)}>
            Delete my account
          </button>
        ) : (
          <div className="stack">
            <Banner tone="danger" title="This cannot be undone">
              Your name, email, phone and apartment number are removed. Reports stay as an anonymous community record unless you withdraw them.
            </Banner>
            <Toggle checked={del.withdraw} onChange={(v) => setDel({ ...del, withdraw: v })} label="Also withdraw my reports and delete my photos" />
            <Field label="Confirm with your password">
              <input type="password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} />
            </Field>
            <ErrorNote error={error} />
            <button className="btn bad block" disabled={!del.password} onClick={remove}>
              Permanently delete
            </button>
            <button className="btn ghost block" onClick={() => setDel(null)}>
              Cancel
            </button>
          </div>
        )}
      </section>

      <button className="btn block" onClick={() => signOut().then(() => nav('/login'))}>
        Sign out
      </button>
    </div>
  );
}
