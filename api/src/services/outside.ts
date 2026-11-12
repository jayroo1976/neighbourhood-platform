import fs from 'node:fs';
import type { Db } from '../db';
import { addSystemEvent } from './system';

/**
 * Outdoor station collector. Fetches the public station page, reads the figures the station itself published together with
 * the time the page says they are for, and keeps one row per hour in `outside_readings`. The Fresh air monitoring page reads
 * that table (ids `app:outside_temperature` and `app:outside_humidity` in HA_AIR_SENSORS), so it no longer depends on a scheduled
 * task or on Home Assistant to have the outside figures.
 *
 * Rules: a figure is stored only if the page gives its own time (never the time we fetched, because a page that has stopped
 * updating would then look fresh); nothing is estimated or carried forward; a value outside a plausible range is dropped.
 */

const HOUR = 3_600_000;
const DUBAI = 4 * HOUR; // Dubai is UTC+4 all year (no daylight saving)

export interface OutsideReading {
  hourUtc: string;
  tempC: number | null;
  humidityPct: number | null;
  usAqi: number | null;
  pm25: number | null;
  windKmh: number | null;
  pageTime: string | null;
}
export type ParseResult = { ok: true; readings: OutsideReading[]; via: 'json' | 'text' } | { ok: false; reason: string };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: number | null, lo: number, hi: number): number | null => (v != null && v >= lo && v <= hi ? v : null);
const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
const hourOf = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString();

interface Fields {
  tempC: number | null;
  humidityPct: number | null;
  usAqi: number | null;
  pm25: number | null;
  windKmh: number | null;
}
const clean = (f: Fields): Fields => ({
  tempC: round1(within(f.tempC, -10, 60)),
  humidityPct: round1(within(f.humidityPct, 0, 100)),
  usAqi: f.usAqi != null ? within(Math.round(f.usAqi), 0, 999) : null,
  pm25: round1(within(f.pm25, 0, 1000)),
  windKmh: round1(within(f.windKmh, 0, 250)),
});
const hasAny = (f: Fields) => Object.values(f).some((v) => v != null);

// ------------------------------------------------------------------ strategy 1: JSON embedded in the page

const num = (o: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) if (finite(o[k])) return o[k] as number;
  return null;
};
/** An ISO time with an explicit zone ("Z" or an offset). A time with no zone is ignored rather than guessed. */
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const TS_KEYS = ['ts', 'timestamp', 'time', 'datetime', 'dateTime', 'observedAt', 'updatedAt', 'lastUpdated'];

interface Candidate {
  tsMs: number;
  f: Fields;
}

function walk(node: unknown, inherited: number | null, out: Candidate[], depth = 0): void {
  if (depth > 40 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node.slice(0, 5000)) walk(x, inherited, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  let ts = inherited;
  for (const k of TS_KEYS) {
    const t = isoMs(o[k]);
    if (t != null) {
      ts = t;
      break;
    }
  }
  const pmObj = o.pm25 && typeof o.pm25 === 'object' ? (o.pm25 as Record<string, unknown>) : null;
  const f: Fields = {
    tempC: num(o, ['tp', 'temperature', 'temp', 'temp_c']),
    humidityPct: num(o, ['hu', 'humidity', 'humidity_pct']),
    usAqi: num(o, ['aqius', 'usAqi', 'aqi_us', 'us_aqi']),
    pm25: (pmObj ? num(pmObj, ['conc', 'value']) : null) ?? num(o, ['pm25', 'pm2_5', 'pm2_5_ugm3']),
    windKmh: finite(o.ws) ? (o.ws as number) * 3.6 : num(o, ['wind_kmh']), // ws is metres per second in the IQAir data format
  };
  if (ts != null && hasAny(f)) out.push({ tsMs: ts, f });
  for (const v of Object.values(o)) walk(v, ts, out, depth + 1);
}

function jsonBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    if (body.length < 2 || body.length > 4_000_000 || !/^[[{]/.test(body)) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      /* not JSON */
    }
  }
  return blocks;
}

