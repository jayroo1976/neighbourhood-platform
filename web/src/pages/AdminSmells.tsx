import { useMemo, useState } from 'react';
import { api, dateTime, qs } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Spinner, useAsync } from '../ui';
import { typeLabel, whereLabel, type OdourItem, type OdourOptions } from './Smells';

interface Resp {
  items: OdourItem[];
  options: OdourOptions;
}

type Pick = { building: string; level: number; flat: number } | null;

const heat = (n: number, max: number) => (n === 0 ? '' : `heat-${Math.min(4, Math.max(1, Math.ceil((n / Math.max(1, max)) * 4)))}`);

/** One tower as it is built: levels from the top down, flats 1-5 | 6 | 7-11, penthouses on top. */
function Elevation({ name, opts, items, pick, onPick }: { name: string; opts: OdourOptions; items: OdourItem[]; pick: Pick; onPick: (p: Pick) => void }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (i.building === name) m.set(`${i.level}-${i.flat}`, (m.get(`${i.level}-${i.flat}`) ?? 0) + 1);
    return m;
  }, [items, name]);
  const max = Math.max(1, ...counts.values());
  const levels = [opts.penthouse_level, ...Array.from({ length: opts.levels }, (_, i) => opts.levels - i)];
  return (
    <div className="elev" role="table" aria-label={`${name} plan`}>
      <div className="elev-head" role="row">
        <span />
        {Array.from({ length: opts.flats_per_level }, (_, i) => i + 1).map((f) => (
          <span key={f} className={f === 6 ? 'end' : ''}>{f}<i>{opts.flat_types[String(f)]}</i></span>
        ))}
      </div>
      {levels.map((l) => {
        const ph = l === opts.penthouse_level;
        const n = ph ? opts.penthouse_units.length : opts.flats_per_level;
        return (
          <div className="elev-row" role="row" key={l}>
            <span className="elev-level">{ph ? 'PH' : l}</span>
            {Array.from({ length: opts.flats_per_level }, (_, i) => i + 1).map((f) => {
              if (f > n) return <span key={f} className="cell void" />;
              const c = counts.get(`${l}-${f}`) ?? 0;
              const on = pick?.building === name && pick.level === l && pick.flat === f;
              return (
                <button
                  key={f}
                  type="button"
                  className={`cell ${heat(c, max)} ${on ? 'sel' : ''} ${!ph && f === 6 ? 'end' : ''}`}
                  title={`${ph ? 'Penthouse ' + opts.penthouse_units[f - 1] : `Level ${l}, flat ${f}`}: ${c} ${c === 1 ? 'report' : 'reports'}`}
                  aria-label={`${ph ? 'Penthouse ' + opts.penthouse_units[f - 1] : `Level ${l}, flat ${f}`}, ${c} reports`}
                  onClick={() => onPick(on ? null : { building: name, level: l, flat: f })}
                >
                  {c || ''}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Townhouses({ name, opts, items, pick, onPick }: { name: string; opts: OdourOptions; items: OdourItem[]; pick: Pick; onPick: (p: Pick) => void }) {
  const counts = new Map<number, number>();
  for (const i of items) if (i.building === name) counts.set(i.flat, (counts.get(i.flat) ?? 0) + 1);
  const max = Math.max(1, ...counts.values());
  return (
    <div className="th-grid">
      {Array.from({ length: opts.townhouse_max_unit }, (_, i) => i + 1).map((n) => {
        const c = counts.get(n) ?? 0;
        const on = pick?.building === name && pick.flat === n;
        return (
          <button key={n} type="button" className={`cell ${heat(c, max)} ${on ? 'sel' : ''}`} title={`${name}, No. ${n}: ${c}`} aria-label={`${name}, number ${n}, ${c} reports`} onClick={() => onPick(on ? null : { building: name, level: 0, flat: n })}>
            <i>{n}</i>{c || ''}
          </button>
        );
      })}
    </div>
  );
}

/** Patterns worth a look, worked out from the reports in view. */
function patterns(items: OdourItem[], towers: string[]) {
  const out: string[] = [];
  for (const t of towers) {
    const rs = items.filter((i) => i.building === t && i.kind === 'tower' && i.level <= 13);
    // The same flat position on many levels is one vertical stack: a shared riser or duct.
    for (let f = 1; f <= 11; f++) {
      const lv = new Set(rs.filter((r) => r.flat === f).map((r) => r.level));
      if (lv.size >= 3) out.push(`${t}: flat ${f} on ${lv.size} different levels (${[...lv].sort((a, b) => a - b).join(', ')}). Same stack, possibly a shared riser or duct.`);
    }
    // Several flats on one level points at the corridor or that floor's plant.
    const byLevel = new Map<number, Set<number>>();
    for (const r of rs) byLevel.set(r.level, (byLevel.get(r.level) ?? new Set()).add(r.flat));
    for (const [l, fl] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) if (fl.size >= 3) out.push(`${t}: ${fl.size} flats on level ${l} have reported (${[...fl].sort((a, b) => a - b).join(', ')}).`);
  }
  return out;
}

export function AdminSmells() {
  const { me } = useAuth();
  const canDelete = me?.user?.role === 'admin' || me?.user?.role === 'super_admin';
  const [days, setDays] = useState(30);
  const [type, setType] = useState('');
  const [where, setWhere] = useState('');
  const [pick, setPick] = useState<Pick>(null);
  const [error, setError] = useState<unknown>(null);
  const q = useAsync(() => api.get<Resp>(`/admin/odour${qs({ days: days || undefined, type, where })}`), [days, type, where]);
  const opts = q.data?.options ?? null;
  const items = q.data?.items ?? [];
  const shown = pick ? items.filter((i) => i.building === pick.building && i.flat === pick.flat && (pick.level === 0 || i.level === pick.level)) : items;
  const found = useMemo(() => (opts ? patterns(items, opts.towers) : []), [items, opts]);

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>Smells</h1>
        <p className="muted">Exact flats, visible to admins only. Tap a flat to filter the log. Darker means more reports.</p>
      </header>
      <div className="row filters">
        <div className="chips" role="group" aria-label="Time range">
          {[7, 30, 90, 0].map((d) => <button key={d} className={`chip ${days === d ? 'on' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>{d ? `${d} days` : 'All time'}</button>)}
        </div>
        <select aria-label="Smell type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All smell types</option>
          {opts?.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select aria-label="Where noticed" value={where} onChange={(e) => setWhere(e.target.value)}>
          <option value="">Anywhere</option>
          {opts?.where.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <a className="btn small" href="/api/admin/odour/export.csv" download>Download CSV</a>
        <a className="btn small primary" href={`/api/admin/odour/export.pdf${qs({ days: days || undefined, type, where })}`} download title="Summary for the management company: counts, charts, plan view of flats and the log. Follows the filters above. Notes are left out.">Download PDF</a>
      </div>
      <ErrorNote error={q.error ?? error} />
      {q.loading && !q.data && <Spinner />}
      {opts && !opts.enabled && <Banner tone="info">Resident reporting is switched off in Settings. Existing reports are still shown here.</Banner>}
      {opts && (
        <>
          <div className="tiles">
            <div className="tile"><span className="tile-label">Reports</span><b>{items.length}</b></div>
            <div className="tile"><span className="tile-label">Homes</span><b>{new Set(items.map((i) => `${i.building}|${i.level}|${i.flat}`)).size}</b></div>
          </div>
          {found.length > 0 && (
            <Banner tone="warn" title="Patterns to look at">
              <ul>{found.map((f) => <li key={f}>{f}</li>)}</ul>
            </Banner>
          )}
          <div className="elev-wrap">
            {opts.towers.map((t) => (
              <section className="panel" key={t} aria-label={t}>
                <h2>{t} <span className="muted">· {items.filter((i) => i.building === t).length}</span></h2>
                <Elevation name={t} opts={opts} items={items} pick={pick} onPick={setPick} />
              </section>
            ))}
          </div>
          {opts.townhouses.length > 0 && (
            <div className="elev-wrap">
              {opts.townhouses.map((t) => (
                <section className="panel" key={t} aria-label={t}>
                  <h2>{t} <span className="muted">· {items.filter((i) => i.building === t).length}</span></h2>
                  <Townhouses name={t} opts={opts} items={items} pick={pick} onPick={setPick} />
                </section>
              ))}
            </div>
          )}
          <section className="panel">
            <div className="row between">
              <h2>Log{pick ? ` for ${pick.building}${pick.level ? `, level ${pick.level}` : ''}, ${pick.level ? 'flat' : 'no.'} ${pick.flat}` : ''}</h2>
              {pick && <button className="btn small" onClick={() => setPick(null)}>Show all</button>}
            </div>
            {shown.length === 0 ? (
              <p className="muted">No reports for this view.</p>
            ) : (
              <div className="table-wrap">
                <table className="table small">
                  <thead><tr><th>When (Dubai)</th><th>Home</th><th>Smell</th><th>Strength</th><th>Where</th><th>Notes</th>{canDelete && <th />}</tr></thead>
                  <tbody>
                    {shown.slice(0, 300).map((i) => (
                      <tr key={i.id}>
                        <td>{dateTime(i.observed_at)}</td>
                        <td>{i.building}, {i.home} <span className="muted">({i.unit_type})</span></td>
                        <td>{typeLabel(opts, i.smell_type)}</td>
                        <td>{opts.strengths.find((s) => s.id === i.strength)?.label}</td>
                        <td>{whereLabel(opts, i.where_noticed)}</td>
                        <td>{i.notes}</td>
                        {canDelete && (
                          <td>
                            <button
                              className="btn small bad"
                              onClick={async () => {
                                if (!window.confirm('Delete this report?')) return;
                                try {
                                  await api.delete(`/admin/odour/${i.id}`);
                                  q.reload();
                                } catch (e) {
                                  setError(e);
                                }
                              }}
                            >
                              Delete
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {shown.length > 300 && <p className="muted">Showing the latest 300 of {shown.length}. Download the CSV for the rest.</p>}
          </section>
        </>
      )}
    </div>
  );
}
