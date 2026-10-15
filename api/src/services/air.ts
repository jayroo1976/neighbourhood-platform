import { config } from '../config';

/**
 * Air tab: fresh-air temperature and humidity in each tower, plus the outside temperature, read from the
 * community's Home Assistant. Read-only, server-side only (the token never reaches the browser), cached,
 * and shows only the figures and when they were last updated. Entity ids and the Home Assistant address are never sent to residents.
 */

export interface AirReading {
  value: number | null;
  unit: string | null;
  updated_at: string | null;
  /** true when the sensor is unavailable or has not reported for HA_STALE_MINUTES */
  stale: boolean;
}
export interface AirSummary {
  enabled: boolean;
  /** true when Home Assistant could not be reached on the last try */
  unreachable?: boolean;
  fetched_at?: string;
  outside?: { temperature: AirReading; humidity: AirReading };
  towers?: { name: string; temperature: AirReading; humidity: AirReading }[];
}

interface Layout {
  outside?: { temperature?: string; humidity?: string };
  towers: { name: string; temperature?: string; humidity?: string }[];
}

const ENTITY = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** Parses HA_AIR_SENSORS. Returns null when empty or invalid so the tab simply stays off. */
export function parseLayout(raw: string): Layout | null {
  if (!raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as Layout;
    const ok = (id: unknown) => id === undefined || (typeof id === 'string' && ENTITY.test(id));
    if (!j || !Array.isArray(j.towers) || !ok(j.outside?.temperature) || !ok(j.outside?.humidity)) return null;
    for (const t of j.towers) if (typeof t?.name !== 'string' || !t.name || !ok(t.temperature) || !ok(t.humidity)) return null;
    return { outside: j.outside, towers: j.towers.map((t) => ({ name: t.name.slice(0, 40), temperature: t.temperature, humidity: t.humidity })) };
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
  if (!id) return EMPTY;
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

let cache: { at: number; data: AirSummary } | null = null;
export function clearAirCache() {
  cache = null;
}

export async function getAir(fetcher: FetchLike = fetch as unknown as FetchLike): Promise<AirSummary> {
  const layout = airEnabled() ? parseLayout(config.homeAssistant.airSensors) : null;
  if (!layout) return { enabled: false };
  const now = Date.now();
  if (cache && now - cache.at < config.homeAssistant.cacheSeconds * 1000) return cache.data;
  try {
    const [outsideTemp, outsideHum, ...rest] = await Promise.all([
      readEntity(layout.outside?.temperature, fetcher, now),
      readEntity(layout.outside?.humidity, fetcher, now),
      ...layout.towers.flatMap((t) => [readEntity(t.temperature, fetcher, now), readEntity(t.humidity, fetcher, now)]),
    ]);
    const data: AirSummary = {
      enabled: true,
      fetched_at: new Date(now).toISOString(),
      outside: { temperature: outsideTemp, humidity: outsideHum },
      towers: layout.towers.map((t, i) => ({ name: t.name, temperature: rest[i * 2], humidity: rest[i * 2 + 1] })),
    };
    cache = { at: now, data };
    return data;
  } catch {
    // Home Assistant unreachable: show the last good figures marked as old, or say it is unreachable
    if (cache) return { ...cache.data, unreachable: true };
    return { enabled: true, unreachable: true, outside: { temperature: EMPTY, humidity: EMPTY }, towers: layout.towers.map((t) => ({ name: t.name, temperature: EMPTY, humidity: EMPTY })) };
  }
}
