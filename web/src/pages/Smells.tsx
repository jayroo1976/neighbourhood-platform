import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, dateTime, qs } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field, Spinner, useAsync } from '../ui';

export interface OdourOptions {
  enabled: boolean;
  towers: string[];
  townhouses: string[];
  townhouse_max_unit: number;
  levels: number;
  penthouse_level: number;
  flats_per_level: number;
  flat_types: Record<string, string>;
  penthouse_units: string[];
  level_bands: { id: string; label: string }[];
  types: { id: string; label: string }[];
  where: { id: string; label: string }[];
  frequencies: { id: string; label: string }[];
  strengths: { id: number; label: string }[];
  max_per_day: number;
}

export interface OdourItem {
  id: string;
  building: string;
  kind: 'tower' | 'townhouse';
  level: number;
  flat: number;
  home: string;
  unit_type: string;
  smell_type: string;
  strength: number;
  frequency: string;
  where_noticed: string;
  observed_at: string;
  notes: string | null;
  created_at: string;
}

interface Summary {
  days: number | null;
  min_group: number;
  total: number;
  mine: number;
  by_type: Record<string, number>;
  by_hour: number[];
  buildings: { name: string; kind: string; few: boolean; reports: number | null; homes: number | null; by_type: Record<string, number>; bands: { id: string; label: string; count: number | null; few: boolean }[] }[];
}

/** The floor plan as a row of flats: 1-5 on one side, 6 at the end, 7-11 on the other. The letter is the flat type. */
export function FlatPicker({ opts, level, value, onChange }: { opts: OdourOptions; level: number; value: number; onChange: (n: number) => void }) {
  const penthouse = level === opts.penthouse_level;
  const flats = penthouse ? opts.penthouse_units.map((_, i) => i + 1) : Array.from({ length: opts.flats_per_level }, (_, i) => i + 1);
  const label = (n: number) => (penthouse ? opts.penthouse_units[n - 1] : String(n));
  const type = (n: number) => (penthouse ? '' : opts.flat_types[String(n)]);
  return (
    <div className="flat-picker" role="group" aria-label="Which flat">
      {flats.map((n) => (
        <button
          key={n}
          type="button"
          className={`flat-btn ${value === n ? 'on' : ''} ${!penthouse && n === 6 ? 'end' : ''}`}
          aria-pressed={value === n}
          aria-label={penthouse ? `Penthouse ${label(n)}` : `Flat ${n}, type ${type(n)}`}
          onClick={() => onChange(n)}
        >
          <b>{label(n)}</b>
          {type(n) && <span>{type(n)}</span>}
        </button>
      ))}
    </div>
  );
}

/** "1204" on level 12 means level 12, flat 4. Used only to save the resident a few taps. */
function guessHome(unit: string | null | undefined, opts: OdourOptions): { level: number; flat: number } | null {
  const m = /^(\d{1,2})(\d{2})$/.exec((unit ?? '').trim());
  if (!m) return null;
  const level = Number(m[1]);
  const flat = Number(m[2]);
  return level >= 1 && level <= opts.levels && flat >= 1 && flat <= opts.flats_per_level ? { level, flat } : null;
}

const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export const typeLabel = (opts: OdourOptions | null, id: string) => opts?.types.find((t) => t.id === id)?.label ?? id;
export const whereLabel = (opts: OdourOptions | null, id: string) => opts?.where.find((t) => t.id === id)?.label ?? id;

