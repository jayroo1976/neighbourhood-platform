import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CATEGORY_LABELS, OPEN_STATUSES, STATUS_LABELS, api, dateTime, qs, type IncidentDetail, type Role, type Status } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field, Sheet, Spinner, Stamp, Toggle, copyText, useAsync } from '../ui';
import { KpiStrip, PhotoStrip, Timeline } from './Incident';
import type { Summary } from './Scorecard';

interface Row {
  id: string;
  ref: string;
  title: string;
  category: string;
  severity: string;
  status: Status;
  tower: string | null;
  unit: string | null;
  visibility: string;
  reported_at: string;
  mgmt_case_number: string | null;
  affects_count: number;
  cluster_id: string | null;
  linked_reports: number;
  source: string;
  kpis: { age_days: number; acknowledgement_sla: string; resolution_sla: string; days_since_update: number; disputed_closure: boolean; reopen_count: number };
}

const isWriter = (r?: Role) => r === 'admin' || r === 'super_admin';

interface Insights {
  kpis: Summary;
  awaiting_reply: { id: string; ref: string; title: string; tower: string | null; hours: number }[];
  awaiting_reply_total: number;
  not_emailed: { id: string; ref: string; title: string; tower: string | null; hours: number }[];
  not_emailed_total: number;
  longest_open: { id: string; ref: string; title: string; tower: string | null; severity: string; age_days: number }[];
  people: { residents: number; pending: number; staff: number };
}