export function candidatesFromJson(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const b of jsonBlocks(html)) walk(b, null, out);
  return out;
}

function fromJson(html: string, now: number): OutsideReading[] {
  // Forecast entries carry the same fields but a future time, so only entries up to now (10 minutes of slack) count; the newest of those is the current report.
  const usable = candidatesFromJson(html).filter((c) => c.tsMs <= now + 10 * 60_000);
  const newest = (has: (f: Fields) => boolean) => usable.filter((c) => has(c.f)).sort((a, b) => b.tsMs - a.tsMs)[0];
  const weather = newest((f) => f.tempC != null || f.humidityPct != null);
  const pollution = newest((f) => f.usAqi != null || f.pm25 != null);
  const byHour = new Map<string, Fields>();
  const add = (c: Candidate | undefined, pick: (f: Fields) => Partial<Fields>) => {
    if (!c) return;
    const h = hourOf(c.tsMs);
    byHour.set(h, { ...(byHour.get(h) ?? { tempC: null, humidityPct: null, usAqi: null, pm25: null, windKmh: null }), ...pick(clean(c.f)) });
  };
  add(weather, (f) => ({ tempC: f.tempC, humidityPct: f.humidityPct, windKmh: f.windKmh }));
  add(pollution, (f) => ({ usAqi: f.usAqi, pm25: f.pm25 }));
  return [...byHour.entries()].filter(([, f]) => hasAny(f)).map(([hourUtc, f]) => ({ hourUtc, ...f, pageTime: null }));
}

// ------------------------------------------------------------------ strategy 2: the visible text

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function pageText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&deg;|&#176;/g, '°')
    .replace(/&micro;|&mu;|&#181;|&#956;/g, 'µ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** "Last updated: 23:00, Oct 19" is local (Dubai) time with no year; the year is the current one, or the last one if that would be in the future. */
function pageTimeToUtc(text: string, now: number): { hourUtc: string; label: string } | null {
  const m = /Last updated[:\s]*(\d{1,2}):(\d{2})\s*,?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})/i.exec(text);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[3].slice(0, 3).toLowerCase());
  const hh = Number(m[1]);
  const day = Number(m[4]);
  if (mon < 0 || hh > 23 || day < 1 || day > 31) return null;
  const yearNow = new Date(now + DUBAI).getUTCFullYear();
  let t = Date.UTC(yearNow, mon, day, hh, Number(m[2])) - DUBAI;
  if (t > now + 24 * HOUR) t = Date.UTC(yearNow - 1, mon, day, hh, Number(m[2])) - DUBAI;
  return { hourUtc: hourOf(t), label: m[0].trim() };
}

function fromText(html: string, now: number): OutsideReading[] {
  const text = pageText(html);
  const when = pageTimeToUtc(text, now);
  if (!when) return [];
  const g = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const f = clean({
    tempC: g(/Temperature\D{0,20}?(-?\d{1,2}(?:\.\d)?)\s*°/i),
    humidityPct: g(/Humidity\D{0,20}?(\d{1,3}(?:\.\d)?)\s*%/i),
    usAqi: g(/(\d{1,3})\s*US AQI/i) ?? g(/US AQI\D{0,12}?(\d{1,3})\b/i),
    pm25: g(/PM2\.5\D{0,40}?(\d{1,3}(?:\.\d)?)\s*(?:µg|μg|ug)\s*\/\s*m/i),
    windKmh: g(/Wind(?: speed)?\D{0,20}?(\d{1,3}(?:\.\d)?)\s*km\s*\/\s*h/i),
  });
  return hasAny(f) ? [{ hourUtc: when.hourUtc, ...f, pageTime: when.label }] : [];
}

