import { useEffect, useState } from 'react';
import { api } from '../api';
import { Banner, ErrorNote, Spinner } from '../ui';

type Level = 'good' | 'fair' | 'poor';
interface Reading {
  value: number | null;
  unit: string | null;
  updated_at: string | null;
  stale: boolean;
  kind?: 'live' | 'hourly';
  level?: Level | null;
}
interface Scale {
  label: string;
  unit: string;
  min?: number;
  max?: number;
  segments?: { from: number; to: number; level: Level }[];
  basis: string;
}
const EXTRA_ORDER = ['co2', 'pm25', 'voc', 'co', 'no2', 'o3', 'pressure', 'virus', 'influenza', 'mold'] as const;
type MetricKey = 'temperature' | 'humidity' | (typeof EXTRA_ORDER)[number];
const LEVEL_TEXT: Record<Level, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };
interface AirData {
  enabled: boolean;
  switched_off?: boolean;
  unreachable?: boolean;
  fetched_at?: string;
  outside?: { temperature: Reading; humidity: Reading };
  towers?: { name: string; temperature: Reading; humidity: Reading; metrics?: Partial<Record<(typeof EXTRA_ORDER)[number], Reading>> }[];
  scales?: Partial<Record<MetricKey, Scale>>;
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

/** "15 Oct, 22:04" in the community's time zone, so the exact last reading is visible, not just "3 min ago". */
function clock(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function readingNote(r: Reading, now: number): string {
  const has = r.value != null;
  return has ? `${r.kind === 'hourly' ? 'Hourly average, hour from' : 'Last read'} ${clock(r.updated_at)} (${ago(r.updated_at, now)})${r.stale ? ' - old reading' : ''}` : r.updated_at ? `Sensor not reporting. Last seen ${clock(r.updated_at)}` : 'Sensor not reporting';
}

function Figure({ label, r, unit, now }: { label: string; r: Reading; unit: string; now: number }) {
  const has = r.value != null;
  return (
    <div className={`tile ${r.stale ? 'mid' : ''}`}>
      <span className="tile-label">{label}</span>
      <b>{has ? `${r.value}${unit}` : '-'}</b>
      <span className="tile-sub">{readingNote(r, now)}</span>
    </div>
  );
}

/** A bar split into the good / fair / poor bands with a marker at the reading, and the band written out (colour is never the only signal). */
function Gauge({ k, r, scale, now }: { k: MetricKey; r: Reading; scale: Scale; now: number }) {
  const has = r.value != null;
  const rated = !!(scale.segments && scale.min != null && scale.max != null);
  const unit = r.unit ?? scale.unit;
  const unitText = unit && unit !== '%' && unit !== '°C' ? ` ${unit}` : unit;
  let pos = 0;
  if (rated && has) pos = Math.min(100, Math.max(0, ((r.value! - scale.min!) / (scale.max! - scale.min!)) * 100));
  const level = has && !r.stale ? r.level : null;
  return (
    <div className={`tile gauge-tile ${level ? `lvl-${level}` : ''} ${r.stale ? 'mid' : ''}`} data-metric={k}>
      <span className="tile-label">{scale.label}</span>
      <b>{has ? `${r.value}${unitText}` : '-'}</b>
      {rated && (
        <div className="gauge" role="img" aria-label={has ? `${scale.label} ${r.value}${unitText}${r.level ? `, ${LEVEL_TEXT[r.level]}` : ''}` : `${scale.label}: no reading`}>
          {scale.segments!.map((g, i, all) => (
            <span key={g.from} className={`gband ${g.level}${i === all.length - 1 ? ' last' : ''}`} style={{ width: `${((g.to - g.from) / (scale.max! - scale.min!)) * 100}%` }} />
          ))}
          {has && <span className="pin" style={{ left: `${pos}%` }} />}
        </div>
      )}
      <span className="gauge-level">{!has ? '' : r.stale ? 'Old reading' : r.level ? LEVEL_TEXT[r.level] : 'Not rated'}</span>
      <span className="tile-sub">{readingNote(r, now)}</span>
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

  const scales = data?.scales ?? {};
  const shown = EXTRA_ORDER.filter((k) => scales[k] && data?.towers?.some((t) => t.metrics?.[k]));

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>AirCon</h1>
        <p className="muted">Fresh-air readings in each tower, and the conditions outside. These are readings from sensors, shown as recorded; the Good / Fair / Poor labels compare each reading with the reference ranges listed at the bottom of this page. Refreshes every minute.</p>
      </header>
      <ErrorNote error={error} />
      {!data && !error && <Spinner />}
      {data && !data.enabled && <Banner tone="info">{data.switched_off ? 'AirCon has been switched off by the admins.' : 'The air sensors are not connected yet.'}</Banner>}
      {data?.unreachable && <Banner tone="warn">The sensor system could not be reached just now. Any figures shown may be out of date.</Banner>}
      {data?.enabled && data.outside && (
        <>
          <h2>Outside</h2>
          <div className="tiles">
            <Figure label="Outside temperature" r={data.outside.temperature} unit="°C" now={now} />
            <Figure label="Outside humidity" r={data.outside.humidity} unit="%" now={now} />
          </div>
          <h2>Inside, by tower</h2>
          {data.towers?.map((t) => (
            <section key={t.name} className="panel" aria-label={t.name}>
              <h3>{t.name}</h3>
              <div className="tiles">
                {scales.temperature ? <Gauge k="temperature" r={t.temperature} scale={{ ...scales.temperature, label: 'Fresh-air temperature' }} now={now} /> : <Figure label="Fresh-air temperature" r={t.temperature} unit="°C" now={now} />}
                {scales.humidity ? <Gauge k="humidity" r={t.humidity} scale={{ ...scales.humidity, label: 'Fresh-air humidity' }} now={now} /> : <Figure label="Fresh-air humidity" r={t.humidity} unit="%" now={now} />}
                {EXTRA_ORDER.map((k) => {
                  const r = t.metrics?.[k];
                  const sc = scales[k];
                  return r && sc ? <Gauge key={k} k={k} r={r} scale={sc} now={now} /> : null;
                })}
              </div>
            </section>
          ))}
          <details className="panel">
            <summary><b>How Good, Fair and Poor are decided</b></summary>
            <p className="muted">Each label compares a reading with a fixed range taken from published guidance (uHoo's stated ideal ranges, the WHO 2021 air quality guidelines and US EPA standards), with margins we chose for Fair. A value exactly on a boundary counts in the higher band. These are not health findings, not a legal standard for the building, and the sensors are not certified instruments. Outside readings are not rated.</p>
            <ul className="plain">
              {(['temperature', 'humidity', ...shown] as MetricKey[]).map((k) => (scales[k] ? <li key={k}><b>{scales[k]!.label}{scales[k]!.unit ? ` (${scales[k]!.unit})` : ''}:</b> {scales[k]!.basis}</li> : null))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
