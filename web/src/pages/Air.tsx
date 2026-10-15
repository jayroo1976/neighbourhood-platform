import { useEffect, useState } from 'react';
import { api } from '../api';
import { Banner, ErrorNote, Spinner } from '../ui';

interface Reading {
  value: number | null;
  unit: string | null;
  updated_at: string | null;
  stale: boolean;
}
interface AirData {
  enabled: boolean;
  unreachable?: boolean;
  fetched_at?: string;
  outside?: { temperature: Reading };
  towers?: { name: string; temperature: Reading; humidity: Reading }[];
}

const REFRESH_MS = 60_000;

function ago(iso: string | null, now: number): string {
  if (!iso) return 'no reading';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function Figure({ label, r, unit, now }: { label: string; r: Reading; unit: string; now: number }) {
  const has = r.value != null;
  return (
    <div className={`tile ${r.stale ? 'mid' : ''}`}>
      <span className="tile-label">{label}</span>
      <b>{has ? `${r.value}${unit}` : '-'}</b>
      <span className="tile-sub">{has ? (r.stale ? `Old reading, ${ago(r.updated_at, now)}` : `Updated ${ago(r.updated_at, now)}`) : 'Sensor not reporting'}</span>
    </div>
  );
}

export function Air() {
  const [data, setData] = useState<AirData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get<AirData>('/air')
        .then((d) => live && (setData(d), setError(null), setNow(Date.now())))
        .catch((e) => live && setError(e));
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>Air</h1>
        <p className="muted">Fresh-air temperature and humidity in each tower, and the temperature outside. These are readings from sensors, shown as recorded. Refreshes every minute.</p>
      </header>
      <ErrorNote error={error} />
      {!data && !error && <Spinner />}
      {data && !data.enabled && <Banner tone="info">The air sensors are not connected yet.</Banner>}
      {data?.unreachable && <Banner tone="warn">The sensor system could not be reached just now. Any figures shown may be out of date.</Banner>}
      {data?.enabled && data.outside && (
        <>
          <h2>Outside</h2>
          <div className="tiles">
            <Figure label="Outside temperature" r={data.outside.temperature} unit="°C" now={now} />
          </div>
          <h2>Inside, by tower</h2>
          {data.towers?.map((t) => (
            <section key={t.name} className="panel" aria-label={t.name}>
              <h3>{t.name}</h3>
              <div className="tiles">
                <Figure label="Fresh-air temperature" r={t.temperature} unit="°C" now={now} />
                <Figure label="Fresh-air humidity" r={t.humidity} unit="%" now={now} />
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
