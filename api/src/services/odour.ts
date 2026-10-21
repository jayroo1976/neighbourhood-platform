import crypto from 'node:crypto';
import type { Db } from '../db';
import {
  DUBAI_UTC_OFFSET_HOURS,
  FLATS_PER_LEVEL,
  FLAT_TYPES,
  LEVEL_BANDS,
  MAX_TOWNHOUSE_UNIT,
  ODOUR_FREQUENCIES,
  ODOUR_FREQUENCY_LABELS,
  ODOUR_MIN_GROUP,
  ODOUR_STRENGTH_LABELS,
  ODOUR_TYPES,
  ODOUR_TYPE_LABELS,
  ODOUR_WHERE,
  ODOUR_WHERE_LABELS,
  PENTHOUSE_LEVEL,
  PENTHOUSE_UNITS,
  TOWER_LEVELS,
  mergeSettings,
  type OdourFrequency,
  type OdourType,
  type OdourWhere,
} from '../domain';
import { HttpError, type Actor } from './incidents';

/**
 * Smell reports ("odour map"). A resident logs a smell against their own home (tower, level, flat) so that
 * admins can look for patterns, for example the same flat position on several levels, which points at a shared riser.
 *
 * Privacy: the exact level and flat are shown to the resident who wrote the report and to admins only.
 * Neighbours get building-level counts and level bands (see residentSummary), never a flat.
 */

export interface OdourInput {
  building: string;
  level: number;
  flat: number;
  smell_type: OdourType;
  strength: number;
  frequency: OdourFrequency;
  where_noticed: OdourWhere;
  observed_at?: string;
  notes?: string;
}

export interface OdourRow {
  id: string;
  community_id: string;
  user_id: string;
  building: string;
  kind: 'tower' | 'townhouse';
  level: number;
  flat: number;
  smell_type: OdourType;
  strength: number;
  frequency: OdourFrequency;
  where_noticed: OdourWhere;
  observed_at: string;
  notes: string;
  source: string;
  created_at: string;
  deleted_at: string | null;
}

const TOWNHOUSE = /^Townhouse (\d{1,2})$/;
export const townhouseName = (n: number) => `Townhouse ${n}`;
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();

async function context(db: Db, communityId: string) {
  const c = await db('communities').where({ id: communityId }).first();
  if (!c) throw new HttpError(404, 'Community not found.');
  let towers: string[] = [];
  try {
    towers = JSON.parse(c.towers);
  } catch {
    towers = [];
  }
  const settings = mergeSettings(c.settings);
  return { settings, towers, townhouses: settings.odour_townhouse_blocks.map(townhouseName) };
}

function requireEnabled(enabled: boolean) {
  if (!enabled) throw new HttpError(404, 'Smell reports are switched off.', 'disabled');
}

/** Short name of the unit type: A-D for tower flats, F1/F2/G1/G2/H for penthouses, TH for townhouses. */
export function unitType(r: Pick<OdourRow, 'kind' | 'level' | 'flat'>): string {
  if (r.kind === 'townhouse') return 'TH';
  if (r.level === PENTHOUSE_LEVEL) return PENTHOUSE_UNITS[r.flat - 1] ?? '?';
  return FLAT_TYPES[r.flat] ?? '?';
}

export function homeLabel(r: Pick<OdourRow, 'kind' | 'level' | 'flat'>): string {
  if (r.kind === 'townhouse') return `No. ${r.flat}`;
  if (r.level === PENTHOUSE_LEVEL) return `Penthouse ${PENTHOUSE_UNITS[r.flat - 1] ?? r.flat}`;
  return `Level ${r.level}, flat ${r.flat}`;
}

/** Full detail. Only ever returned to the resident who wrote the report, or to admins. */
export function odourItem(r: OdourRow) {
  return {
    id: r.id,
    building: r.building,
    kind: r.kind,
    level: r.level,
    flat: r.flat,
    home: homeLabel(r),
    unit_type: unitType(r),
    smell_type: r.smell_type,
    strength: r.strength,
    frequency: r.frequency,
    where_noticed: r.where_noticed,
    observed_at: r.observed_at,
    notes: r.notes,
    created_at: r.created_at,
  };
}

export async function odourOptions(db: Db, communityId: string) {
  const { settings, towers, townhouses } = await context(db, communityId);
  return {
    enabled: settings.odour_enabled,
    towers,
    townhouses,
    townhouse_max_unit: Math.min(settings.odour_townhouse_units, MAX_TOWNHOUSE_UNIT),
    levels: TOWER_LEVELS,
    penthouse_level: PENTHOUSE_LEVEL,
    flats_per_level: FLATS_PER_LEVEL,
    flat_types: FLAT_TYPES,
    penthouse_units: PENTHOUSE_UNITS,
    level_bands: LEVEL_BANDS,
    types: ODOUR_TYPES.map((id) => ({ id, label: ODOUR_TYPE_LABELS[id] })),
    where: ODOUR_WHERE.map((id) => ({ id, label: ODOUR_WHERE_LABELS[id] })),
    frequencies: ODOUR_FREQUENCIES.map((id) => ({ id, label: ODOUR_FREQUENCY_LABELS[id] })),
    strengths: [1, 2, 3, 4].map((id) => ({ id, label: ODOUR_STRENGTH_LABELS[id] })),
    max_per_day: settings.odour_max_per_day,
  };
}