function Bars({ rows, max }: { rows: { label: string; n: number }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.n / top) * 100}%` }} /></span>
          <span className="bar-n">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}

function ReportForm({ opts, onSaved }: { opts: OdourOptions; onSaved: () => void }) {
  const { me } = useAuth();
  const buildings = useMemo(() => [...opts.towers, ...opts.townhouses], [opts]);
  const guess = useMemo(() => guessHome(me?.user?.unit, opts), [me, opts]);
  const [building, setBuilding] = useState(me?.user?.tower && buildings.includes(me.user.tower) ? me.user.tower : buildings[0] ?? '');
  const [level, setLevel] = useState(guess?.level ?? 1);
  const [flat, setFlat] = useState(guess?.flat ?? 0);
  const [smell, setSmell] = useState('');
  const [strength, setStrength] = useState(2);
  const [frequency, setFrequency] = useState('sometimes');
  const [where, setWhere] = useState('inside');
  const [when, setWhen] = useState(nowLocal());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const isTown = opts.townhouses.includes(building);

  useEffect(() => {
    setFlat(0);
  }, [building, level]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (!flat) return setError(new Error(isTown ? 'Choose your townhouse number.' : 'Tap your flat.'));
    if (!smell) return setError(new Error('Choose what the smell is like.'));
    setBusy(true);
    try {
      await api.post('/odour', {
        building,
        level: isTown ? 0 : level,
        flat,
        smell_type: smell,
        strength,
        frequency,
        where_noticed: where,
        observed_at: new Date(when).toISOString(),
        notes: notes.trim() || undefined,
      });
      setDone(true);
      setSmell('');
      setNotes('');
      setWhen(nowLocal());
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Report a smell</h2>
      <Banner tone="danger" title="Gas or burning?">Leave the area and call 997 first. This page is for patterns, not emergencies.</Banner>
      <Field label="Building">
        <select value={building} onChange={(e) => setBuilding(e.target.value)}>
          {buildings.map((b) => <option key={b}>{b}</option>)}
        </select>
      </Field>
      {!isTown && (
        <>
          <Field label="Level">
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              {Array.from({ length: opts.levels }, (_, i) => i + 1).map((l) => <option key={l} value={l}>Level {l}</option>)}
              <option value={opts.penthouse_level}>Penthouse</option>
            </select>
          </Field>
          <div>
            <span className="field-label">Your flat</span>
            <FlatPicker opts={opts} level={level} value={flat} onChange={setFlat} />
            <span className="hint">Numbers run 1 to 5 along one side, 6 at the end, then 7 to 11 along the other. The letter is the flat type.</span>
          </div>
        </>
      )}
      {isTown && (
        <Field label="Townhouse number">
          <select value={flat || ''} onChange={(e) => setFlat(Number(e.target.value))}>
            <option value="">Choose</option>
            {Array.from({ length: opts.townhouse_max_unit }, (_, i) => i + 1).map((n) => <option key={n} value={n}>No. {n}</option>)}
          </select>
        </Field>
      )}
      <div>
        <span className="field-label">What is it like?</span>
        <div className="chips wrap" role="group" aria-label="Smell type">
          {opts.types.map((t) => (
            <button type="button" key={t.id} className={`chip ${smell === t.id ? 'on' : ''}`} aria-pressed={smell === t.id} onClick={() => setSmell(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div>
        <span className="field-label">How strong?</span>
        <div className="seg" role="group" aria-label="Strength">
          {opts.strengths.map((s) => (
            <button type="button" key={s.id} className={strength === s.id ? 'on' : ''} aria-pressed={strength === s.id} onClick={() => setStrength(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="row">
        <Field label="Where did you notice it?">
          <select value={where} onChange={(e) => setWhere(e.target.value)}>{opts.where.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select>
        </Field>
        <Field label="How often?">
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>{opts.frequencies.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
        </Field>
      </div>
      <Field label="When" hint="Dubai time. Change it if this was earlier.">
        <input type="datetime-local" value={when} max={nowLocal()} onChange={(e) => setWhen(e.target.value)} required />
      </Field>
      <Field label="Anything else? (optional)" hint="No names please. Only you and the committee admins can read this.">
        <textarea rows={2} maxLength={280} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      {done && <Banner tone="ok">Thank you, your report is logged. You can add another if it comes back.</Banner>}
      <button className="btn primary block big" disabled={busy}>{busy ? 'Saving' : 'Log this smell'}</button>
      <p className="hint">Neighbours only see counts per building and group of levels, never your flat. Up to {opts.max_per_day} reports a day.</p>
    </form>
  );
}

function Mine({ opts, items, reload }: { opts: OdourOptions; items: OdourItem[]; reload: () => void }) {
  const [error, setError] = useState<unknown>(null);
  if (!items.length) return null;
  return (
    <section className="panel" aria-label="My smell reports">
      <h2>My reports</h2>
      <ErrorNote error={error} />
      <ul className="plain-list">
        {items.map((i) => (
          <li key={i.id} className="row between mine-row">
            <span>
              <b>{typeLabel(opts, i.smell_type)}</b>, {opts.strengths.find((s) => s.id === i.strength)?.label.toLowerCase()}
              <br />
              <span className="muted">{i.building}, {i.home} · {dateTime(i.observed_at)}</span>
            </span>
            <button
              className="btn small bad"
              onClick={async () => {
                try {
                  await api.delete(`/odour/${i.id}`);
                  reload();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Community({ opts }: { opts: OdourOptions }) {
  const [days, setDays] = useState(30);
  const q = useAsync(() => api.get<Summary>(`/odour/summary${qs({ days })}`), [days]);
  const s = q.data;
  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="Time range">
        {[7, 30, 90].map((d) => <button key={d} className={`chip ${days === d ? 'on' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>)}
      </div>
      <ErrorNote error={q.error} />
      {q.loading && !s && <Spinner />}
      {s && (
        <>
          <div className="tiles">
            <div className="tile"><span className="tile-label">Reports</span><b>{s.total}</b></div>
            <div className="tile"><span className="tile-label">From you</span><b>{s.mine}</b></div>
          </div>
          <p className="muted">Counts only. Levels are grouped, and a group with fewer than {s.min_group} reports is shown as "fewer than {s.min_group}" so no single home can be picked out.</p>
          {s.buildings.map((b) => (
            <section key={b.name} className="panel" aria-label={b.name}>
              <h3>{b.name} <span className="muted">· {b.few ? `fewer than ${s.min_group} reports` : `${b.reports} ${b.reports === 1 ? 'report' : 'reports'}`}</span></h3>
              {b.kind === 'tower' ? (
                <div className="bands">
                  {b.bands.map((x) => (
                    <div key={x.id} className={`band ${x.few ? 'few' : x.count ? `heat-${Math.min(4, Math.ceil((x.count / Math.max(1, b.reports ?? 1)) * 4))}` : ''}`}>
                      <span className="tile-label">{x.label}</span>
                      <b>{x.few ? `<${s.min_group}` : x.count}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">Townhouses are shown as one block.</p>
              )}
              {!b.few && (b.reports ?? 0) > 0 && <Bars rows={Object.entries(b.by_type).sort((a, c) => c[1] - a[1]).map(([id, n]) => ({ label: typeLabel(opts, id), n }))} />}
            </section>
          ))}
          <section className="panel">
            <h3>Time of day (Dubai)</h3>
            <div className="hours" role="img" aria-label="Reports by hour of the day">
              {s.by_hour.map((n, h) => (
                <span key={h} title={`${h}:00, ${n}`} className="hour"><span style={{ height: `${(n / Math.max(1, ...s.by_hour)) * 100}%` }} /><i>{h % 6 === 0 ? h : ''}</i></span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function Smells() {
  const opts = useAsync(() => api.get<OdourOptions>('/odour/options'), []);
  const mine = useAsync(() => api.get<{ items: OdourItem[] }>('/odour/mine'), []);
  const [tab, setTab] = useState<'report' | 'community'>('report');
  const o = opts.data;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Smells</h1>
        <p className="muted">Log a smell in your home or building so we can see where and when it happens. Patterns across the towers help management find the cause.</p>
      </header>
      <ErrorNote error={opts.error} />
      {opts.loading && !o && <Spinner />}
      {o && !o.enabled && <Banner tone="info">Smell reporting is switched off at the moment.</Banner>}
      {o?.enabled && (
        <>
          <div className="seg" role="tablist" aria-label="Smells">
            <button role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>Report</button>
            <button role="tab" aria-selected={tab === 'community'} className={tab === 'community' ? 'on' : ''} onClick={() => setTab('community')}>Community view</button>
          </div>
          <div className="smell-body">
            {tab === 'report' ? (
              <>
                <ReportForm opts={o} onSaved={mine.reload} />
                <Mine opts={o} items={mine.data?.items ?? []} reload={mine.reload} />
              </>
            ) : (
              <Community opts={o} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