export function parseStationPage(html: string, now = Date.now()): ParseResult {
  const j = fromJson(html, now);
  if (j.length) return { ok: true, readings: j, via: 'json' };
  const t = fromText(html, now);
  if (t.length) return { ok: true, readings: t, via: 'text' };
  return { ok: false, reason: 'No readings with a time of their own were found on the page (its layout may have changed)' };
}

/** A short description of what the page contained, for the Admin > System log and --debug (no page text beyond a few short snippets). */
export function diagnose(html: string, now = Date.now()): string {
  const text = pageText(html);
  const cands = candidatesFromJson(html);
  const near = (re: RegExp) => {
    const m = re.exec(text);
    return m ? `"${text.slice(Math.max(0, m.index - 20), m.index + 70)}"` : 'not found';
  };
  const recent = cands
    .filter((c) => c.tsMs <= now + 600_000)
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 3)
    .map((c) => `${new Date(c.tsMs).toISOString()} ${JSON.stringify(c.f)}`);
  return [
    `page ${html.length} bytes, ${(html.match(/<script\b/gi) ?? []).length} script blocks, ${jsonBlocks(html).length} JSON blocks, ${cands.length} timed figures in JSON`,
    `newest JSON figures: ${recent.length ? recent.join(' | ') : 'none'}`,
    `text "Last updated": ${near(/Last updated/i)}`,
    `text "Temperature": ${near(/Temperature/i)}`,
    `text "Humidity": ${near(/Humidity/i)}`,
  ].join('\n');
}

// ------------------------------------------------------------------ fetching

export type PageFetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function fetchStationPage(url: string, userAgent: string, fetcher: PageFetcher = fetch as unknown as PageFetcher, timeoutMs = 20_000): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new Error('OUTSIDE_SOURCE_URL must start with https://');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`The station page answered ${res.status}`);
    const body = await res.text();
    if (body.length > 8_000_000) throw new Error('The station page was larger than expected');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ storage

/** Adds the hour if new, otherwise fills in only the figures the new report has (a missing figure never wipes one already stored). */
export async function saveReadings(db: Db, readings: OutsideReading[], fetchedAt: string, source = 'iqair-page'): Promise<void> {
  for (const r of readings) {
    const fields = { temp_c: r.tempC, humidity_pct: r.humidityPct, us_aqi: r.usAqi, pm25: r.pm25, wind_kmh: r.windKmh };
    const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
    await db('outside_readings')
      .insert({ hour_utc: r.hourUtc, ...fields, page_time: r.pageTime, source, fetched_at: fetchedAt })
      .onConflict('hour_utc')
      .merge({ ...present, fetched_at: fetchedAt });
  }
}

// ------------------------------------------------------------------ readings posted by the scheduled skill

export interface IngestRow {
  page_time_dubai: string;
  temp_c?: number | null;
  humidity_pct?: number | null;
  us_aqi?: number | null;
  pm25?: number | null;
  wind_kmh?: number | null;
}

/**
 * Stores hourly station readings posted by the scheduled skill. The time is the station page's own Dubai time ("YYYY-MM-DD HH:MM");
 * a row with an unreadable time, a time more than 10 minutes in the future or no plausible figure is skipped. A figure outside its
 * plausible range is dropped, a missing figure never wipes a stored one, and posting the same hour again is harmless.
 */
export async function ingestReadings(db: Db, rows: IngestRow[], now = Date.now()): Promise<{ saved: number; skipped: number }> {
  const readings: OutsideReading[] = [];
  let skipped = 0;
  for (const r of rows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(r.page_time_dubai ?? '');
    const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - DUBAI : NaN;
    const f = clean({ tempC: r.temp_c ?? null, humidityPct: r.humidity_pct ?? null, usAqi: r.us_aqi ?? null, pm25: r.pm25 ?? null, windKmh: r.wind_kmh ?? null });
    if (!Number.isFinite(t) || t > now + 10 * 60_000 || !hasAny(f)) {
      skipped++;
      continue;
    }
    readings.push({ hourUtc: hourOf(t), pageTime: r.page_time_dubai.trim(), ...f });
  }
  await saveReadings(db, readings, new Date(now).toISOString(), 'skill');
  return { saved: readings.length, skipped };
}

