import { useEffect, useMemo, useState } from 'react';
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
interface History {
  hours: string[];
  series: Partial<Record<MetricKey, (number | null)[]>>;
}
interface AirData {
  enabled: boolean;
  switched_off?: boolean;
  unreachable?: boolean;
  fetched_at?: string;
  outside?: { temperature: Reading; humidity: Reading };
  towers?: { name: string; temperature: Reading; humidity: Reading; history?: History; metrics?: Partial<Record<(typeof EXTRA_ORDER)[number], Reading>> }[];
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

/** Short note for the small tiles: just the time (or the hour, for hourly averages) and whether it is old. */
function shortNote(r: Reading): string {
  if (r.value == null) return r.updated_at ? `Not reporting, last ${clockTime(r.updated_at)}` : 'Not reporting';
  return `${r.kind === 'hourly' ? 'Hour from' : 'Read'} ${clockTime(r.updated_at)}${r.stale ? ' - old' : ''}`;
}
function clockTime(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
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
function Gauge({ k, r, scale, now, compact }: { k: MetricKey; r: Reading; scale: Scale; now: number; compact?: boolean }) {
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
      <span className="tile-sub">{compact ? shortNote(r) : readingNote(r, now)}</span>
    </div>
  );
}

const SERIES_STYLE: Record<'temperature' | 'humidity' | 'metric', { color: string; dash?: string; width: number }> = {
  temperature: { color: '#c97a0a', width: 2.5 },
  humidity: { color: '#2c6a8f', dash: '7 4', width: 2.5 },
  metric: { color: '#0f4c4c', width: 3.5 },
};
const dubai = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour12: false, ...o }).format(new Date(iso));

/**
 * 24-hour comparison: temperature and humidity against one other sensor the viewer picks. Each line is drawn against its own
 * 24-hour low-to-high range so the shapes can be compared; the real range of each is written in the key and the exact figures
 * for any hour appear under the chart when you point at it (or use the arrow keys).
 */
