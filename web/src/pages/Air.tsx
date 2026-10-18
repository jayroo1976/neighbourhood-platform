import { useEffect, useState } from 'react';
import { api } from '../api';
import { Banner, ErrorNote, Spinner } from '../ui';

type Level = 'good' | 'fair' | 'poor';
type Tower = NonNullable<AirData['towers']>[number];
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
type MetricKey = 'temperature' | 'humidity' | 'dew_point' | 'moisture' | (typeof EXTRA_ORDER)[number];
type ChartKey = 'temperature' | 'humidity' | 'dew_point' | 'moisture';
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
  outside?: { temperature: Reading; humidity: Reading; dew_point?: Reading; moisture?: Reading };
  towers?: { name: string; hidden?: boolean; temperature: Reading; humidity: Reading; dew_point?: Reading; moisture?: Reading; history?: History; metrics?: Partial<Record<(typeof EXTRA_ORDER)[number], Reading>> }[];
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

const TOWER_STYLE = [
  { color: '#0f4c4c', dash: undefined },
  { color: '#c97a0a', dash: '8 4' },
  { color: '#2c6a8f', dash: '2 4' },
];
const dubai = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour12: false, ...o }).format(new Date(iso));

/**
 * One chart for one measure (fresh-air temperature or humidity) with a line per tower on the same axis, last 72 hours of
 * hourly averages. A tower with no current reading keeps its last known reading: the line stops at that reading (ring marker)
 * and a dotted line carries the figure forward to now. The key states each tower's latest figure and when it was read; pointing
 * at the chart (or using the arrow keys) gives the exact figure for each tower at that hour.
 */
const CHART_UNIT: Record<ChartKey, string> = { temperature: '°C', humidity: '%', dew_point: '°C', moisture: ' g/m³' };
const CHART_PAD: Record<ChartKey, number> = { temperature: 0.5, humidity: 2, dew_point: 0.5, moisture: 0.5 };

function CompareChart({ title, k, towers, scale, note }: { title: string; k: ChartKey; towers: { t: Tower; i: number }[]; scale?: Scale; note?: string }) {
  const withData = towers.map(({ t, i }) => ({ t, i, vals: t.history?.series[k] ?? null })).filter((x) => x.vals && x.vals.some((v) => v != null));
  const hours = towers.find(({ t }) => t.history)?.t.history?.hours;
  const [hover, setHover] = useState<number | null>(null);
  if (!hours || !withData.length) return null;

  const unit = CHART_UNIT[k];
  const W = 720, H = 280, L = 46, R = 14, T = 14, B = 30;
  const n = hours.length;
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const all = withData.flatMap((x) => x.vals!.filter((v): v is number => v != null));
  const good = scale?.segments?.find((g) => g.level === 'good');
  let lo = Math.min(...all, good?.from ?? Infinity), hi = Math.max(...all, good?.to ?? -Infinity);
  const pad = Math.max((hi - lo) * 0.08, CHART_PAD[k]);
  const span = hi - lo + 2 * pad;
  const step = (k === 'moisture' ? [0.5, 1, 2, 5, 10] : [1, 2, 5, 10]).find((st) => span / st <= 6) ?? 20;
  lo = Math.floor((lo - pad) / step) * step;
  hi = Math.ceil((hi + pad) / step) * step;
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) yTicks.push(v);
  const ticks = hours.map((h, i) => ({ h, i })).filter(({ h }) => Number(dubai(h, { hour: '2-digit' })) % 12 === 0);
  const at = hover ?? n - 1;

  const lines = withData.map(({ t, i, vals }) => {
    let d = '';
    let last = -1;
    vals!.forEach((v, j) => {
      if (v == null) return;
      d += `${d ? 'L' : 'M'}${x(j).toFixed(1)} ${y(v).toFixed(1)} `; // gaps are bridged: the line carries on from the last reading
      last = j;
    });
    const ended = last < n - 2; // no reading in the latest hours: carry the last known figure forward, dotted
    return { name: t.name, style: TOWER_STYLE[i % TOWER_STYLE.length], vals: vals!, d, last, ended, lastV: vals![last]! };
  });

  const move = (clientX: number, el: SVGSVGElement) => {
    const box = el.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  const summary = lines.map((l) => `${l.name} ${l.lastV}${unit}`).join(', ');

  return (
    <section className="panel trend chart-block" aria-label={title}>
      <h3>{title}</h3>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Line chart of ${title.toLowerCase()}, last 72 hours. Latest known: ${summary}.`}
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
        {good && <rect x={L} width={W - L - R} y={y(Math.min(good.to, hi))} height={Math.max(0, y(Math.max(good.from, lo)) - y(Math.min(good.to, hi)))} className="goodband" />}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="axis">{v}</text>
          </g>
        ))}
        {ticks.map(({ h, i }) => (
          <g key={h}>
            <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} className="grid" />
            <text x={x(i)} y={H - 10} textAnchor="middle" className="axis">{dubai(h, { hour: '2-digit', minute: '2-digit' })}</text>
            {Number(dubai(h, { hour: '2-digit' })) === 0 && <text x={x(i)} y={H - 1} textAnchor="middle" className="axis day">{dubai(h, { day: 'numeric', month: 'short' })}</text>}
          </g>
        ))}
        {lines.map((l) => (
          <g key={l.name}>
            <path d={l.d} fill="none" stroke={l.style.color} strokeWidth={3} strokeDasharray={l.style.dash} strokeLinejoin="round" strokeLinecap="round" />
            {l.ended && <line x1={x(l.last)} x2={x(n - 1)} y1={y(l.lastV)} y2={y(l.lastV)} stroke={l.style.color} strokeWidth={2} strokeDasharray="1 5" strokeLinecap="round" />}
            {l.ended && <circle cx={x(l.last)} cy={y(l.lastV)} r={5} fill="var(--paper)" stroke={l.style.color} strokeWidth={2.5} />}
          </g>
        ))}
        {hover !== null && <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} className="cursor" />}
        {hover !== null && lines.map((l) => l.vals[at] != null && <circle key={l.name} cx={x(at)} cy={y(l.vals[at]!)} r={4.5} fill="var(--paper)" stroke={l.style.color} strokeWidth={2.5} />)}
      </svg>
      <ul className="trend-key">
        {lines.map((l) => (
          <li key={l.name}>
            <svg width="30" height="10" aria-hidden="true"><line x1="1" x2="29" y1="5" y2="5" stroke={l.style.color} strokeWidth={3} strokeDasharray={l.style.dash} strokeLinecap="round" /></svg>
            <span><b>{l.name}</b> <span className="muted">{hover === null ? (l.ended ? `last known reading, ${dubai(hours[l.last], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'latest hour') : 'at this hour'}</span></span>
            <span className="trend-val">{hover === null ? `${l.lastV}${unit}` : l.vals[at] == null ? 'no reading' : `${l.vals[at]}${unit}`}</span>
          </li>
        ))}
      </ul>
      <p className="muted small trend-note">{hover === null ? 'Point at the chart to read a particular hour. ' : `${dubai(hours[at], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. `}Hourly averages, last 72 hours.{good ? ` Shaded band is the Good range (${good.from} to ${good.to}${unit}).` : ''} A ringed point with a dotted line means no newer reading, so the last known figure is carried forward.{note ? ` ${note}` : ''}</p>
    </section>
  );
}