// ------------------------------------------------------------------ seed from the station readings file

/** Imports hours from the station readings CSV (columns page_time_dubai, us_aqi, pm2_5_ugm3, temp_c, humidity_pct, wind_kmh). Existing hours are left alone. Returns how many hours were added. */
export async function importCsv(db: Db, file: string): Promise<number> {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return 0;
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const iTime = col('page_time_dubai');
  if (iTime < 0) throw new Error('The CSV needs a page_time_dubai column');
  const cell = (cells: string[], n: string): number | null => {
    const i = col(n);
    const v = i >= 0 ? Number(cells[i]) : NaN;
    return cells[i] !== undefined && cells[i].trim() !== '' && Number.isFinite(v) ? v : null;
  };
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(c[iTime] ?? '');
    if (!m) continue;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - DUBAI;
    const f = clean({ tempC: cell(c, 'temp_c'), humidityPct: cell(c, 'humidity_pct'), usAqi: cell(c, 'us_aqi'), pm25: cell(c, 'pm2_5_ugm3'), windKmh: cell(c, 'wind_kmh') });
    if (!hasAny(f)) continue;
    rows.push({ hour_utc: hourOf(t), temp_c: f.tempC, humidity_pct: f.humidityPct, us_aqi: f.usAqi, pm25: f.pm25, wind_kmh: f.windKmh, page_time: c[iTime].trim(), source: 'seed', fetched_at: new Date().toISOString() });
  }
  const count = async () => Number((await db('outside_readings').count({ n: '*' }).first())?.n ?? 0);
  const before = await count();
  for (let i = 0; i < rows.length; i += 100) await db('outside_readings').insert(rows.slice(i, i + 100)).onConflict('hour_utc').ignore();
  return (await count()) - before;
}

// ------------------------------------------------------------------ reading back (used by the Fresh air monitoring page)

export type OutsideField = 'temp_c' | 'humidity_pct';

export async function latestOutside(db: Db, field: OutsideField): Promise<{ hourUtc: string; value: number } | null> {
  const r = await db('outside_readings').whereNotNull(field).orderBy('hour_utc', 'desc').first('hour_utc', field);
  return r ? { hourUtc: r.hour_utc as string, value: Number(r[field]) } : null;
}

/** Hourly rows from `fromMs`, or daily averages (Dubai days, matching Home Assistant's daily statistics) when `period` is 'day'. */
export async function outsideRows(db: Db, field: OutsideField, fromMs: number, period: 'hour' | 'day'): Promise<{ t: number; v: number }[]> {
  const rows = (await db('outside_readings').whereNotNull(field).andWhere('hour_utc', '>=', new Date(fromMs).toISOString()).orderBy('hour_utc').select('hour_utc', field)) as Record<string, unknown>[];
  const hourly = rows.map((r) => ({ t: Date.parse(r.hour_utc as string), v: Number(r[field]) })).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v));
  if (period === 'hour') return hourly;
  const days = new Map<number, number[]>();
  for (const r of hourly) {
    const start = Math.floor((r.t + DUBAI) / (24 * HOUR)) * 24 * HOUR - DUBAI;
    (days.get(start) ?? days.set(start, []).get(start)!).push(r.v);
  }
  return [...days.entries()].map(([t, v]) => ({ t, v: v.reduce((a, b) => a + b, 0) / v.length }));
}