function TrendChart({ name, history, scales, units }: { name: string; history: History; scales: Partial<Record<MetricKey, Scale>>; units: Partial<Record<MetricKey, string>> }) {
  const options = EXTRA_ORDER.filter((k) => history.series[k] && scales[k]);
  const [pick, setPick] = useState<MetricKey | null>(options[0] ?? null);
  const [hover, setHover] = useState<number | null>(null);
  const metric = pick && options.includes(pick as (typeof EXTRA_ORDER)[number]) ? pick : null;

  const W = 640, H = 210, L = 10, R = 10, T = 12, B = 26;
  const n = history.hours.length;
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const lines = useMemo(() => {
    const keys: { key: MetricKey; style: 'temperature' | 'humidity' | 'metric' }[] = [];
    if (history.series.temperature) keys.push({ key: 'temperature', style: 'temperature' });
    if (history.series.humidity) keys.push({ key: 'humidity', style: 'humidity' });
    if (metric && history.series[metric]) keys.push({ key: metric, style: 'metric' });
    return keys.map(({ key, style }) => {
      const vals = history.series[key]!;
      const nums = vals.filter((v): v is number => v != null);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      const y = (v: number) => T + (1 - (hi === lo ? 0.5 : (v - lo) / (hi - lo))) * (H - T - B);
      let d = '';
      vals.forEach((v, i) => {
        d += v == null ? '' : `${d && vals[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      });
      return { key, style, vals, lo, hi, d, y };
    });
  }, [history, metric]);

  if (!lines.length) return null;
  const label = (k: MetricKey) => (k === 'temperature' ? 'Temperature' : k === 'humidity' ? 'Humidity' : scales[k]?.label ?? k);
  const unit = (k: MetricKey) => { const u = units[k] ?? scales[k]?.unit ?? ''; return u && u !== '%' && u !== '°C' ? ` ${u}` : u; };
  const fmt = (k: MetricKey, v: number | null) => (v == null ? 'no reading' : `${v}${unit(k)}`);
  const at = hover ?? n - 1;
  const ticks = history.hours.map((h, i) => ({ h, i })).filter(({ h }) => Number(dubai(h, { hour: '2-digit' })) % 6 === 0);

  const move = (clientX: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  const summary = lines.map((l) => `${label(l.key)} ${fmt(l.key, l.vals.filter((v) => v != null).at(-1) ?? null)}`).join(', ');

  return (
    <div className="trend" aria-label={`${name} last 24 hours`}>
      <div className="trend-head">
        <h4>Last 24 hours: temperature and humidity against</h4>
        {options.length > 0 && (
          <div className="chips" role="group" aria-label="Compare against">
            {options.map((k) => (
              <button key={k} type="button" className={`chip${metric === k ? ' on' : ''}`} aria-pressed={metric === k} onClick={() => setPick(metric === k ? null : k)}>{scales[k]!.label}</button>
            ))}
          </div>
        )}
      </div>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Line chart, last 24 hours. Latest: ${summary}.`}
        tabIndex={0}
        onPointerMove={(e) => move(e.clientX, e.currentTarget)}
        onPointerDown={(e) => move(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, at - 1)); }
          if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(n - 1, at + 1)); }
        }}
        onBlur={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => <line key={f} x1={L} x2={W - R} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} className="grid" />)}
        {ticks.map(({ h, i }) => (
          <g key={h}>
            <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} className="grid" />
            <text x={x(i)} y={H - 8} textAnchor="middle" className="axis">{dubai(h, { hour: '2-digit', minute: '2-digit' })}</text>
          </g>
        ))}
        {lines.map((l) => <path key={l.key} d={l.d} fill="none" stroke={SERIES_STYLE[l.style].color} strokeWidth={SERIES_STYLE[l.style].width} strokeDasharray={SERIES_STYLE[l.style].dash} strokeLinejoin="round" strokeLinecap="round" />)}
        {hover !== null && <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} className="cursor" />}
        {lines.map((l) => l.vals[at] != null && <circle key={l.key} cx={x(at)} cy={l.y(l.vals[at]!)} r={4.5} fill="var(--paper)" stroke={SERIES_STYLE[l.style].color} strokeWidth={2.5} />)}
      </svg>
      <ul className="trend-key">
        {lines.map((l) => (
          <li key={l.key}>
            <svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke={SERIES_STYLE[l.style].color} strokeWidth={SERIES_STYLE[l.style].width} strokeDasharray={SERIES_STYLE[l.style].dash} strokeLinecap="round" /></svg>
            <span><b>{label(l.key)}</b> <span className="muted">24 h range {l.lo} to {l.hi}{unit(l.key)}</span></span>
            <span className="trend-val">{fmt(l.key, l.vals[at])}</span>
          </li>
        ))}
      </ul>
      <p className="muted small trend-note">{dubai(history.hours[at], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{hover === null ? ' (latest hour). Point at the chart for other hours.' : ''} Hourly averages. Each line is scaled to its own 24-hour range, so compare the shapes, not the heights.</p>
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
              <div className="tiles tiles-main">
                {scales.temperature ? <Gauge k="temperature" r={t.temperature} scale={{ ...scales.temperature, label: 'Fresh-air temperature' }} now={now} /> : <Figure label="Fresh-air temperature" r={t.temperature} unit="°C" now={now} />}
                {scales.humidity ? <Gauge k="humidity" r={t.humidity} scale={{ ...scales.humidity, label: 'Fresh-air humidity' }} now={now} /> : <Figure label="Fresh-air humidity" r={t.humidity} unit="%" now={now} />}
              </div>
              {EXTRA_ORDER.some((k) => t.metrics?.[k] && scales[k]) && (
                <div className="tiles tiles-small">
                  {EXTRA_ORDER.map((k) => {
                    const r = t.metrics?.[k];
                    const sc = scales[k];
                    return r && sc ? <Gauge key={k} k={k} r={r} scale={sc} now={now} compact /> : null;
                  })}
                </div>
              )}
              {t.history && (
                <TrendChart
                  name={t.name}
                  history={t.history}
                  scales={scales}
                  units={{ temperature: '°C', humidity: '%', ...Object.fromEntries(EXTRA_ORDER.map((k) => [k, t.metrics?.[k]?.unit ?? scales[k]?.unit ?? ''])) }}
                />
              )}
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