export async function createOdourReport(db: Db, actor: Pick<Actor, 'id' | 'community_id'>, input: OdourInput, opts: { source?: 'app' | 'demo'; skipCap?: boolean } = {}): Promise<OdourRow> {
  const { settings, towers, townhouses } = await context(db, actor.community_id);
  requireEnabled(settings.odour_enabled);

  let kind: 'tower' | 'townhouse';
  let level: number;
  const th = TOWNHOUSE.exec(input.building);
  if (th) {
    if (!townhouses.includes(input.building)) throw new HttpError(400, 'Please choose one of the listed buildings.', 'validation');
    const maxUnit = Math.min(settings.odour_townhouse_units, MAX_TOWNHOUSE_UNIT);
    if (input.flat < 1 || input.flat > maxUnit) throw new HttpError(400, `Townhouse number must be between 1 and ${maxUnit}.`, 'validation');
    kind = 'townhouse';
    level = 0;
  } else {
    if (!towers.includes(input.building)) throw new HttpError(400, 'Please choose one of the listed buildings.', 'validation');
    kind = 'tower';
    level = input.level;
    if (level === PENTHOUSE_LEVEL) {
      if (input.flat < 1 || input.flat > PENTHOUSE_UNITS.length) throw new HttpError(400, 'Choose your penthouse.', 'validation');
    } else {
      if (level < 1 || level > TOWER_LEVELS) throw new HttpError(400, `Level must be between 1 and ${TOWER_LEVELS}, or the penthouse.`, 'validation');
      if (input.flat < 1 || input.flat > FLATS_PER_LEVEL) throw new HttpError(400, `Flat must be between 1 and ${FLATS_PER_LEVEL}.`, 'validation');
    }
  }

  const now = Date.now();
  let observed = new Date(now);
  if (input.observed_at) {
    observed = new Date(input.observed_at);
    if (Number.isNaN(observed.getTime())) throw new HttpError(400, 'Choose when you noticed the smell.', 'validation');
    if (observed.getTime() > now + 5 * 60_000) throw new HttpError(400, 'That time is in the future. Choose when you noticed it.', 'validation');
    if (observed.getTime() < now - 365 * 86_400_000) throw new HttpError(400, 'That time is more than a year ago.', 'validation');
  }

  if (!opts.skipCap) {
    // Counts deleted reports too, so removing one does not reset the daily limit.
    const today = await db('odour_reports').where({ user_id: actor.id }).andWhere('created_at', '>', dayAgo()).count({ c: '*' }).first();
    if (Number(today?.c ?? 0) >= settings.odour_max_per_day) {
      throw new HttpError(429, `Daily limit reached (${settings.odour_max_per_day} smell reports). Please try again tomorrow.`, 'rate_limited');
    }
  }

  const row: OdourRow = {
    id: crypto.randomUUID(),
    community_id: actor.community_id,
    user_id: actor.id,
    building: input.building,
    kind,
    level,
    flat: input.flat,
    smell_type: input.smell_type,
    strength: input.strength,
    frequency: input.frequency,
    where_noticed: input.where_noticed,
    observed_at: observed.toISOString(),
    notes: (input.notes ?? '').trim().slice(0, 280),
    source: opts.source ?? 'app',
    created_at: new Date(now).toISOString(),
    deleted_at: null,
  };
  await db('odour_reports').insert(row);
  return row;
}

/** The resident's own reports, newest first. They see their own flat because it is their own report. */
export async function myOdourReports(db: Db, actor: Pick<Actor, 'id' | 'community_id'>) {
  const { settings } = await context(db, actor.community_id);
  requireEnabled(settings.odour_enabled);
  const rows = (await db('odour_reports').where({ user_id: actor.id, community_id: actor.community_id }).whereNull('deleted_at').orderBy('observed_at', 'desc').limit(50)) as OdourRow[];
  return rows.map(odourItem);
}

/** Soft delete. A resident can remove their own report; an admin can remove any report in the community. */
export async function deleteOdourReport(db: Db, id: string, who: { communityId: string; userId?: string }): Promise<boolean> {
  const q = db('odour_reports').where({ id, community_id: who.communityId }).whereNull('deleted_at');
  if (who.userId) q.andWhere({ user_id: who.userId });
  // The row is kept so the daily limit still counts it, but the free-text note is erased.
  const n = await q.update({ deleted_at: new Date().toISOString(), notes: '' });
  return n > 0;
}

export interface AdminOdourFilter {
  days?: number;
  type?: string;
  where?: string;
}

/** Everything, with the exact level and flat. Admin only. */
export async function adminOdourList(db: Db, communityId: string, f: AdminOdourFilter = {}) {
  const q = db('odour_reports').where({ community_id: communityId }).whereNull('deleted_at').orderBy('observed_at', 'desc').limit(5000);
  if (f.days) q.andWhere('observed_at', '>=', new Date(Date.now() - f.days * 86_400_000).toISOString());
  if (f.type) q.andWhere({ smell_type: f.type });
  if (f.where) q.andWhere({ where_noticed: f.where });
  return ((await q) as OdourRow[]).map(odourItem);
}

