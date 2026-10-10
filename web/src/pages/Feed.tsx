import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORY_LABELS, ago, api, qs, type ListItem } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, Spinner, Stamp, useAsync } from '../ui';

export function IncidentCard({ i }: { i: ListItem }) {
  const reported = i.affects_count + 1;
  return (
    <div className="card incident-card">
      <div className="card-media">
        <Link to={`/incident/${i.id}`} aria-label={`Open ${i.ref}`} className="media-link">
          {i.thumb_url ? <img src={i.thumb_url} alt="" loading="lazy" className="thumb" /> : <div className="thumb placeholder" aria-hidden />}
          <span className="count-badge" title="Residents who have reported this">
            {reported} reported
          </span>
        </Link>
        {i.can_affect && (
          <Link to={`/incident/${i.id}?affects=1`} className="btn small affects-btn">
            This affects me too
          </Link>
        )}
      </div>
      <Link to={`/incident/${i.id}`} className="card-body">
        <div className="card-top">
          <span className="ref">{i.ref}</span>
          <Stamp status={i.status} />
        </div>
        <h3>{i.title}</h3>
        <div className="meta">
          <span>{CATEGORY_LABELS[i.category] ?? i.category}</span>
          <span>{i.tower}</span>
          <span>{ago(i.reported_at)}</span>
        </div>
        <div className="meta strong">
          {i.mgmt_case_number && <span>Case {i.mgmt_case_number}</span>}
          {i.linked_reports > 0 && <span>{i.linked_reports} linked</span>}
          {i.is_mine && <span className="pill">Yours</span>}
          {i.i_affect && <span className="pill">You're affected</span>}
          {i.private && <span className="pill">Private</span>}
        </div>
      </Link>
    </div>
  );
}

function MyStats() {
  const all = useAsync(() => api.get<{ items: ListItem[] }>(`/incidents${qs({ scope: 'mine', state: 'all' })}`), []);
  const items = all.data?.items ?? [];
  if (!items.length) return null;
  const open = (i: ListItem) => ['reported', 'case_number_received', 'in_progress', 'reopened', 'mgmt_closed'].includes(i.status);
  const days = (i: ListItem) => Math.max(0, Math.round((Date.now() - Date.parse(i.reported_at)) / 86_400_000));
  const mine = items.filter((i) => i.is_mine);
  const joined = items.filter((i) => i.i_affect && !i.is_mine);
  const openItems = items.filter(open);
  const noCase = openItems.filter((i) => !i.mgmt_case_number);
  const fixed = items.filter((i) => i.status === 'resolved_ok');
  const oldest = openItems.length ? Math.max(...openItems.map(days)) : null;
  const homes = mine.reduce((n, i) => n + i.affects_count, 0);
  return (
    <section className="my-stats" aria-label="Your reports at a glance">
      <div><b>{mine.length}</b><span>reported by you</span></div>
      <div><b>{joined.length}</b><span>you joined</span></div>
      <div><b>{openItems.length}</b><span>still open</span></div>
      <div><b>{fixed.length}</b><span>fixed</span></div>
      <div><b>{noCase.length}</b><span>no case number yet</span></div>
      <div><b>{homes}</b><span>neighbours joined yours</span></div>
      {oldest != null && <p className="muted small">Your oldest open report is {oldest} {oldest === 1 ? 'day' : 'days'} old.</p>}
    </section>
  );
}

export function Feed() {
  const { me } = useAuth();
  const [scope, setScope] = useState<'community' | 'mine'>('community');
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [tower, setTower] = useState('');
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'recent' | 'affected' | 'oldest'>('recent');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 300);
    return () => clearTimeout(t);
  }, [text]);

  const list = useAsync(() => api.get<{ items: ListItem[]; has_more: boolean }>(`/incidents${qs({ scope, state, tower, q: debounced, sort })}`), [scope, state, tower, debounced, sort]);
  const attention = useAsync(() => api.get<{ items: { id: string; ref: string; title: string; action: 'verify' | 'case_number' }[] }>('/incidents/attention'), []);

  return (
    <div className="page">
      <header className="page-head brand-head">
        <img src="/icons/any/app-96.png" alt="" className="brand-logo" width={56} height={56} />
        <div>
          <h1 className="brand-title">{me?.community?.name ?? 'Community'}</h1>
          <p className="muted">Reports are logged here and emailed to the management company.</p>
        </div>
      </header>

      <Link to="/report" className="report-cta">
        <span className="report-cta-plus" aria-hidden>+</span>
        <span className="report-cta-text">
          <strong>REPORT AN ISSUE</strong>
          <small>Take a photo, then send it from your own email.</small>
        </span>
        <span className="report-cta-go" aria-hidden>&rsaquo;</span>
      </Link>

      {attention.data?.items.length ? (
        <details className="attention">
          <summary>
            <span className="attention-count">{attention.data.items.length}</span>
            {attention.data.items.length === 1 ? '1 incident needs your attention' : `${attention.data.items.length} incidents need your attention`}
            <span className="attention-chevron" aria-hidden>▾</span>
          </summary>
          <ul className="plain">
            {attention.data.items.map((a) => (
              <li key={a.id}>
                <Link to={`/incident/${a.id}`}>
                  {a.ref}: {a.action === 'verify' ? 'Management says closed - is it really fixed?' : 'Did the management company reply with a case number?'}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={scope === 'community'} className={scope === 'community' ? 'on' : ''} onClick={() => setScope('community')}>
          Community
        </button>
        <button role="tab" aria-selected={scope === 'mine'} className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
          My reports
        </button>
      </div>

      <div className="feed-filters">
        <label className="search">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input type="search" placeholder="Search issues" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
        </label>
        <div className="state-tabs" role="radiogroup" aria-label="Show">
          {(['open', 'closed', 'all'] as const).map((st) => (
            <button key={st} role="radio" aria-checked={state === st} className={state === st ? 'on' : ''} onClick={() => setState(st)}>
              {st === 'open' ? 'Open' : st === 'closed' ? 'Closed' : 'All'}
            </button>
          ))}
        </div>
        <div className="selects">
          <select value={tower} onChange={(e) => setTower(e.target.value)} aria-label="Tower">
            <option value="">All towers</option>
            {me?.community?.towers.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="recent">Recent activity</option>
            <option value="affected">Most affected</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>

      <ErrorNote error={list.error} />
      {scope === 'mine' ? <MyStats /> : null}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.items.length ? (
        <div className="list">
          {list.data.items.map((i) => (
            <IncidentCard key={i.id} i={i} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>No reports here yet.</p>
          <Link to="/report" className="btn primary">
            Report an issue
          </Link>
        </div>
      )}
    </div>
  );
}