function InsightsPanel({ d, onFlag }: { d?: Insights; onFlag: (f: string) => void }) {
  if (!d) return null;
  const k = d.kpis;
  const pctv = (v: number | null) => (v == null ? '-' : `${Math.round(v * 100)}%`);
  const stat = (label: string, value: string, sub?: string, flag?: string) => (
    <div className="tile" key={label}>
      <span className="tile-label">{label}</span>
      <b>{value}</b>
      {sub && <span className="tile-sub">{sub}</span>}
      {flag && (
        <button type="button" className="linkish noprint" onClick={() => onFlag(flag)}>
          Show these
        </button>
      )}
    </div>
  );
  const week = (a: number, b: number) => (a === b ? 'same as last week' : `${a > b ? '+' : ''}${a - b} vs last week`);
  return (
    <details className="panel insights" open>
      <summary>
        <b>Insights</b> <span className="muted small">last 90 days</span>
      </summary>
      <section className="tiles">
        {stat('Open now', String(k.backlog.open), `${k.backlog.overdue} overdue`, 'overdue')}
        {stat('No reply in time', String(k.acknowledgement.overdue_unacknowledged), `median reply ${k.acknowledgement.median_hours ?? '-'}h`, 'ack_breached')}
        {stat('Closed, not fixed', String(k.closure_quality.disputed), `${pctv(k.closure_quality.disputed_rate)} of closures`, 'disputed')}
        {stat('Awaiting verification', String(k.closure_quality.awaiting_verification), `${k.closure_quality.awaiting_verification_over_7d} over 7 days`, 'awaiting_verification')}
        {stat('Reported this week', String(k.week.this.reported), week(k.week.this.reported, k.week.last.reported))}
        {stat('Fixed this week', String(k.week.this.fixed), week(k.week.this.fixed, k.week.last.fixed))}
        {stat('Reopened after closure', String(k.reopen.reopened), `${pctv(k.reopen.rate)} of ${k.reopen.closed_total} closures`)}
        {stat('Residents', String(d.people.residents), `${d.people.pending} waiting for approval · ${k.engagement.reporters} have reported`)}
      </section>
      <div className="grid-2">
        <div>
          <h3>Waiting longest for a reply ({d.awaiting_reply_total})</h3>
          {d.awaiting_reply.length ? (
            <ul className="plain">
              {d.awaiting_reply.map((x) => (
                <li key={x.id}>
                  <Link to={`/admin/incidents/${x.id}`}>{x.ref} {x.title}</Link> <span className="muted small">{x.tower} · {x.hours >= 48 ? `${Math.round(x.hours / 24)} days` : `${x.hours}h`} since emailed</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing waiting.</p>
          )}
          <h3>Saved but not yet emailed ({d.not_emailed_total})</h3>
          {d.not_emailed.length ? (
            <ul className="plain">
              {d.not_emailed.map((x) => (
                <li key={x.id}>
                  <Link to={`/admin/incidents/${x.id}`}>{x.ref} {x.title}</Link> <span className="muted small">{x.tower} · saved {x.hours >= 48 ? `${Math.round(x.hours / 24)} days` : `${x.hours}h`} ago, resident has not confirmed sending</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Every report has been emailed.</p>
          )}
        </div>
        <div>
          <h3>Open the longest</h3>
          <ul className="plain">
            {d.longest_open.map((x) => (
              <li key={x.id}>
                <Link to={`/admin/incidents/${x.id}`}>{x.ref} {x.title}</Link> <span className="muted small">{x.tower} · {Math.round(x.age_days)} days · {x.severity}</span>
              </li>
            ))}
          </ul>
          <h3>Issues affecting the most homes</h3>
          {k.top_affected.length ? (
            <ul className="plain">
              {k.top_affected.map((x) => (
                <li key={x.id}>
                  <Link to={`/admin/incidents/${x.id}`}>{x.ref} {x.title}</Link> <span className="muted small">{x.homes} homes</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No shared issues yet.</p>
          )}
        </div>
      </div>
    </details>
  );
}

export function AdminIncidents() {
  const { me } = useAuth();
  const writer = isWriter(me?.user?.role);
  const [flag, setFlag] = useState('');
  const [status, setStatus] = useState('');
  const [tower, setTower] = useState('');
  const [text, setText] = useState('');
  const [dq, setDq] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const [primary, setPrimary] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const t = setTimeout(() => setDq(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useAsync(() => api.get<{ items: Row[]; total: number }>(`/admin/incidents${qs({ flag, status, tower, q: dq })}`), [flag, status, tower, dq]);

  async function link() {
    try {
      await api.post('/admin/incidents/link', { primary_id: primary, ids: sel.filter((s) => s !== primary) });
      setSel([]);
      setLinking(false);
      q.reload();
    } catch (e) {
      setError(e);
    }
  }

  const insights = useAsync(() => api.get<Insights>('/admin/insights?days=90'), []);

  return (
    <div className="page wide">
      <header className="page-head row between">
        <div>
          <h1>All reports</h1>
          <p className="muted">{q.data ? `${q.data.total} reports` : ''}</p>
        </div>
        {writer && sel.length >= 2 && (
          <button className="btn primary" onClick={() => (setPrimary(sel[0]), setLinking(true))}>
            Link {sel.length} as the same problem
          </button>
        )}
      </header>

 <InsightsPanel d={insights.data ?? undefined} onFlag={setFlag} />

      <div className="filters admin-filters">
        <input type="search" placeholder="Search title, ref or case no." value={text} onChange={(e) => setText(e.target.value)} />
        <select value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="Needs attention">
          <option value="">Everything</option>
          <option value="ack_breached">No case number in time</option>
          <option value="overdue">Overdue</option>
          <option value="awaiting_verification">Closed, awaiting verification</option>
          <option value="disputed">Closed but not fixed</option>
          <option value="unlinked_dupes">Open, not linked</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={tower} onChange={(e) => setTower(e.target.value)} aria-label="Tower">
          <option value="">All towers</option>
          {me?.community?.towers.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <ErrorNote error={error ?? q.error} />
      {q.loading && !q.data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table admin-table">
            <thead>
              <tr>
                {writer && <th aria-label="Select" />}
                <th>Ref</th>
                <th>Report</th>
                <th>Where</th>
                <th>Status</th>
                <th>Age</th>
                <th>Case no.</th>
                <th>Affected</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((r) => (
                <tr key={r.id} className={r.cluster_id ? 'child' : ''}>
                  {writer && (
                    <td>
                      <input type="checkbox" aria-label={`Select ${r.ref}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((s) => s !== r.id))} />
                    </td>
                  )}
                  <td className="ref">
                    <Link to={`/admin/incidents/${r.id}`}>{r.ref}</Link>
                  </td>
                  <td>
                    <Link to={`/admin/incidents/${r.id}`}>{r.title}</Link>
                    <div className="muted small">
                      {CATEGORY_LABELS[r.category]} {r.source !== 'app' && <span className="pill">{r.source}</span>} {r.visibility === 'private' && <span className="pill">private</span>}
                    </div>
                  </td>
                  <td>
                    {r.tower}
                    <div className="muted small">{r.unit ? `Apt ${r.unit}` : ''}</div>
                  </td>
                  <td>
                    <Stamp status={r.status} />
                  </td>
                  <td>{Math.round(r.kpis.age_days)}d</td>
                  <td>{r.mgmt_case_number ?? '-'}</td>
                  <td>{r.affects_count + 1}</td>
                  <td className="flags">
                    {r.kpis.acknowledgement_sla === 'breached' && !r.mgmt_case_number && <span className="flag bad">No case no.</span>}
                    {r.kpis.resolution_sla === 'breached' && OPEN_STATUSES.includes(r.status) && <span className="flag bad">Overdue</span>}
                    {r.kpis.disputed_closure && <span className="flag bad">Disputed close</span>}
                    {r.status === 'mgmt_closed' && <span className="flag mid">Verify</span>}
                    {r.cluster_id ? <span className="flag">Linked</span> : r.linked_reports > 0 ? <span className="flag">Group of {r.linked_reports + 1}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {linking && q.data && (
        <Sheet title="Link as the same problem" onClose={() => setLinking(false)}>
          <p className="muted">Linked reports stay separate (each was still emailed to management and counts on the scorecard) but are shown together. Pick the main one:</p>
          <div className="stack">
            {q.data.items
              .filter((r) => sel.includes(r.id))
              .map((r) => (
                <label key={r.id} className="check">
                  <input type="radio" name="primary" checked={primary === r.id} onChange={() => setPrimary(r.id)} />
                  <span>
                    {r.ref} {r.title}
                  </span>
                </label>
              ))}
            <button className="btn primary block" onClick={link}>
              Link reports
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function AdminIncident() {
  const { id } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const writer = isWriter(me?.user?.role);
  const q = useAsync(() => api.get<IncidentDetail>(`/admin/incidents/${id}`), [id]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [caseNo, setCaseNo] = useState('');
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);
  const [statusSheet, setStatusSheet] = useState<null | Status>(null);
  const [statusNote, setStatusNote] = useState('');
  const [edit, setEdit] = useState<null | { title: string; description: string; category: string; severity: string; visibility: string }>(null);
  const [chain, setChain] = useState<null | { ok: boolean; events: number; brokenAt?: number }>(null);
  const d = q.data;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      q.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (q.loading && !d) return <div className="page"><Spinner /></div>;
  if (!d) return <div className="page"><ErrorNote error={q.error} /></div>;
  const post = (path: string, body: unknown = {}) => api.post(`/admin/incidents/${d.id}${path}`, body);

  return (
    <div className="page wide">
      <button className="btn ghost small back" onClick={() => nav('/admin/incidents')}>← All reports</button>
      <header className="page-head">
        <div className="card-top">
          <span className="ref">{d.ref}</span>
          <Stamp status={d.status} />
        </div>
        <h1>{d.title}</h1>
        <p className="muted">
          {CATEGORY_LABELS[d.category]} · {d.severity} · {d.tower}, apt {d.unit ?? '?'} · reported {dateTime(d.reported_at)} · source {d.source}
        </p>
        {d.reporter && (
          <p className="small">
            Reporter: {d.reporter.name} · <a href={`mailto:${d.reporter.email}`}>{d.reporter.email}</a>
            {d.reporter.phone ? ` · ${d.reporter.phone}` : ''}
          </p>
        )}
        {d.lat != null && (
          <p className="small muted">
            GPS {d.lat.toFixed(5)}, {d.lng?.toFixed(5)}
          </p>
        )}
      </header>

      <ErrorNote error={error} />
      <PhotoStrip photos={d.photos} />
      {d.description && <p className="desc">{d.description}</p>}
      <KpiStrip d={d} />

      <div className="grid-2">
        <section className="panel stack">
          <h2>Progress</h2>
          <p>
            Case number: <b>{d.mgmt_case_number ?? 'none yet'}</b>
            {d.mgmt_first_reply_at && <span className="muted small"> · first management reply {dateTime(d.mgmt_first_reply_at)}</span>}
          </p>
          {writer && (
            <>
              <form
                className="row"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void run(async () => {
                    await post('/case-number', { case_number: caseNo });
                    setCaseNo('');
                  });
                }}
              >
                <input value={caseNo} onChange={(e) => setCaseNo(e.target.value)} placeholder="Set / update case number" aria-label="Case number" />
                <button className="btn" disabled={busy || caseNo.trim().length < 3}>
                  Save
                </button>
              </form>
              <div className="chips wrap">
                {(['in_progress', 'mgmt_closed', 'resolved_ok', 'resolved_poor', 'reopened', 'withdrawn'] as Status[]).map((s) => (
                  <button key={s} className="chip" disabled={busy || d.status === s} onClick={() => (setStatusNote(''), setStatusSheet(s))}>
                    Mark: {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              <div className="row">
                <button className="btn small" disabled={busy} onClick={() => run(() => post('/resend-email'))}>
                  Re-email management
                </button>
                <button className="btn small" onClick={() => api.get<{ ok: boolean; events: number; brokenAt?: number }>(`/admin/incidents/${d.id}/verify-chain`).then(setChain).catch(setError)}>
                  Verify history integrity
                </button>
                <button className="btn small" onClick={() => setEdit({ title: d.title, description: d.description, category: d.category, severity: d.severity, visibility: d.visibility })}>
                  Edit details
                </button>
              </div>
              {chain && (
                <Banner tone={chain.ok ? 'ok' : 'danger'} title={chain.ok ? 'History intact' : `History altered at event ${chain.brokenAt}`}>
                  {chain.events} events checked against their hash chain.
                </Banner>
              )}
            </>
          )}
        </section>

        <section className="panel stack">
          <h2>Group &amp; residents</h2>
          {d.cluster_id && (
            <p>
              Linked under another report.{' '}
              {writer && (
                <button className="btn small" onClick={() => run(() => post('/unlink'))}>
                  Unlink
                </button>
              )}
            </p>
          )}
          {d.linked.length > 0 && (
            <ul className="plain">
              {d.linked.map((l) => (
                <li key={l.id}>
                  <Link to={`/admin/incidents/${l.id}`}>
                    {l.ref} {l.title}
                  </Link>{' '}
                  <Stamp status={l.status} />
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">{d.affects_count} additional resident(s) affected:</p>
          <ul className="plain small">
            {d.affects?.map((a, i) => (
              <li key={i}>
                {a.tower}, apt {a.unit} · {dateTime(a.at)}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <h2>Full history (including internal)</h2>
        <Timeline events={d.events} />
        {writer && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await post('/note', { text: note, internal });
                setNote('');
              });
            }}
          >
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" maxLength={1500} />
            <div className="row between">
              <Toggle checked={internal} onChange={setInternal} label="Internal only" hint="Hidden from residents" />
              <button className="btn" disabled={busy || !note.trim()}>
                Add note
              </button>
            </div>
          </form>
        )}
      </section>

      {statusSheet && (
        <Sheet title={`Mark: ${STATUS_LABELS[statusSheet]}`} onClose={() => setStatusSheet(null)}>
          <div className="stack">
            {(statusSheet === 'resolved_ok' || statusSheet === 'resolved_poor') && (
              <Banner tone="warn">Moderator overrides without a resident photo are flagged on the timeline. Residents' photo confirmations are stronger evidence.</Banner>
            )}
            <Field label={statusSheet === 'resolved_ok' || statusSheet === 'resolved_poor' ? 'Reason (required)' : 'Note (optional)'}>
              <textarea rows={3} value={statusNote} onChange={(e) => setStatusNote(e.target.value)} maxLength={1000} />
            </Field>
            <button
              className="btn primary block"
              disabled={busy || ((statusSheet === 'resolved_ok' || statusSheet === 'resolved_poor') && !statusNote.trim())}
              onClick={() =>
                run(async () => {
                  await post('/status', { to: statusSheet, note: statusNote || undefined });
                  setStatusSheet(null);
                })
              }
            >
              Confirm
            </button>
          </div>
        </Sheet>
      )}

      {edit && (
        <Sheet title="Edit details" onClose={() => setEdit(null)}>
          <div className="stack">
            <Field label="Title">
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </Field>
            <Field label="Details">
              <textarea rows={3} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <div className="row">
              <Field label="Type">
                <select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>
                  {['low', 'normal', 'high', 'urgent'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Visibility">
              <select value={edit.visibility} onChange={(e) => setEdit({ ...edit, visibility: e.target.value })}>
                <option value="community">Community</option>
                <option value="private">Private</option>
              </select>
            </Field>
            <button className="btn primary block" disabled={busy} onClick={() => run(async () => { await api.patch(`/admin/incidents/${d.id}`, edit); setEdit(null); })}>
              Save changes
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  tower: string | null;
  unit: string | null;
  active: boolean;
  mfa_enabled: boolean;
  reports: number;
  created_at: string;
  last_login_at: string | null;
  deleted: boolean;
  approval_status: 'approved' | 'pending' | 'rejected';
  invited_by: string | null;
}

function AddPerson({ superAdmin, onDone }: { superAdmin: boolean; onDone: () => void }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', tower: '', unit: '', role: 'resident' });
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const towers = me?.community?.towers ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ setup_link: string }>('/admin/users', { ...f, tower: f.tower || undefined, unit: f.unit || undefined });
      setLink(r.setup_link);
      setF({ name: '', email: '', tower: '', unit: '', role: 'resident' });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p>
        <button className="btn primary" onClick={() => setOpen(true)}>
          + Add a person
        </button>
      </p>
    );
  }
  return (
    <section className="panel">
      <h2>Add a person</h2>
      <p className="muted small">They get an email with a link to set their own password (valid 7 days). You can also copy the link and send it yourself.</p>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <Field label="Full name">
            <input value={f.name} onChange={set('name')} required minLength={2} />
          </Field>
          <Field label="Email">
            <input type="email" value={f.email} onChange={set('email')} required />
          </Field>
        </div>
        <div className="row">
          <Field label="Tower / building">
            {towers.length ? (
              <select value={f.tower} onChange={set('tower')}>
                <option value="">Select...</option>
                {towers.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input value={f.tower} onChange={set('tower')} />
            )}
          </Field>
          <Field label="Apartment no.">
            <input value={f.unit} onChange={set('unit')} />
          </Field>
          <Field label="Role">
            <select value={f.role} onChange={set('role')}>
              <option value="resident">Resident</option>
              <option value="committee">Committee (read-only)</option>
              {superAdmin && <option value="admin">Moderator</option>}
              {superAdmin && <option value="super_admin">Super admin</option>}
            </select>
          </Field>
        </div>
        <ErrorNote error={error} />
        {link && (
          <Banner tone="ok" title="Added. Invitation emailed.">
            <p className="small">Email may not be set up on your server yet, so here is their private set-password link:</p>
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Set-password link" />
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                setCopied(await copyText(link));
                setTimeout(() => setCopied(false), 2500);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </Banner>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Adding...' : 'Add and send invitation'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}

export function AdminUsers() {
  const { me } = useAuth();
  const q = useAsync(() => api.get<{ items: UserRow[] }>('/admin/users'), []);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const superAdmin = me?.user?.role === 'super_admin';
  const pending = (q.data?.items ?? []).filter((u) => !u.deleted && u.approval_status === 'pending');

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (ok) setNote(ok);
      q.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>People</h1>
      </header>
      <ErrorNote error={error ?? q.error} />
      {note && <Banner tone="ok">{note}</Banner>}
      {pending.length > 0 && (
        <section className="panel pending-panel">
          <h2>{pending.length} request{pending.length === 1 ? '' : 's'} waiting for approval</h2>
          {pending.map((u) => (
            <div key={u.id} className="pending-row">
              <div>
                <strong>{u.name}</strong>
                <div className="muted small">
                  {u.email} · {u.tower}, {u.unit}
                  {u.invited_by ? ` · invited by ${u.invited_by}` : ''} · {dateTime(u.created_at)}
                </div>
              </div>
              <div className="row">
                <button className="btn primary small" onClick={() => act(() => api.post(`/admin/users/${u.id}/approve`), `${u.name} approved and emailed`)}>
                  Approve
                </button>
                <button className="btn small" onClick={() => confirm(`Decline ${u.name}?`) && act(() => api.post(`/admin/users/${u.id}/decline`), `${u.name} declined`)}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <AddPerson superAdmin={superAdmin} onDone={() => q.reload()} />
      {q.loading && !q.data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Home</th><th>Role</th><th>2FA</th><th>Reports</th><th>Last sign-in</th><th /></tr>
            </thead>
            <tbody>
              {q.data?.items.filter((u) => !u.deleted && u.approval_status === 'approved').map((u) => (
                <tr key={u.id} className={u.active ? '' : 'muted'}>
                  <td>
                    {u.name}
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td>{u.tower ? `${u.tower}, ${u.unit}` : '-'}</td>
                  <td>
                    <select
                      value={u.role}
                      disabled={u.id === me?.user?.id || (!superAdmin && (u.role === 'admin' || u.role === 'super_admin'))}
                      onChange={(e) => act(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }))}
                      aria-label={`Role for ${u.name}`}
                    >
                      <option value="resident">Resident</option>
                      <option value="committee">Committee (read-only)</option>
                      {superAdmin && <option value="admin">Moderator</option>}
                      {superAdmin && <option value="super_admin">Super admin</option>}
                    </select>
                  </td>
                  <td>{u.mfa_enabled ? 'On' : '-'}</td>
                  <td>{u.reports}</td>
                  <td>{u.last_login_at ? dateTime(u.last_login_at) : 'never'}</td>
                  <td className="row">
                    <button className="btn small" onClick={() => act(() => api.post(`/admin/users/${u.id}/reset-password`), `Reset link emailed to ${u.email}`)}>
                      Reset password
                    </button>
                    {superAdmin && u.mfa_enabled && (
                      <button className="btn small" onClick={() => confirm(`Reset two-factor for ${u.name}?`) && act(() => api.post(`/admin/users/${u.id}/reset-mfa`), 'Two-factor reset')}>
                        Reset 2FA
                      </button>
                    )}
                    {u.id !== me?.user?.id && (
                      <button className="btn small" onClick={() => act(() => api.patch(`/admin/users/${u.id}`, { active: !u.active }))}>
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SettingsResp {
  community: { name: string; mgmt_email: string; towers: string[] };
  settings: {
    require_photo_for_affects: boolean;
    affects_max_per_day: number;
    reports_max_per_day: number;
    case_reminder_hours: number;
    verify_reminder_days: number;
    sla_case_hours: number;
    sla_resolve_days: Record<'urgent' | 'high' | 'normal' | 'low', number>;
    cc_reporter: boolean;
    ai_suggest_enabled: boolean;
    registration_open: boolean;
    whatsapp_group_url: string;
    email_mode: 'resident' | 'platform';
    require_approval: boolean;
    trust_resident_invites: boolean;
    aircon_enabled: boolean;
    odour_enabled: boolean;
    odour_max_per_day: number;
    odour_townhouse_blocks: number[];
    odour_townhouse_units: number;
  };
  ai_available: boolean;
  aircon_available?: boolean;
}

export function AdminSettings() {
  const { me } = useAuth();
  const writer = isWriter(me?.user?.role);
  const q = useAsync(() => api.get<SettingsResp>('/admin/settings'), []);
  const [s, setS] = useState<SettingsResp | null>(null);
  const [towers, setTowers] = useState('');
  const [blocks, setBlocks] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data) {
      setS(q.data);
      setTowers(q.data.community.towers.join('\n'));
      setBlocks((q.data.settings.odour_townhouse_blocks ?? []).join(', '));
    }
  }, [q.data]);
  if (!s) return <div className="page"><Spinner /></div>;
  const set = <K extends keyof SettingsResp['settings']>(k: K, v: SettingsResp['settings'][K]) => setS({ ...s, settings: { ...s.settings, [k]: v } });
  const num = (k: 'affects_max_per_day' | 'reports_max_per_day' | 'case_reminder_hours' | 'verify_reminder_days' | 'sla_case_hours') => (e: { target: { value: string } }) => set(k, Number(e.target.value));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await api.patch('/admin/settings', { name: s!.community.name, mgmt_email: s!.community.mgmt_email, towers: towers.split('\n').map((t) => t.trim()).filter(Boolean), settings: { ...s!.settings, odour_townhouse_blocks: [...new Set(blocks.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 20))].sort((a, b) => a - b) } });
      setMsg('Settings saved.');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <form className="stack" onSubmit={save}>
        <fieldset disabled={!writer} className="panel stack">
          <h2>Resident tabs</h2>
          <p className="muted">Choose which optional features residents can see. Turning one off hides its tab; nothing is deleted.</p>
          <Toggle checked={s.settings.odour_enabled} onChange={(v) => set('odour_enabled', v)} label="Smells tab" hint="Smell reporting. Off hides the tab and stops new reports; existing reports stay visible to admins." />
          <Toggle checked={s.settings.aircon_enabled} onChange={(v) => set('aircon_enabled', v)} label="AirCon tab" hint={s.aircon_available ? 'Fresh-air temperature and humidity per tower, plus outside conditions, from Home Assistant.' : 'Fresh-air temperature and humidity from Home Assistant. Home Assistant is not connected yet (see the setup guide), so the tab will stay hidden even when this is ticked.'} />
        </fieldset>

        <fieldset disabled={!writer} className="panel stack">
          <h2>Where reports go</h2>
          <Field label="Community name" hint="Shown at the top of the dashboard.">
            <input value={s.community.name} onChange={(e) => setS({ ...s, community: { ...s.community, name: e.target.value } })} required minLength={2} maxLength={80} />
          </Field>
          <Field label="Management email address" hint="Every report and 'affects me' is emailed here. Check this before real use.">
            <input type="email" value={s.community.mgmt_email} onChange={(e) => setS({ ...s, community: { ...s.community, mgmt_email: e.target.value } })} required />
          </Field>
          <Field label="How reports reach management" hint="Default: the resident sends the email from their own email app, so it comes from them, and the platform records it. 'Platform' means the server sends it for them instead.">
            <select value={s.settings.email_mode ?? 'resident'} onChange={(e) => set('email_mode', e.target.value as 'resident' | 'platform')}>
              <option value="resident">Resident sends from their own email app (default)</option>
              <option value="platform">Platform sends the email</option>
            </select>
          </Field>
          <Toggle checked={s.settings.cc_reporter} onChange={(v) => set('cc_reporter', v)} label="Copy the reporter on the email" hint="Shares the resident's email address with management." />
          <Field label="Towers (one per line)">
            <textarea rows={4} value={towers} onChange={(e) => setTowers(e.target.value)} />
          </Field>
        </fieldset>

        <fieldset disabled={!writer} className="panel stack">
          <h2>Keeping the platform useful</h2>
          <Toggle checked={s.settings.require_photo_for_affects} onChange={(v) => set('require_photo_for_affects', v)} label="Require a new photo for 'Affects me'" hint="Stops people clicking through every report. Turn off if participation is low." />
          <div className="row">
            <Field label="'Affects me' per resident per day">
              <input type="number" min={1} max={100} value={s.settings.affects_max_per_day} onChange={num('affects_max_per_day')} />
            </Field>
            <Field label="New reports per resident per day">
              <input type="number" min={1} max={100} value={s.settings.reports_max_per_day} onChange={num('reports_max_per_day')} />
            </Field>
          </div>
          <Field label="WhatsApp group invite link (optional)" hint="Adds a 'Post in our WhatsApp group' button when residents share. WhatsApp cannot pre-fill a group post, so the message is copied and the group opens for pasting. Looks like https://chat.whatsapp.com/XXXX">
            <input type="url" value={s.settings.whatsapp_group_url ?? ''} onChange={(e) => set('whatsapp_group_url', e.target.value)} placeholder="https://chat.whatsapp.com/..." />
          </Field>
          <Toggle checked={s.settings.require_approval} onChange={(v) => set('require_approval', v)} label="Approve new sign-ups" hint="On (recommended): every new person asks to join and an admin approves them one by one under People. Off: anyone can sign up and get in straight away." />
          <Toggle checked={s.settings.trust_resident_invites} onChange={(v) => set('trust_resident_invites', v)} label="Trust residents' invite links" hint="People who join through a resident's personal invite link skip approval. Off means every request waits for you." />
          <Toggle checked={s.settings.registration_open} onChange={(v) => set('registration_open', v)} label="Registration open" />
          <Toggle checked={s.settings.ai_suggest_enabled} onChange={(v) => set('ai_suggest_enabled', v)} label="AI-drafted titles from photos" hint={s.ai_available ? 'Sends the photo to the AI provider configured on the server. Check privacy approval first.' : 'No AI provider is configured on the server, so a free keyword-based draft is used.'} />
        </fieldset>

        <fieldset disabled={!writer} className="panel stack">
          <h2>Targets used on the scorecard</h2>
          <div className="row">
            <Field label="Case number due within (hours)">
              <input type="number" min={1} value={s.settings.sla_case_hours} onChange={num('sla_case_hours')} />
            </Field>
            <Field label="Remind reporter after (hours)">
              <input type="number" min={1} value={s.settings.case_reminder_hours} onChange={num('case_reminder_hours')} />
            </Field>
            <Field label="Chase 'closed' after (days)">
              <input type="number" min={1} value={s.settings.verify_reminder_days} onChange={num('verify_reminder_days')} />
            </Field>
          </div>
          <span className="field-label">Fix within (days) by priority</span>
          <div className="row">
            {(['urgent', 'high', 'normal', 'low'] as const).map((k) => (
              <Field key={k} label={k === 'urgent' ? 'Safety risk' : k[0].toUpperCase() + k.slice(1)}>
                <input type="number" min={0.5} step={0.5} value={s.settings.sla_resolve_days[k]} onChange={(e) => set('sla_resolve_days', { ...s.settings.sla_resolve_days, [k]: Number(e.target.value) })} />
              </Field>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={!writer} className="panel stack">
          <h2>Smell reports</h2>
          <div className="row">
            <Field label="Reports per resident per day">
              <input type="number" min={1} max={100} value={s.settings.odour_max_per_day} onChange={(e) => set('odour_max_per_day', Number(e.target.value))} />
            </Field>
            <Field label="Townhouses per block" hint="Numbers offered when someone picks a townhouse block.">
              <input type="number" min={1} max={40} value={s.settings.odour_townhouse_units} onChange={(e) => set('odour_townhouse_units', Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Townhouse blocks included (comma separated)" hint="For example 1, 2, 3. Leave out blocks you are not tracking yet. Towers come from the towers list above: remove a tower there to hide it from smell reporting.">
            <input value={blocks} onChange={(e) => setBlocks(e.target.value)} />
          </Field>
        </fieldset>
        {msg && <Banner tone="ok">{msg}</Banner>}
        <ErrorNote error={error} />
        {writer && <button className="btn primary block">Save settings</button>}
      </form>
    </div>
  );
}

export function AdminData() {
  const { me } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<null | { dry_run: boolean; rows: number; imported: number; errors: { row: number; error: string }[] }>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const audit = useAsync(() => api.get<{ items: { id: string; at: string; action: string; actor_role: string | null; target_type: string | null; detail: Record<string, unknown> }[] }>('/admin/audit'), []);

  async function importCsv(dry: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('dry_run', String(dry));
      setResult(await api.upload('/admin/import', form));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Data</h1>
      </header>

      <section className="panel stack">
        <h2>Import existing issues</h2>
        <p className="muted small">
          CSV columns: <code>title, description, category, severity, tower, unit, location, reported_at, status, case_number, emailed_at, resolved_at, reporter_email</code>. Dates are day-first (e.g. 21/09/2026 14:30) in Dubai time. Status can be open, in progress, closed, resolved, poorly resolved or reopened. Imported rows are not emailed to management.
        </p>
        <a className="btn small" href={`data:text/csv;charset=utf-8,${encodeURIComponent('title,description,category,severity,tower,unit,location,reported_at,status,case_number,emailed_at,resolved_at,reporter_email\nWater leak in B2,Drip near bay 214,plumbing_leak,high,MR 1,1204,Car park B2,21/09/2026 14:30,open,SR-10234,21/09/2026 14:35,,\n')}`} download="import-template.csv">
          Download template
        </a>
        <input type="file" accept=".csv,text/csv" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setResult(null))} />
        <div className="row">
          <button className="btn" disabled={!file || busy} onClick={() => importCsv(true)}>
            Check file
          </button>
          <button className="btn primary" disabled={!file || busy} onClick={() => importCsv(false)}>
            Import
          </button>
        </div>
        <ErrorNote error={error} />
        {result && (
          <Banner tone={result.errors.length ? 'warn' : 'ok'} title={`${result.dry_run ? 'Checked' : 'Imported'} ${result.imported} of ${result.rows} rows`}>
            {result.errors.length > 0 && (
              <ul className="plain small">
                {result.errors.map((e) => (
                  <li key={e.row}>
                    Row {e.row}: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </section>

      <section className="panel stack">
        <h2>Export</h2>
        <p className="muted small">Every report with its dates, status, case number and how many residents are affected. The Excel file is formatted for reading and sending (summary sheet, filters, dates in Dubai time); the CSV has the raw values.</p>
        <div className="row">
          <a className="btn primary" href="/api/admin/export.xlsx" download>
            Download all reports (Excel)
          </a>
          <a className="btn" href="/api/admin/export.csv" download>
            Download all reports (CSV)
          </a>
        </div>
      </section>

      {me?.user?.role === 'super_admin' && (
        <section className="panel stack">
          <h2>Demo data</h2>
          <p className="muted small">Removes the sample reports and demo accounts (@pilot.test) created for testing. Real reports are untouched.</p>
          <button
            className="btn bad"
            onClick={() => confirm('Remove all demo reports and demo accounts?') && api.post<{ removed_incidents: number }>('/admin/demo/wipe').then((r) => alert(`Removed ${r.removed_incidents} demo reports`)).catch(setError)}
          >
            Remove demo data
          </button>
        </section>
      )}

      <section className="panel">
        <h2>Audit trail</h2>
        {audit.data ? (
          <table className="table small">
            <thead>
              <tr><th>When</th><th>Action</th><th>By</th></tr>
            </thead>
            <tbody>
              {audit.data.items.slice(0, 60).map((a) => (
                <tr key={a.id}>
                  <td>{dateTime(a.at)}</td>
                  <td>{a.action}</td>
                  <td>{a.actor_role ?? 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Spinner />
        )}
      </section>
    </div>
  );
}