export type OdourListItem = ReturnType<typeof odourItem>;

/** Patterns worth a look in a set of reports (same flat position on several levels; several flats on one level). Same rules as the admin page. */
export function odourPatterns(items: OdourListItem[], towers: string[]): string[] {
  const out: string[] = [];
  for (const t of towers) {
    const rs = items.filter((i) => i.building === t && i.kind === 'tower' && i.level <= TOWER_LEVELS);
    for (let f = 1; f <= FLATS_PER_LEVEL; f++) {
      const lv = new Set(rs.filter((r) => r.flat === f).map((r) => r.level));
      if (lv.size >= 3) out.push(`${t}: flat ${f} has reports on ${lv.size} different levels (${[...lv].sort((a, b) => a - b).join(', ')}).`);
    }
    const byLevel = new Map<number, Set<number>>();
    for (const r of rs) byLevel.set(r.level, (byLevel.get(r.level) ?? new Set()).add(r.flat));
    for (const [l, fl] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) if (fl.size >= 3) out.push(`${t}: ${fl.size} flats on level ${l} have reported (${[...fl].sort((a, b) => a - b).join(', ')}).`);
  }
  return out;
}

const countBy = <T>(rows: T[], key: (r: T) => string): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const r of rows) o[key(r)] = (o[key(r)] ?? 0) + 1;
  return o;
};

/**
 * What every signed-in resident sees: counts per building, by smell type, by group of levels and by hour of day.
 * No flat, no exact level and no notes. A group of levels with fewer than ODOUR_MIN_GROUP reports is shown as "fewer than 3"
 * so a small count cannot point at one home.
 */
export async function residentOdourSummary(db: Db, actor: Pick<Actor, 'id' | 'community_id'>, days?: number) {
  const { settings, towers, townhouses } = await context(db, actor.community_id);
  requireEnabled(settings.odour_enabled);
  const q = db('odour_reports').where({ community_id: actor.community_id }).whereNull('deleted_at').select('building', 'kind', 'level', 'flat', 'smell_type', 'observed_at', 'user_id');
  if (days) q.andWhere('observed_at', '>=', new Date(Date.now() - days * 86_400_000).toISOString());
  const all = (await q) as Pick<OdourRow, 'building' | 'kind' | 'level' | 'flat' | 'smell_type' | 'observed_at' | 'user_id'>[];
  const names = [...towers, ...townhouses];
  const rows = all.filter((r) => names.includes(r.building));

  const buildings = names.map((name) => {
    const rs = rows.filter((r) => r.building === name);
    const isTower = towers.includes(name);
    const few = rs.length > 0 && rs.length < ODOUR_MIN_GROUP;
    return {
      name,
      kind: isTower ? 'tower' : 'townhouse',
      // A building with only one or two reports could point at one home, so its totals are withheld as well.
      few,
      reports: few ? null : rs.length,
      homes: few ? null : new Set(rs.map((r) => `${r.level}-${r.flat}`)).size,
      by_type: few ? {} : countBy(rs, (r) => r.smell_type),
      bands: isTower
        ? LEVEL_BANDS.map((b) => {
            const n = rs.filter((r) => r.level >= b.from && r.level <= b.to).length;
            const few = n > 0 && n < ODOUR_MIN_GROUP;
            return { id: b.id, label: b.label, count: few ? null : n, few };
          })
        : [],
    };
  });

  const by_hour = new Array<number>(24).fill(0);
  for (const r of rows) {
    const t = Date.parse(r.observed_at);
    if (Number.isFinite(t)) by_hour[(new Date(t).getUTCHours() + DUBAI_UTC_OFFSET_HOURS) % 24]++;
  }
  return {
    days: days ?? null,
    min_group: ODOUR_MIN_GROUP,
    total: rows.length,
    mine: rows.filter((r) => r.user_id === actor.id).length,
    by_type: countBy(rows, (r) => r.smell_type),
    by_hour,
    buildings,
  };
}

/** CSV cell that cannot be read as a spreadsheet formula. */
const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function odourCsv(items: ReturnType<typeof odourItem>[]): string {
  const head = ['observed_at', 'building', 'level', 'flat', 'unit_type', 'smell_type', 'strength', 'where_noticed', 'frequency', 'notes', 'reported_at'];
  const lines = [head.join(',')];
  for (const i of items) {
    const level = i.kind === 'townhouse' ? '' : i.level === PENTHOUSE_LEVEL ? 'Penthouse' : i.level;
    lines.push(
      [i.observed_at, i.building, level, i.kind === 'tower' && i.level === PENTHOUSE_LEVEL ? PENTHOUSE_UNITS[i.flat - 1] : i.flat, i.unit_type, ODOUR_TYPE_LABELS[i.smell_type], i.strength, ODOUR_WHERE_LABELS[i.where_noticed], ODOUR_FREQUENCY_LABELS[i.frequency], i.notes, i.created_at]
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\n');
}
