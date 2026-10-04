import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORY_LABELS, api, dateOnly, pct, qs } from '../api';
import { Banner, ErrorNote, Spinner, useAsync } from '../ui';

interface Component {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  detail: string;
}
interface Group {
  key: string;
  total: number;
  open: number;
  resolved_ok: number;
  disputed_closures: number;
  overdue: number;
  median_resolution_days: number | null;
}
export interface Summary {
  generated_at: string;
  community: string;
  demo_data_present: boolean;
  confidence: 'low' | 'fair' | 'good';
  counts: { total: number; open: number; awaiting_verification: number; resolved_ok: number; resolved_poor: number; reopened_now: number };
  acknowledgement: { sla_hours: number; with_case_number: number; case_number_rate: number | null; median_hours: number | null; within_sla_rate: number | null; overdue_unacknowledged: number };
  resolution: { verified_fixed: number; median_days: number | null; within_sla_rate: number | null };
  closure_quality: { management_closed_total: number; disputed: number; disputed_rate: number | null; awaiting_verification: number; awaiting_verification_over_7d: number; verified_fix_rate: number | null };
  backlog: { open: number; overdue: number; overdue_rate: number | null; median_age_days: number | null; oldest_days: number | null; ageing: { bucket: string; count: number }[] };
  repeat: { linked_reports: number; clusters: number; affects_total: number; avg_residents_per_report: number | null };
  by_category: Group[];
  by_tower: Group[];
  trend: { week: string; reported: number; resolved_ok: number; disputed: number }[];
  disputed_closures: { id: string; ref: string; title: string; tower: string | null; management_closures: number; reopen_count: number }[];
  score: { value: number | null; components: Component[] };
  definitions: { key: string; title: string; text: string }[];
}

function ScoreRing({ value }: { value: number | null }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  const tone = value == null ? 'na' : value >= 75 ? 'ok' : value >= 50 ? 'mid' : 'bad';
  return (
    <svg viewBox="0 0 140 140" className={`ring ring-${tone}`} role="img" aria-label={value == null ? 'No score yet' : `Overall score ${value} out of 100`}>
      <circle cx="70" cy="70" r={r} className="ring-bg" />
      <circle cx="70" cy="70" r={r} className="ring-fg" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 70 70)" />
      <text x="70" y="74" textAnchor="middle" className="ring-num">
        {value ?? '-'}
      </text>
      <text x="70" y="96" textAnchor="middle" className="ring-sub">
        out of 100
      </text>
    </svg>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' | 'mid' }) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <span className="tile-label">{label}</span>
      <b>{value}</b>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

function Bars({ data, color }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bars" role="list">
      {data.map((d) => (
        <div className="bar-row" role="listitem" key={d.label}>
          <span className="bar-label">{d.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: color }} />
          </span>
          <span className="bar-val">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function Trend({ data }: { data: Summary['trend'] }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.reported, d.resolved_ok]));
  const w = 320;
  const h = 120;
  const x = (i: number) => 12 + (i * (w - 24)) / (data.length - 1);
  const y = (v: number) => h - 14 - (v / max) * (h - 28);
  const line = (key: 'reported' | 'resolved_ok') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="trend" role="img" aria-label="Weekly reports raised versus verified fixed over the last 12 weeks">
        <line x1="12" x2={w - 12} y1={h - 14} y2={h - 14} className="axis" />
        <path d={line('reported')} className="line reported" />
        <path d={line('resolved_ok')} className="line fixed" />
        {data.map((d, i) => (
          <circle key={d.week} cx={x(i)} cy={y(d.reported)} r="2.5" className="dot-reported" />
        ))}
      </svg>
      <figcaption className="legend">
        <span><i className="sw reported" /> Reported</span>
        <span><i className="sw fixed" /> Verified fixed</span>
        <span className="muted small">last 12 weeks</span>
      </figcaption>
    </figure>
  );
}

const toneRate = (v: number | null, good = 0.8, mid = 0.5): 'ok' | 'mid' | 'bad' | undefined => (v == null ? undefined : v >= good ? 'ok' : v >= mid ? 'mid' : 'bad');

