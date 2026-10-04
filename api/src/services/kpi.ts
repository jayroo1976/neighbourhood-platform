import type { Db } from '../db';
import { OPEN_STATUSES, type CommunitySettings, type Severity } from '../domain';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number | null, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const rate = (num: number, den: number) => (den > 0 ? num / den : null);

interface Row {
  id: string;
  ref: string;
  title: string;
  category: string;
  severity: Severity;
  status: string;
  tower: string | null;
  cluster_id: string | null;
  reported_at: string;
  emailed_at: string | null;
  case_number_at: string | null;
  mgmt_first_reply_at: string | null;
  mgmt_closed_at: string | null;
  mgmt_closed_count: number;
  resolved_at: string | null;
  resolution: string | null;
  reopen_count: number;
  last_activity_at: string;
}

const baseTime = (r: Row) => ms(r.emailed_at ?? r.reported_at);
const ackTime = (r: Row) => {
  const t = [ms(r.case_number_at), ms(r.mgmt_first_reply_at)].filter((x) => !Number.isNaN(x));
  return t.length ? Math.min(...t) : NaN;
};
const isOpenish = (r: Row) => (OPEN_STATUSES as string[]).includes(r.status) || r.status === 'mgmt_closed';
const isDisputed = (r: Row) => r.mgmt_closed_count > 0 && (r.resolution === 'poor' || r.reopen_count > 0);

/** Monday (Dubai time) of the week containing the timestamp, as YYYY-MM-DD. */
export function weekKey(iso: string): string {
  const d = new Date(Date.parse(iso) + 4 * HOUR);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

export interface IncidentKpis {
  age_days: number;
  hours_to_acknowledgement: number | null;
  acknowledgement_sla: 'met' | 'breached' | 'pending';
  resolve_due_at: string;
  resolution_sla: 'met' | 'breached' | 'pending' | 'poor_fix';
  days_since_update: number;
  closure_to_verification_hours: number | null;
  reopen_count: number;
  management_closures: number;
  disputed_closure: boolean;
}

export function incidentKpis(r: Row, s: CommunitySettings, now = Date.now()): IncidentKpis {
  const reported = ms(r.reported_at);
  const ack = ackTime(r);
  const base = baseTime(r);
  const ackHours = Number.isNaN(ack) ? null : Math.max(0, (ack - base) / HOUR);
  const dueMs = reported + s.sla_resolve_days[r.severity] * DAY;
  const endMs = r.resolved_at ? ms(r.resolved_at) : now;
  let resolution_sla: IncidentKpis['resolution_sla'];
  if (r.resolution === 'poor') resolution_sla = 'poor_fix';
  else if (r.resolution === 'ok') resolution_sla = endMs <= dueMs ? 'met' : 'breached';
  else resolution_sla = now > dueMs ? 'breached' : 'pending';
  const verified = r.resolved_at && r.mgmt_closed_at ? (ms(r.resolved_at) - ms(r.mgmt_closed_at)) / HOUR : null;
  return {
    age_days: round((now - reported) / DAY) ?? 0,
    hours_to_acknowledgement: round(ackHours),
    acknowledgement_sla: ackHours != null ? (ackHours <= s.sla_case_hours ? 'met' : 'breached') : now - base > s.sla_case_hours * HOUR ? 'breached' : 'pending',
    resolve_due_at: new Date(dueMs).toISOString(),
    resolution_sla,
    days_since_update: round((now - ms(r.last_activity_at)) / DAY) ?? 0,
    closure_to_verification_hours: verified != null && verified >= 0 ? round(verified) : null,
    reopen_count: r.reopen_count,
    management_closures: r.mgmt_closed_count,
    disputed_closure: isDisputed(r),
  };
}

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  value: number | null; // 0..1, null = not enough data
  detail: string;
}