const TABLE_ROWS: { k: ChartKey; label: string; unit: string }[] = [
  { k: 'temperature', label: 'Temperature', unit: '°C' },
  { k: 'humidity', label: 'Humidity', unit: '%' },
  { k: 'dew_point', label: 'Dew point', unit: '°C' },
  { k: 'moisture', label: 'Moisture in the air', unit: ' g/m³' },
];

/** The four readings every tower and the outside share, side by side. Each cell says the figure, the Good / Fair / Poor word and "old reading" where it applies. Words wrap so all columns fit a phone without sideways scrolling. */
function GlanceTable({ outside, towers }: { outside?: AirData['outside']; towers: Tower[] }) {
  const cell = (r: Reading | undefined, unit: string, key: string) => {
    if (!r || r.value == null) return <td key={key} className="na">-</td>;
    const word = r.stale ? 'old reading' : r.level ? LEVEL_TEXT[r.level] : '';
    return (
      <td key={key} className={r.stale ? 'old' : r.level ? `lvl-${r.level}` : ''}>
        <b>{r.value}{unit}</b>
        {word && <span className="cell-word">{word}</span>}
      </td>
    );
  };
  return (
    <section className="panel glance" aria-label="All towers at a glance">
      <table className="glance-table">
        <thead>
          <tr>
            <th scope="col">Reading</th>
            {outside && <th scope="col">Outside</th>}
            {towers.map((t) => <th scope="col" key={t.name}>{t.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {TABLE_ROWS.map((r) => (
            <tr key={r.k}>
              <th scope="row">{r.label}</th>
              {outside && cell(outside[r.k], r.unit, 'outside')}
              {towers.map((t) => cell(t[r.k], r.unit, t.name))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Good / Fair / Poor compares each figure with the reference ranges at the bottom of the page. Dew point and moisture are worked out from temperature and humidity, not measured. Dash means no reading.</p>
    </section>
  );
}

export function Air() {
  const [data, setData] = useState<AirData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const [showHidden, setShowHidden] = useState(false);

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
  const allTowers = (data?.towers ?? []).map((t, i) => ({ t, i }));
  const hiddenTowers = allTowers.filter(({ t }) => t.hidden);
  // a hidden tower appears everywhere (tiles, table, charts, printout) only after "Show" is pressed; charts keep each tower's own colour
  const visible = allTowers.filter(({ t }) => !t.hidden || showHidden);

  return (
    <div className="page wide">
      <div className="printonly print-head">
        <h1>AirCon report: fresh-air readings</h1>
        <p>Printed {clock(new Date(now).toISOString())} (Dubai time). Sensor readings shown as recorded: {visible.map(({ t }) => t.name).join(', ')}{data?.outside ? ', and outside' : ''}.</p>
      </div>
      <header className="page-head">
        <h1>AirCon</h1>
        <button type="button" className="chip noprint" onClick={() => window.print()} disabled={!data?.enabled}>Print / save as PDF</button>
        <p className="muted">Fresh-air readings in each tower, and the conditions outside. These are readings from sensors, shown as recorded; the Good / Fair / Poor labels compare each reading with the reference ranges listed at the bottom of this page. Refreshes every minute.</p>
      </header>
      <ErrorNote error={error} />
      {!data && !error && <Spinner />}
      {data && !data.enabled && <Banner tone="info">{data.switched_off ? 'AirCon has been switched off by the admins.' : 'The air sensors are not connected yet.'}</Banner>}
      {data?.unreachable && <Banner tone="warn">The sensor system could not be reached just now. Any figures shown may be out of date.</Banner>}
      {data?.enabled && data.outside && (
        <>
          <h2 className="noprint">Outside</h2>
          <div className="tiles noprint">
            <Figure label="Outside temperature" r={data.outside.temperature} unit="°C" now={now} />
            <Figure label="Outside humidity" r={data.outside.humidity} unit="%" now={now} />
          </div>
          <h2 className="noprint">Inside, by tower</h2>
          {visible.map(({ t }) => (
            <section key={t.name} className="panel noprint" aria-label={t.name}>
              <h3>{t.name}</h3>
              <div className="tiles tiles-main">
                {scales.temperature ? <Gauge k="temperature" r={t.temperature} scale={{ ...scales.temperature, label: 'Fresh-air temperature' }} now={now} /> : <Figure label="Fresh-air temperature" r={t.temperature} unit="°C" now={now} />}
                {scales.humidity ? <Gauge k="humidity" r={t.humidity} scale={{ ...scales.humidity, label: 'Fresh-air humidity' }} now={now} /> : <Figure label="Fresh-air humidity" r={t.humidity} unit="%" now={now} />}
              </div>
            </section>
          ))}
          {hiddenTowers.length > 0 && (
            <div className="noprint hidden-view">
              <button type="button" className="chip" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? 'Hide' : 'Show'} {hiddenTowers.map(({ t }) => t.name).join(' and ')} air readings
              </button>
              {!showHidden && <span className="muted small"> Hidden view: {hiddenTowers.map(({ t }) => t.name).join(', ')} is left out of the table, charts and printout until shown.</span>}
            </div>
          )}
          <h2>All towers at a glance</h2>
          <GlanceTable outside={data.outside} towers={visible.map(({ t }) => t)} />
          {visible.length > 0 && (
            <>
              <h2>Comparing the towers</h2>
              <CompareChart title="Fresh-air temperature, all towers" k="temperature" towers={visible} scale={scales.temperature} />
              <CompareChart title="Fresh-air humidity, all towers" k="humidity" towers={visible} scale={scales.humidity} />
              <CompareChart title="Dew point, all towers" k="dew_point" towers={visible} note="Dew point is worked out from temperature and humidity, not measured: the temperature at which water starts to condense." />
              <CompareChart title="Moisture in the air, all towers" k="moisture" towers={visible} note="Moisture is grams of water vapour per cubic metre of air, worked out from temperature and humidity, not measured." />
            </>
          )}
          <div className="printonly print-defs">
            <h2>How Good, Fair and Poor are decided</h2>
            <p>Each label compares a reading with a fixed range from published guidance. These are not health findings, not a legal standard for the building, and the sensors are not certified instruments. Dew point and moisture are calculated.</p>
            <ul>
              {(['temperature', 'humidity', 'dew_point', 'moisture'] as const).map((k) => (scales[k] ? <li key={k}><b>{scales[k]!.label}{scales[k]!.unit ? ` (${scales[k]!.unit})` : ''}:</b> {scales[k]!.basis}</li> : null))}
            </ul>
          </div>
          <details className="panel noprint">
            <summary><b>How Good, Fair and Poor are decided</b></summary>
            <p className="muted">Each label compares a reading with a fixed range taken from published guidance (uHoo's stated ideal ranges, the WHO 2021 air quality guidelines and US EPA standards), with margins we chose for Fair. A value exactly on a boundary counts in the higher band. These are not health findings, not a legal standard for the building, and the sensors are not certified instruments. Outside readings are not rated.</p>
            <ul className="plain">
              {(['temperature', 'humidity', 'dew_point', 'moisture'] as const).map((k) => (scales[k] ? <li key={k}><b>{scales[k]!.label}{scales[k]!.unit ? ` (${scales[k]!.unit})` : ''}:</b> {scales[k]!.basis}</li> : null))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