export function Scorecard() {
  const [days, setDays] = useState<number | ''>(90);
  const q = useAsync(() => api.get<Summary>(`/kpi/summary${qs({ days: days || undefined })}`), [days]);
  const s = q.data;

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>Management scorecard</h1>
        <p className="muted">
          How quickly issues are acknowledged, and whether "closed" really means fixed. Based on resident reports and photo evidence.
        </p>
        <div className="chips noprint">
          {[
            [30, '30 days'],
            [90, '90 days'],
            ['', 'All time'],
          ].map(([v, l]) => (
            <button key={String(l)} className={`chip ${days === v ? 'on' : ''}`} onClick={() => setDays(v as number | '')}>
              {l}
            </button>
          ))}
          <button className="chip" onClick={() => window.print()}>
            Print / save as PDF
          </button>
        </div>
      </header>

      <ErrorNote error={q.error} />
      {q.loading && !s ? (
        <Spinner />
      ) : s ? (
        <>
          {s.demo_data_present && <Banner tone="warn" title="Demo data included">These figures include sample reports. A super admin can remove them in Admin &gt; Data.</Banner>}
          {s.confidence === 'low' && <Banner tone="info">Fewer than 10 reports in this period, so treat the score as indicative only.</Banner>}

          <section className="score-hero">
            <ScoreRing value={s.score.value} />
            <div className="score-parts">
              {s.score.components.map((c) => (
                <div key={c.key} className="score-part">
                  <div className="score-part-head">
                    <span>{c.label}</span>
                    <b>{c.value == null ? 'n/a' : pct(c.value)}</b>
                  </div>
                  <span className="bar-track">
                    <span className={`bar-fill ${toneRate(c.value) ?? ''}`} style={{ width: `${(c.value ?? 0) * 100}%` }} />
                  </span>
                  <span className="muted small">
                    {c.detail} · weight {c.weight}%
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="tiles">
            <Tile label="Reports" value={String(s.counts.total)} sub={`${s.counts.open} open`} />
            <Tile label="Got a case number in time" value={pct(s.acknowledgement.within_sla_rate)} sub={`target ${s.acknowledgement.sla_hours}h · median ${s.acknowledgement.median_hours ?? '-'}h`} tone={toneRate(s.acknowledgement.within_sla_rate)} />
            <Tile label="Closed, but not fixed" value={pct(s.closure_quality.disputed_rate)} sub={`${s.closure_quality.disputed} of ${s.closure_quality.management_closed_total} management closures disputed`} tone={s.closure_quality.disputed_rate == null ? undefined : s.closure_quality.disputed_rate > 0.3 ? 'bad' : s.closure_quality.disputed_rate > 0.1 ? 'mid' : 'ok'} />
            <Tile label="Awaiting verification" value={String(s.closure_quality.awaiting_verification)} sub={`${s.closure_quality.awaiting_verification_over_7d} for over 7 days`} />
            <Tile label="Median time to fix" value={s.resolution.median_days != null ? `${s.resolution.median_days} d` : '-'} sub={`${s.resolution.verified_fixed} verified fixed`} />
            <Tile label="Overdue open reports" value={String(s.backlog.overdue)} sub={`oldest ${s.backlog.oldest_days != null ? Math.round(s.backlog.oldest_days) : '-'} days`} tone={s.backlog.overdue_rate == null ? undefined : s.backlog.overdue_rate > 0.5 ? 'bad' : s.backlog.overdue_rate > 0.2 ? 'mid' : 'ok'} />
          </section>

          <div className="grid-2">
            <section className="panel">
              <h2>Open reports by age</h2>
              <Bars data={s.backlog.ageing.map((a) => ({ label: a.bucket, value: a.count }))} />
            </section>
            <section className="panel">
              <h2>Raised vs verified fixed</h2>
              <Trend data={s.trend} />
            </section>
          </div>

          {s.disputed_closures.length > 0 && (
            <section className="panel">
              <h2>Closed by management, not fixed (resident evidence)</h2>
              <ul className="plain">
                {s.disputed_closures.map((d) => (
                  <li key={d.id}>
                    <Link to={`/incident/${d.id}`}>
                      {d.ref} {d.title}
                    </Link>{' '}
                    <span className="muted small">
                      {d.tower} · closed {d.management_closures}x · reopened {d.reopen_count}x
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid-2">
            <section className="panel">
              <h2>By type</h2>
              <table className="table">
                <thead>
                  <tr><th>Type</th><th>Reports</th><th>Open</th><th>Overdue</th><th>Disputed</th></tr>
                </thead>
                <tbody>
                  {s.by_category.map((g) => (
                    <tr key={g.key}>
                      <td>{CATEGORY_LABELS[g.key] ?? g.key}</td><td>{g.total}</td><td>{g.open}</td><td>{g.overdue}</td><td>{g.disputed_closures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panel">
              <h2>By tower</h2>
              <table className="table">
                <thead>
                  <tr><th>Tower</th><th>Reports</th><th>Open</th><th>Overdue</th><th>Median fix</th></tr>
                </thead>
                <tbody>
                  {s.by_tower.map((g) => (
                    <tr key={g.key}>
                      <td>{g.key}</td><td>{g.total}</td><td>{g.open}</td><td>{g.overdue}</td><td>{g.median_resolution_days != null ? `${g.median_resolution_days} d` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="panel">
            <h2>Neighbours affected</h2>
            <p>
              {s.repeat.affects_total} additional residents confirmed they were affected, averaging <b>{s.repeat.avg_residents_per_report ?? '-'}</b> residents per issue. {s.repeat.clusters} groups of repeat reports were linked by moderators.
            </p>
          </section>

          <details className="panel">
            <summary>How this is measured</summary>
            <dl className="defs">
              {s.definitions.map((d) => (
                <div key={d.key}>
                  <dt>{d.title}</dt>
                  <dd>{d.text}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="muted small">
            {s.community} · generated {dateOnly(s.generated_at)}. Figures reflect reports made through this service only. Closure status is confirmed by resident photo evidence, not by management records.
          </p>
        </>
      ) : null}
    </div>
  );
}