export async function communityKpis(
  db: Db,
  communityId: string,
  settings: CommunitySettings,
  range: { from?: string; to?: string } = {},
  now = Date.now(),
) {
  const q = db('incidents').where({ community_id: communityId }).andWhereNot({ status: 'withdrawn' });
  if (range.from) q.andWhere('reported_at', '>=', range.from);
  if (range.to) q.andWhere('reported_at', '<=', range.to);
  const rows: Row[] = await q.select();
  const ids = new Set(rows.map((r) => r.id));
  const affectsRows = (await db('affects').select('incident_id')).filter((a: { incident_id: string }) => ids.has(a.incident_id));
  const demo = Number((await db('incidents').where({ community_id: communityId, source: 'demo' }).count({ c: '*' }).first())?.c ?? 0);

  const open = rows.filter(isOpenish);
  const resolvedOk = rows.filter((r) => r.resolution === 'ok');
  const resolvedPoor = rows.filter((r) => r.resolution === 'poor');

  // --- acknowledgement (case number / any reply) ---
  const ackHours: number[] = [];
  let ackWithin = 0;
  let ackOverdue = 0;
  for (const r of rows) {
    const t = ackTime(r);
    if (!Number.isNaN(t)) {
      const h = Math.max(0, (t - baseTime(r)) / HOUR);
      ackHours.push(h);
      if (h <= settings.sla_case_hours) ackWithin++;
    } else if (now - baseTime(r) > settings.sla_case_hours * HOUR) {
      ackOverdue++;
    }
  }
  const ackDenominator = ackHours.length + ackOverdue;

  // --- resolution timeliness ---
  const resDays = resolvedOk.map((r) => (ms(r.resolved_at) - ms(r.reported_at)) / DAY);
  let resHit = 0;
  let resDue = 0;
  for (const r of rows) {
    const due = ms(r.reported_at) + settings.sla_resolve_days[r.severity] * DAY;
    if (r.resolution === 'ok') {
      resDue++;
      if (ms(r.resolved_at) <= due) resHit++;
    } else if (r.resolution === 'poor' || now > due) {
      resDue++;
    }
  }

  // --- closure quality: what management calls "closed" vs what residents confirm ---
  const closed = rows.filter((r) => r.mgmt_closed_count > 0);
  const disputed = closed.filter(isDisputed);
  const verifiedGood = closed.filter((r) => r.resolution === 'ok' && r.reopen_count === 0);
  const unverified = closed.filter((r) => r.status === 'mgmt_closed');
  const unverifiedOld = unverified.filter((r) => now - ms(r.mgmt_closed_at) > 7 * DAY);
  const stillBroken = rows.filter((r) => r.status === 'reopened' && r.mgmt_closed_count > 0);
  const fixDen = resolvedOk.length + resolvedPoor.length + stillBroken.length;

  // --- backlog ageing ---
  const buckets = [
    { bucket: '0-2 days', max: 2, count: 0 },
    { bucket: '3-7 days', max: 7, count: 0 },
    { bucket: '8-14 days', max: 14, count: 0 },
    { bucket: '15-30 days', max: 30, count: 0 },
    { bucket: '30+ days', max: Infinity, count: 0 },
  ];
  const ages: number[] = [];
  let overdueOpen = 0;
  for (const r of open) {
    const age = (now - ms(r.reported_at)) / DAY;
    ages.push(age);
    buckets.find((b) => age <= b.max)!.count++;
    if (age > settings.sla_resolve_days[r.severity]) overdueOpen++;
  }

  // --- breakdowns ---
  const group = (key: (r: Row) => string) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()]
      .map(([k, rs]) => ({
        key: k,
        total: rs.length,
        open: rs.filter(isOpenish).length,
        resolved_ok: rs.filter((r) => r.resolution === 'ok').length,
        disputed_closures: rs.filter(isDisputed).length,
        overdue: rs.filter((r) => isOpenish(r) && now - ms(r.reported_at) > settings.sla_resolve_days[r.severity] * DAY).length,
        median_resolution_days: round(median(rs.filter((r) => r.resolution === 'ok').map((r) => (ms(r.resolved_at) - ms(r.reported_at)) / DAY))),
      }))
      .sort((a, b) => b.total - a.total);
  };

  // --- weekly trend (last 12 Dubai weeks) ---
  const weeks: string[] = [];
  for (let i = 11; i >= 0; i--) weeks.push(weekKey(new Date(now - i * 7 * DAY).toISOString()));
  const trend = weeks.map((w) => ({
    week: w,
    reported: rows.filter((r) => weekKey(r.reported_at) === w).length,
    resolved_ok: rows.filter((r) => r.resolved_at && r.resolution === 'ok' && weekKey(r.resolved_at) === w).length,
    disputed: rows.filter((r) => isDisputed(r) && r.resolved_at && weekKey(r.resolved_at) === w).length,
  }));

  // --- transparent score ---
  const ackRate = rate(ackWithin, ackDenominator);
  const resRate = rate(resHit, resDue);
  const fixRate = rate(resolvedOk.length, fixDen);
  const backlogRate = open.length ? 1 - overdueOpen / open.length : null;
  const components: ScoreComponent[] = [
    { key: 'acknowledgement', label: 'Gives a case number in time', weight: 25, value: ackRate, detail: `${ackWithin} of ${ackDenominator} reports got a case number or reply within ${settings.sla_case_hours}h` },
    { key: 'timeliness', label: 'Resolves within target time', weight: 25, value: resRate, detail: `${resHit} of ${resDue} due reports were verified fixed on time` },
    { key: 'fix_quality', label: 'Fixes hold up (resident-verified)', weight: 30, value: fixRate, detail: `${resolvedOk.length} verified fixed vs ${resolvedPoor.length} poorly fixed and ${stillBroken.length} reopened after being called closed` },
    { key: 'backlog', label: 'Keeps the backlog under control', weight: 20, value: backlogRate, detail: `${overdueOpen} of ${open.length} open reports are past their target` },
  ];
  const usable = components.filter((c) => c.value != null);
  const totalWeight = usable.reduce((a, c) => a + c.weight, 0);
  const score = totalWeight ? Math.round((usable.reduce((a, c) => a + c.weight * (c.value as number), 0) / totalWeight) * 100) : null;

  const disputedList = disputed
    .sort((a, b) => ms(b.last_activity_at) - ms(a.last_activity_at))
    .slice(0, 10)
    .map((r) => ({ id: r.id, ref: r.ref, title: r.title, tower: r.tower, status: r.status, management_closures: r.mgmt_closed_count, reopen_count: r.reopen_count }));

  return {
    generated_at: new Date(now).toISOString(),
    period: { from: range.from ?? null, to: range.to ?? null },
    demo_data_present: demo > 0,
    confidence: rows.length >= 30 ? 'good' : rows.length >= 10 ? 'fair' : 'low',
    counts: {
      total: rows.length,
      open: open.length,
      awaiting_verification: unverified.length,
      resolved_ok: resolvedOk.length,
      resolved_poor: resolvedPoor.length,
      reopened_now: rows.filter((r) => r.status === 'reopened').length,
    },
    acknowledgement: {
      sla_hours: settings.sla_case_hours,
      with_case_number: rows.filter((r) => r.case_number_at).length,
      case_number_rate: round(rate(rows.filter((r) => r.case_number_at).length, rows.length), 3),
      median_hours: round(median(ackHours)),
      mean_hours: round(mean(ackHours)),
      within_sla_rate: round(ackRate, 3),
      overdue_unacknowledged: ackOverdue,
    },
    resolution: {
      verified_fixed: resolvedOk.length,
      median_days: round(median(resDays)),
      mean_days: round(mean(resDays)),
      within_sla_rate: round(resRate, 3),
      sla_days: settings.sla_resolve_days,
    },
    closure_quality: {
      management_closed_total: closed.length,
      disputed: disputed.length,
      disputed_rate: round(rate(disputed.length, disputed.length + verifiedGood.length), 3),
      awaiting_verification: unverified.length,
      awaiting_verification_over_7d: unverifiedOld.length,
      verified_fix_rate: round(fixRate, 3),
    },
    backlog: {
      open: open.length,
      overdue: overdueOpen,
      overdue_rate: round(rate(overdueOpen, open.length), 3),
      median_age_days: round(median(ages)),
      oldest_days: round(ages.length ? Math.max(...ages) : null),
      ageing: buckets.map(({ bucket, count }) => ({ bucket, count })),
    },
    repeat: {
      linked_reports: rows.filter((r) => r.cluster_id).length,
      clusters: new Set(rows.filter((r) => r.cluster_id).map((r) => r.cluster_id)).size,
      affects_total: affectsRows.length,
      avg_residents_per_report: round(rows.length ? (rows.length + affectsRows.length) / rows.length : null, 2),
    },
    by_category: group((r) => r.category),
    by_tower: group((r) => r.tower ?? 'Unknown'),
    trend,
    disputed_closures: disputedList,
    score: { value: score, components },
  };
}

export const KPI_DEFINITIONS = [
  { key: 'acknowledgement', title: 'Case number in time', text: 'Hours from our email to management until a case number or any reply is recorded. Reports with no response past the target count as misses.' },
  { key: 'timeliness', title: 'Resolved within target', text: 'Share of due reports (verified fixed, poorly fixed, or open past target) that were verified fixed within the target for their priority.' },
  { key: 'closure', title: 'Closed but not fixed', text: 'Reports management marked closed that a resident then marked poorly fixed or reopened with photo evidence. Reports awaiting resident verification are shown separately, never counted as disputed.' },
  { key: 'fix_quality', title: 'Fixes that hold up', text: 'Verified fixed divided by verified fixed + poorly fixed + reopened-after-closure.' },
  { key: 'backlog', title: 'Backlog ageing', text: 'Age of open reports from the original report time. Overdue means older than the target for that priority.' },
  { key: 'score', title: 'Overall score', text: 'Weighted blend of the four components above (25/25/30/20). Components without data are left out and the rest re-weighted. Treat scores from fewer than 10 reports as indicative only.' },
];
