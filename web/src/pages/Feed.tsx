import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORY_LABELS, ago, api, qs, type ListItem } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Spinner, Stamp, useAsync } from '../ui';

export function IncidentCard({ i }: { i: ListItem }) {
  return (
    <Link to={`/incident/${i.id}`} className="card incident-card">
      {i.thumb_url ? <img src={i.thumb_url} alt="" loading="lazy" className="thumb" /> : <div className="thumb placeholder" aria-hidden />}
      <div className="card-body">
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
          {i.dh_case_number && <span>Case {i.dh_case_number}</span>}
          {i.affects_count > 0 && <span>{i.affects_count + 1} residents affected</span>}
          {i.linked_reports > 0 && <span>{i.linked_reports} linked</span>}
          {i.is_mine && <span className="pill">Yours</span>}
          {i.i_affect && <span className="pill">You're affected</span>}
          {i.private && <span className="pill">Private</span>}
        </div>
      </div>
    </Link>
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
      <header className="page-head">
        <h1>{me?.community?.name ?? 'Community'}</h1>
        <p className="muted">Everything reported here is also emailed to Dubai Holding.</p>
      </header>

      {attention.data?.items.length ? (
        <Banner tone="warn" title="Needs your attention">
          <ul className="plain">
            {attention.data.items.map((a) => (
              <li key={a.id}>
                <Link to={`/incident/${a.id}`}>
                  {a.ref}: {a.action === 'verify' ? 'Management says closed - is it really fixed?' : 'Did Dubai Holding reply with a case number?'}
                </Link>
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="seg" role="tablist">
        <button role="tab" aria-selected={scope === 'community'} className={scope === 'community' ? 'on' : ''} onClick={() => setScope('community')}>
          Community
        </button>
        <button role="tab" aria-selected={scope === 'mine'} className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
          My reports
        </button>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search issues" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
        <div className="chips">
          {(['open', 'closed', 'all'] as const).map((s) => (
            <button key={s} className={`chip ${state === s ? 'on' : ''}`} onClick={() => setState(s)}>
              {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'All'}
            </button>
          ))}
        </div>
        <div className="row">
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
