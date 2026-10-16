import { config } from '../config';
import { EXTRA_KEYS, SCALES, SUFFIX, UNRATED, levelFor, type ExtraKey, type Level, type MetricKey, type Scale } from './airScales';

/**
 * Air tab: fresh-air temperature and humidity in each tower, plus the outside temperature, read from the
 * community's Home Assistant. Read-only, server-side only (the token never reaches the browser), cached,
 * and shows only the figures and when they were last updated. Entity ids and the Home Assistant address are never sent to residents.
 */

export interface AirReading {
  value: number | null;
  unit: string | null;
  updated_at: string | null;
  /** true when the sensor is unavailable or has not reported for HA_STALE_MINUTES (hourly imported figures: at least 3 hours) */
  stale: boolean;
  /** 'hourly' = the latest hourly average of imported long-term statistics (id written `source:name`), otherwise a live sensor */
  kind?: 'live' | 'hourly';
  /** good / fair / poor against the reference bands in `scales`; absent for outside figures and unrated sensors */
  level?: Level | null;
}
export interface AirTower {
  name: string;
  temperature: AirReading;
  humidity: AirReading;
  /** extra sensors this tower has (carbon dioxide, fine dust, ...); a sensor that does not exist in Home Assistant is left out */
  metrics?: Partial<Record<ExtraKey, AirReading>>;
}
export interface AirSummary {
  enabled: boolean;
  /** true when Home Assistant could not be reached on the last try */
  unreachable?: boolean;
  fetched_at?: string;
  outside?: { temperature: AirReading; humidity: AirReading };
  towers?: AirTower[];
  /** reference bands for the gauges, with where each comes from */
  scales?: Partial<Record<MetricKey, Scale | { label: string; unit: string; basis: string }>>;
}

interface Layout {
  outside?: { temperature?: string; humidity?: string };
  towers: { name: string; temperature?: string; humidity?: string; metrics: Partial<Record<ExtraKey, string>> }[];
}

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/** Imported long-term statistics (not a live sensor) are written `source:name`, for example tower1:fresh_air_temperature. */
const STAT = /^[a-z0-9_]+:[a-z0-9_]+$/;
const isStat = (id: string | undefined): id is string => !!id && STAT.test(id);

/** A tower's `prefix` is the start of its entity ids, for example "sensor.outside_tower_2_fresh_air_"; it expands to every sensor the uHoo integration creates. */
const PREFIX = /^[a-z0-9_]+\.[a-z0-9_]*_$/;

/** Parses HA_AIR_SENSORS. Returns null when empty or invalid so the tab simply stays off. */
export function parseLayout(raw: string): Layout | null {
  if (!raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as { outside?: { temperature?: string; humidity?: string }; towers?: Record<string, unknown>[] };
    const ok = (id: unknown) => id === undefined || (typeof id === 'string' && (ENTITY.test(id) || STAT.test(id)));
    if (!j || !Array.isArray(j.towers) || !ok(j.outside?.temperature) || !ok(j.outside?.humidity)) return null;
    const towers: Layout['towers'] = [];
    for (const t of j.towers) {
      if (typeof t?.name !== 'string' || !t.name || !ok(t.temperature) || !ok(t.humidity)) return null;
      if (t.prefix !== undefined && (typeof t.prefix !== 'string' || !PREFIX.test(t.prefix))) return null;
      const given = (t.metrics ?? {}) as Record<string, unknown>;
      if (typeof given !== 'object' || Array.isArray(given)) return null;
      for (const [k, v] of Object.entries(given)) if (!(EXTRA_KEYS as readonly string[]).includes(k) || typeof v !== 'string' || !ok(v)) return null;
      const prefix = t.prefix as string | undefined;
      const metrics: Partial<Record<ExtraKey, string>> = {};
      for (const k of EXTRA_KEYS) {
        const id = (given[k] as string | undefined) ?? (prefix ? prefix + SUFFIX[k] : undefined);
        if (id) metrics[k] = id;
      }
      towers.push({
        name: t.name.slice(0, 40),
        temperature: (t.temperature as string | undefined) ?? (prefix ? prefix + SUFFIX.temperature : undefined),
        humidity: (t.humidity as string | undefined) ?? (prefix ? prefix + SUFFIX.humidity : undefined),
        metrics,
      });
    }
    return { outside: j.outside, towers };
  } catch {
    return null;
  }
}

