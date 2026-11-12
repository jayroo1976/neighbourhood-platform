import { config } from '../config';
import type { Db } from '../db';
import { fetchStatisticRows, layoutSensorIds, type WsCtor } from './air';
import { addSystemEvent } from './system';

/**
 * Keeps an hourly copy of every Home Assistant sensor the Fresh air monitoring page charts, in the app's own database
 * (table `sensor_readings`). Home Assistant stays the place the readings are first recorded; this copy means the charts
 * survive Home Assistant being offline, replaced or losing its history, and is backed up with the rest of the app.
 *
 * It reads Home Assistant's long-term statistics (hourly means, kept for years). The first run, and any sensor with no stored
 * rows yet, copies everything Home Assistant holds; later runs re-read from three hours before the newest stored hour, which
 * also heals any gap left by the collector being down.
 */

const HOUR = 3_600_000;
const ALL_FROM = Date.UTC(2020, 0, 1);
const OVERLAP = 3 * HOUR;

export const haConfigured = (): boolean => !!(config.homeAssistant.url && config.homeAssistant.token && layoutSensorIds(config.homeAssistant.airSensors).length);

export interface SyncResult {
  sensors: number;
  rows: number;
  fromIso: string;
}

export async function syncSensorHistory(db: Db, opts: { ids?: string[]; wsCtor?: WsCtor } = {}): Promise<SyncResult> {
  const ids = opts.ids ?? layoutSensorIds(config.homeAssistant.airSensors);
  if (!ids.length || !config.homeAssistant.url || !config.homeAssistant.token) throw new Error('Home Assistant is not set up for the collector (HA_URL, HA_TOKEN and HA_AIR_SENSORS)');
  const last = new Map<string, number>();
  const found = (await db('sensor_readings').whereIn('sensor_id', ids).groupBy('sensor_id').select('sensor_id').max({ last: 'hour_utc' })) as { sensor_id: string; last: string }[];
  for (const r of found) last.set(r.sensor_id, Date.parse(r.last));
  const everything = ids.some((i) => !last.has(i));
  const start = everything ? ALL_FROM : Math.min(...ids.map((i) => last.get(i)!)) - OVERLAP;
  const rows = await fetchStatisticRows(ids, start, 'hour', everything ? 90_000 : 30_000, opts.wsCtor);
  const fetchedAt = new Date().toISOString();
  const out: { sensor_id: string; hour_utc: string; value: number; fetched_at: string }[] = [];
  for (const [id, rs] of rows) for (const r of rs) if (Number.isFinite(r.t) && Number.isFinite(r.v)) out.push({ sensor_id: id, hour_utc: new Date(r.t).toISOString(), value: Math.round(r.v * 100) / 100, fetched_at: fetchedAt });
  for (let i = 0; i < out.length; i += 200) await db('sensor_readings').insert(out.slice(i, i + 200)).onConflict(['sensor_id', 'hour_utc']).merge();
  return { sensors: rows.size, rows: out.length, fromIso: new Date(start).toISOString() };
}

async function lastState(db: Db): Promise<string | null> {
  const e = await db('system_events').where({ kind: 'collector' }).andWhere('title', 'like', 'Sensor history:%').orderBy('at', 'desc').first('title');
  return e ? (e.title as string) : null;
}

/** One sync that never throws; writes to Admin > System only when the state changes (working, or Home Assistant unreachable). */
export async function runSensorSync(db: Db, opts: { wsCtor?: WsCtor; ids?: string[] } = {}): Promise<{ ok: boolean; message: string }> {
  let ok = true;
  let message: string;
  try {
    const r = await syncSensorHistory(db, opts);
    message = `Copied ${r.rows} hourly figures for ${r.sensors} sensors from ${r.fromIso}`;
  } catch (e) {
    ok = false;
    message = e instanceof Error ? e.message : String(e);
  }
  try {
    const previous = await lastState(db);
    const title = ok ? 'Sensor history: working' : 'Sensor history: Home Assistant unreachable';
    if (previous !== title && !(previous === null && ok)) await addSystemEvent(db, { kind: 'collector', title, message });
  } catch {
    /* the log is best effort */
  }
  return { ok, message };
}

export async function latestStored(db: Db): Promise<string | null> {
  const r = await db('sensor_readings').max({ last: 'hour_utc' }).first();
  return (r?.last as string | null) ?? null;
}
