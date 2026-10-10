import { useState } from 'react';
import { api, dateTime } from '../api';
import { Banner, ErrorNote, Spinner, useAsync } from '../ui';
import type { VersionInfo } from '../VersionBar';

interface Ev { id: string; at: string; kind: 'start' | 'update' | 'watchtower'; title: string; message: string; version: string | null; build: string | null }
interface Sys extends VersionInfo { uptime_s: number; watchtower_configured: boolean; watchtower_last: string | null; events: Ev[] }

const KIND: Record<Ev['kind'], string> = { start: 'App started', update: 'App updated', watchtower: 'Watchtower' };

function uptime(s: number) {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} days`;
}

export function AdminSystem() {
  const sys = useAsync(() => api.get<Sys>('/admin/system'), []);
  const [kind, setKind] = useState<'all' | Ev['kind']>('all');
  const d = sys.data;
  const events = (d?.events ?? []).filter((e) => kind === 'all' || e.kind === kind);
  return (
    <div className="page">
      <h1>System and updates</h1>
      <p className="muted">Which version is running, and the history of updates. Check the version at the very top of any page against this.</p>
      <ErrorNote error={sys.error} />
      {sys.loading && !d && <Spinner />}
      {d && (
        <>
          <div className="sys-grid">
            <div className="tile"><span>Version</span><b>v{d.version}</b></div>
            <div className="tile"><span>Build</span><b>{d.build}</b></div>
            <div className="tile"><span>Code</span><b>{d.sha}</b></div>
            <div className="tile"><span>Built</span><b>{d.built_at ? dateTime(d.built_at) : 'n/a'}</b></div>
            <div className="tile"><span>Running since</span><b>{dateTime(d.started_at)}</b></div>
            <div className="tile"><span>Up for</span><b>{uptime(d.uptime_s)}</b></div>
          </div>
          {!d.watchtower_configured && (
            <Banner tone="warn" title="Watchtower is not reporting here yet">
              Add a WATCHTOWER_SECRET to your .env on the server and re-apply the compose file (see the Unraid guide). Until then you will only see "App started / updated" lines, which still tell you when a new version went live.
            </Banner>
          )}
          {d.watchtower_configured && !d.watchtower_last && (
            <Banner tone="info" title="Waiting for Watchtower">
              No Watchtower message has arrived yet. It only speaks when it starts or when it updates something.
            </Banner>
          )}
          <div className="chips" role="group" aria-label="Filter">
            {(['all', 'update', 'start', 'watchtower'] as const).map((k) => (
              <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                {k === 'all' ? 'Everything' : KIND[k]}
              </button>
            ))}
            <button className="chip" onClick={sys.reload}>Refresh</button>
          </div>
          <div className="sys-log">
            {events.length === 0 && <p className="muted">Nothing here yet.</p>}
            {events.map((e) => (
              <div key={e.id} className={`sys-ev k-${e.kind}`}>
                <strong>{e.title}</strong> <time>{dateTime(e.at)} · {KIND[e.kind]}</time>
                {e.message && <pre>{e.message}</pre>}
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginTop: '1rem' }}>
            Full Watchtower log: in Unraid, open the <b>Docker</b> tab, click the <b>watchtower</b> icon and choose <b>Logs</b>.
          </p>
        </>
      )}
    </div>
  );
}