export function airEnabled(): boolean {
  const h = config.homeAssistant;
  return !!(h.url && h.token && parseLayout(h.airSensors));
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const EMPTY: AirReading = { value: null, unit: null, updated_at: null, stale: true };

async function readEntity(id: string | undefined, fetcher: FetchLike, now: number): Promise<AirReading> {
  if (!id || isStat(id)) return EMPTY;
  const { url, token, staleMinutes } = config.homeAssistant;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetcher(`${url}/api/states/${id}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctl.signal });
    if (res.status === 404) return EMPTY; // entity id not found in Home Assistant
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    const s = (await res.json()) as { state?: string; last_updated?: string; attributes?: { unit_of_measurement?: string } };
    let value = Number.parseFloat(String(s.state));
    let unit = s.attributes?.unit_of_measurement ?? null;
    if (!Number.isFinite(value)) return { ...EMPTY, updated_at: s.last_updated ?? null };
    if (unit === '°F') {
      value = ((value - 32) * 5) / 9;
      unit = '°C';
    }
    const updated = s.last_updated ? Date.parse(s.last_updated) : NaN;
    const stale = !Number.isFinite(updated) || now - updated > staleMinutes * 60_000;
    return { value: Math.round(value * 10) / 10, unit, updated_at: s.last_updated ?? null, stale };
  } finally {
    clearTimeout(timer);
  }
}


// ---------------------------------------------------------------- imported statistics (WebSocket)

interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsCtor = new (url: string) => WsLike;

const toMs = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);

/**
 * Home Assistant only offers long-term statistics over its WebSocket API. Signs in with the token, asks for the unit and
 * the last 72 hours of hourly figures, and keeps the latest hour that has a value. Read-only; closes the connection afterwards.
 */
export async function readStatistics(ids: string[], now: number, Ctor: WsCtor = globalThis.WebSocket as unknown as WsCtor): Promise<Map<string, AirReading>> {
  const { url, token, staleMinutes } = config.homeAssistant;
  const out = new Map<string, AirReading>();
  if (!ids.length) return out;
  return new Promise((resolve, reject) => {
    const ws = new Ctor(`${url.replace(/^http/, 'ws')}/api/websocket`);
    const units = new Map<string, string | null>();
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('Home Assistant statistics timed out'))), 8000);
    ws.onerror = () => done(() => reject(new Error('Home Assistant statistics connection failed')));
    ws.onclose = () => done(() => reject(new Error('Home Assistant statistics connection closed')));
    ws.onmessage = (ev) => {
      let m: { type?: string; id?: number; success?: boolean; result?: unknown };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_invalid') done(() => reject(new Error('Home Assistant rejected the token')));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'recorder/get_statistics_metadata', statistic_ids: ids }));
      else if (m.type === 'result' && m.id === 1) {
        if (m.success && Array.isArray(m.result)) for (const r of m.result as { statistic_id?: string; unit_of_measurement?: string | null }[]) if (r.statistic_id) units.set(r.statistic_id, r.unit_of_measurement ?? null);
        ws.send(JSON.stringify({ id: 2, type: 'recorder/statistics_during_period', start_time: new Date(now - 72 * 3_600_000).toISOString(), statistic_ids: ids, period: 'hour', types: ['mean', 'state'] }));
      } else if (m.type === 'result' && m.id === 2) {
        if (!m.success) return done(() => reject(new Error('Home Assistant could not return statistics')));
        const res = (m.result ?? {}) as Record<string, { start?: unknown; end?: unknown; mean?: number | null; state?: number | null }[]>;
        for (const id of ids) {
          const rows = res[id] ?? [];
          let last: { start?: unknown; end?: unknown; value: number } | null = null;
          for (const r of rows) {
            const v = typeof r.mean === 'number' ? r.mean : typeof r.state === 'number' ? r.state : null;
            if (v != null && Number.isFinite(v)) last = { start: r.start, end: r.end, value: v };
          }
          if (!last) {
            out.set(id, { ...EMPTY, kind: 'hourly' });
            continue;
          }
          let value = last.value;
          let unit = units.get(id) ?? null;
          if (unit === '°F') {
            value = ((value - 32) * 5) / 9;
            unit = '°C';
          }
          const start = toMs(last.start);
          const end = toMs(last.end);
          const age = now - (Number.isFinite(end) ? end : start);
          out.set(id, {
            value: Math.round(value * 10) / 10,
            unit,
            updated_at: Number.isFinite(start) ? new Date(start).toISOString() : null,
            stale: !Number.isFinite(age) || age > Math.max(staleMinutes, 180) * 60_000,
            kind: 'hourly',
          });
        }
        done(() => resolve(out));
      }
    };
  });
}

let cache: { at: number; data: AirSummary } | null = null;
export function clearAirCache() {
  cache = null;
}

export async function getAir(fetcher: FetchLike = fetch as unknown as FetchLike, wsCtor?: WsCtor): Promise<AirSummary> {
  const layout = airEnabled() ? parseLayout(config.homeAssistant.airSensors) : null;
  if (!layout) return { enabled: false };
  const now = Date.now();
  if (cache && now - cache.at < config.homeAssistant.cacheSeconds * 1000) return cache.data;
  // one flat list of sensor ids: outside (2), then per tower temperature, humidity and any extras
  const slots: { id: string | undefined; tower?: number; key?: MetricKey }[] = [
    { id: layout.outside?.temperature },
    { id: layout.outside?.humidity },
    ...layout.towers.flatMap((t, i) => [
      { id: t.temperature, tower: i, key: 'temperature' as MetricKey },
      { id: t.humidity, tower: i, key: 'humidity' as MetricKey },
      ...EXTRA_KEYS.filter((k) => t.metrics[k]).map((k) => ({ id: t.metrics[k], tower: i, key: k as MetricKey })),
    ]),
  ];
  const ids = slots.map((x) => x.id);
  try {
    // live sensors over REST, imported hourly statistics over the WebSocket API
    let statsFailed = false;
    const statIds = [...new Set(ids.filter(isStat))];
    const stats = await readStatistics(statIds, now, wsCtor).catch(() => {
      statsFailed = true;
      return new Map<string, AirReading>();
    });
    const live = await Promise.all(ids.map((id) => readEntity(id, fetcher, now)));
    const at = (i: number): AirReading => {
      const id = ids[i];
      if (isStat(id)) return stats.get(id) ?? { ...EMPTY, kind: 'hourly' };
      return live[i];
    };
    const towers: AirTower[] = layout.towers.map((t) => ({ name: t.name, temperature: { ...EMPTY }, humidity: { ...EMPTY } }));
    slots.forEach((slot, i) => {
      if (slot.tower === undefined || !slot.key) return;
      const r = at(i);
      const rated: AirReading = { ...r, level: levelFor(slot.key, r.value) };
      const tw = towers[slot.tower];
      if (slot.key === 'temperature' || slot.key === 'humidity') tw[slot.key] = rated;
      else if (r.value != null || r.updated_at) (tw.metrics ??= {})[slot.key as ExtraKey] = rated; // a sensor that does not exist is not shown
    });
    const scales: NonNullable<AirSummary['scales']> = {};
    for (const [k, v] of Object.entries(SCALES)) scales[k as MetricKey] = v;
    for (const [k, v] of Object.entries(UNRATED)) scales[k as MetricKey] = v;
    const data: AirSummary = {
      enabled: true,
      fetched_at: new Date(now).toISOString(),
      ...(statsFailed ? { unreachable: true } : {}),
      outside: { temperature: at(0), humidity: at(1) },
      towers,
      scales,
    };
    if (!statsFailed) cache = { at: now, data };
    return data;
  } catch {
    // Home Assistant unreachable: show the last good figures marked as old, or say it is unreachable
    if (cache) return { ...cache.data, unreachable: true };
    return { enabled: true, unreachable: true, outside: { temperature: EMPTY, humidity: EMPTY }, towers: layout.towers.map((t) => ({ name: t.name, temperature: EMPTY, humidity: EMPTY })) };
  }
}