/** Stored hourly figures from `fromMs` for several sensors, or daily means by Dubai day (matching Home Assistant's daily statistics). */
export async function storedRows(db: Db, ids: string[], fromMs: number, period: 'hour' | 'day'): Promise<Map<string, { t: number; v: number }[]>> {
  const out = new Map<string, { t: number; v: number }[]>();
  if (!ids.length) return out;
  const rows = (await db('sensor_readings').whereIn('sensor_id', ids).andWhere('hour_utc', '>=', new Date(fromMs).toISOString()).orderBy('hour_utc').select('sensor_id', 'hour_utc', 'value')) as { sensor_id: string; hour_utc: string; value: number }[];
  const per = new Map<string, { t: number; v: number }[]>();
  for (const r of rows) {
    const t = Date.parse(r.hour_utc);
    if (!Number.isFinite(t)) continue;
    (per.get(r.sensor_id) ?? per.set(r.sensor_id, []).get(r.sensor_id)!).push({ t, v: Number(r.value) });
  }
  for (const [id, hourly] of per) {
    if (period === 'hour') {
      out.set(id, hourly);
      continue;
    }
    const days = new Map<number, number[]>();
    for (const r of hourly) {
      const day = Math.floor((r.t + DUBAI) / (24 * HOUR)) * 24 * HOUR - DUBAI;
      (days.get(day) ?? days.set(day, []).get(day)!).push(r.v);
    }
    out.set(id, [...days.entries()].map(([t, v]) => ({ t, v: v.reduce((a, b) => a + b, 0) / v.length })));
  }
  return out;
}

// ------------------------------------------------------------------ one collector cycle

export interface CycleResult {
  ok: boolean;
  state: 'ok' | 'stale' | 'failing';
  message: string;
  via?: 'json' | 'text';
  newest?: string;
}

/** A page that still answers but whose newest report is older than this is reported as "not updating" (the station itself has stopped syncing). */
export const STATION_STALE_HOURS = 3;

async function lastCollectorState(db: Db): Promise<string | null> {
  const e = await db('system_events').where({ kind: 'collector' }).andWhere('title', 'like', 'Outside station:%').orderBy('at', 'desc').first('title');
  return e ? (e.title as string) : null;
}

/**
 * Fetches, parses and stores once. Writes an entry to Admin > System only when the state changes (working, failing, station not updating),
 * so a long outage is one line, not hundreds. Never throws.
 */
export async function runCycle(db: Db, opts: { url: string; userAgent: string; fetcher?: PageFetcher; now?: number }): Promise<CycleResult> {
  const now = opts.now ?? Date.now();
  let result: CycleResult;
  let detail = '';
  try {
    const html = await fetchStationPage(opts.url, opts.userAgent, opts.fetcher);
    const parsed = parseStationPage(html, now);
    if (!parsed.ok) {
      detail = diagnose(html, now);
      result = { ok: false, state: 'failing', message: parsed.reason };
    } else {
      await saveReadings(db, parsed.readings, new Date(now).toISOString());
      const newest = parsed.readings.map((r) => r.hourUtc).sort().pop()!;
      const ageH = (now - Date.parse(newest)) / HOUR;
      result =
        ageH > STATION_STALE_HOURS
          ? { ok: true, state: 'stale', via: parsed.via, newest, message: `The page is reachable but its newest report is for ${newest} (${Math.floor(ageH)} hours ago): the station is not updating` }
          : { ok: true, state: 'ok', via: parsed.via, newest, message: `Stored the report for ${newest} (read from the page ${parsed.via})` };
    }
  } catch (e) {
    result = { ok: false, state: 'failing', message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const previous = await lastCollectorState(db);
    const title = result.state === 'ok' ? 'Outside station: working' : result.state === 'stale' ? 'Outside station: page not updating' : 'Outside station: fetch failing';
    if (previous !== title && !(previous === null && result.state === 'ok')) {
      await addSystemEvent(db, { kind: 'collector', title, message: [result.message, detail].filter(Boolean).join('\n\n') });
    }
  } catch {
    /* the log is best effort */
  }
  return result;
}
