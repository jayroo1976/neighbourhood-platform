import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { createDb, migrate, type Db } from '../src/db';
import { clearAirCache, getAir, parseLayout, type WsCtor } from '../src/services/air';
import { moisture } from '../src/services/airDerived';
import { diagnose, importCsv, parseStationPage, runCycle, saveReadings, type PageFetcher } from '../src/services/outside';
import { runSensorSync, syncSensorHistory } from '../src/services/sensorSync';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 12, 40); // 12 Nov 2026, 16:40 Dubai
const iso = (ms: number) => new Date(ms).toISOString();

async function freshDb(): Promise<Db> {
  const db = createDb('sqlite::memory:');
  await migrate(db);
  return db;
}

const jsonPage = (current: object, extra: object = {}) =>
  `<html><head><title>Station</title></head><body><h1>Palm</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { station: { current, ...extra } } } })}</script></body></html>`;

describe('station page: JSON in the page', () => {
  const current = {
    weather: { ts: '2026-11-12T11:00:00.000Z', tp: 28, hu: 56, ws: 9.7 },
    pollution: { ts: '2026-11-12T11:00:00.000Z', aqius: 28, pm25: { conc: 5 } },
  };

  it('reads temperature, humidity, AQI, PM2.5 and wind (metres per second converted to km/h) for the hour of the report', () => {
    const r = parseStationPage(jsonPage(current), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe('json');
    expect(r.readings).toEqual([{ hourUtc: '2026-11-12T11:00:00.000Z', tempC: 28, humidityPct: 56, usAqi: 28, pm25: 5, windKmh: 34.9, pageTime: null }]);
  });

  it('ignores forecast entries (future time) and older history, and takes the newest report up to now', () => {
    const page = jsonPage(current, {
      forecasts: [{ ts: '2026-11-12T15:00:00.000Z', tp: 40, hu: 10 }, { ts: '2026-11-13T11:00:00.000Z', tp: 41, hu: 11 }],
      history: [{ ts: '2026-11-12T08:00:00.000Z', tp: 25, hu: 70 }],
    });
    const r = parseStationPage(page, NOW);
    expect(r.ok && r.readings[0]).toMatchObject({ hourUtc: '2026-11-12T11:00:00.000Z', tempC: 28, humidityPct: 56 });
  });

  it('keeps temperature and pollution as separate hours when the page dates them differently', () => {
    const r = parseStationPage(jsonPage({ weather: { ts: '2026-11-12T11:20:00Z', tp: 28, hu: 56 }, pollution: { ts: '2026-11-12T10:05:00Z', aqius: 30 } }), NOW);
    expect(r.ok && r.readings.map((x) => [x.hourUtc, x.tempC, x.usAqi])).toEqual([
      ['2026-11-12T11:00:00.000Z', 28, null],
      ['2026-11-12T10:00:00.000Z', null, 30],
    ]);
  });

  it('never uses a time without a zone, and never the time of the fetch', () => {
    const r = parseStationPage(jsonPage({ weather: { ts: '2026-11-12T11:00:00', tp: 28, hu: 56 } }), NOW);
    expect(r.ok).toBe(false);
  });

  it('drops implausible values rather than storing them', () => {
    const r = parseStationPage(jsonPage({ weather: { ts: '2026-11-12T11:00:00Z', tp: 280, hu: 56 } }), NOW);
    expect(r.ok && r.readings[0]).toMatchObject({ tempC: null, humidityPct: 56 });
    expect(parseStationPage(jsonPage({ weather: { ts: '2026-11-12T11:00:00Z', tp: 280, hu: 156 } }), NOW).ok).toBe(false);
  });
});

describe('station page: visible text', () => {
  const text = (when: string) =>
    `<html><body><div>Air quality</div><div>Last updated: ${when}</div><div>132 US AQI</div><div>PM2.5 48 µg/m³</div><div>Temperature 31°C</div><div>Humidity 62%</div><div>Wind 12 km/h</div><script>var x = {"tp": 99}</script></body></html>`;

  it('reads the labelled figures and converts the page time (Dubai) to the UTC hour', () => {
    const r = parseStationPage(text('23:00, Oct 19'), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe('text');
    expect(r.readings[0]).toMatchObject({ hourUtc: '2026-10-19T19:00:00.000Z', tempC: 31, humidityPct: 62, usAqi: 132, pm25: 48, windKmh: 12, pageTime: 'Last updated: 23:00, Oct 19' });
  });

  it('uses last year for a date that would be in the future', () => {
    const r = parseStationPage(text('09:00, Dec 30'), NOW);
    expect(r.ok && r.readings[0].hourUtc).toBe('2025-12-30T05:00:00.000Z');
  });

  it('says what it could not read when the page has no time of its own', () => {
    const r = parseStationPage('<html><body>Temperature 31°C Humidity 62%</body></html>', NOW);
    expect(r).toMatchObject({ ok: false });
    expect(diagnose('<html><body>Temperature 31°C Humidity 62%</body></html>', NOW)).toContain('Temperature');
  });
});

describe('storage', () => {
  it('stores one row per hour, and a later report fills in figures without wiping the ones already there', async () => {
    const db = await freshDb();
    const hour = '2026-11-12T11:00:00.000Z';
    await saveReadings(db, [{ hourUtc: hour, tempC: 28, humidityPct: 56, usAqi: null, pm25: null, windKmh: null, pageTime: null }], iso(NOW));
    await saveReadings(db, [{ hourUtc: hour, tempC: 29, humidityPct: null, usAqi: 28, pm25: 5, windKmh: null, pageTime: null }], iso(NOW + H));
    const rows = await db('outside_readings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hour_utc: hour, temp_c: 29, humidity_pct: 56, us_aqi: 28, pm25: 5 });
  });

  it('imports the station readings CSV (Dubai time to UTC) and leaves hours already stored alone', async () => {
    const db = await freshDb();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'np-')), 'r.csv');
    fs.writeFileSync(file, 'page_time_dubai,fetched_at_utc,us_aqi,pm2_5_ugm3,temp_c,humidity_pct,wind_kmh,ha_written\n2026-11-12 15:00,x,28,5,28,56,35,no\n2026-11-12 16:00,x,30,6,29,55,30,no\nbad,row\n');
    await saveReadings(db, [{ hourUtc: '2026-11-12T11:00:00.000Z', tempC: 99, humidityPct: null, usAqi: null, pm25: null, windKmh: null, pageTime: null }], iso(NOW), 'iqair-page');
    expect(await importCsv(db, file)).toBe(1); // 15:00 Dubai = 11:00 UTC already existed
    const rows = await db('outside_readings').orderBy('hour_utc');
    expect(rows.map((r: { hour_utc: string; temp_c: number }) => [r.hour_utc, r.temp_c])).toEqual([
      ['2026-11-12T11:00:00.000Z', 99],
      ['2026-11-12T12:00:00.000Z', 29],
    ]);
    expect(await importCsv(db, file)).toBe(0); // safe to run twice
  });

  it('ships a seed file the importer can read', async () => {
    const db = await freshDb();
    const n = await importCsv(db, path.resolve(__dirname, '../seed-data/outside-readings.csv'));
    expect(n).toBeGreaterThan(300);
    const first = await db('outside_readings').orderBy('hour_utc').first();
    expect(first.hour_utc).toBe('2026-10-25T03:00:00.000Z'); // 07:00 Dubai
  });
});

describe('one collector cycle', () => {
  const page = (ts: string) => jsonPage({ weather: { ts, tp: 28, hu: 56 } });
  const ok = (html: string): PageFetcher => async () => ({ ok: true, status: 200, text: async () => html });
  const failing: PageFetcher = async () => ({ ok: false, status: 503, text: async () => '' });
  const opts = (fetcher: PageFetcher, now = NOW) => ({ url: 'https://example.test/station', userAgent: 'test', fetcher, now });
  const events = async (db: Db) => (await db('system_events').where({ kind: 'collector' }).orderBy('at')).map((e: { title: string }) => e.title);

  it('stores the report and says nothing the first time it works', async () => {
    const db = await freshDb();
    const r = await runCycle(db, opts(ok(page('2026-11-12T11:00:00Z'))));
    expect(r).toMatchObject({ ok: true, state: 'ok', via: 'json' });
    expect((await db('outside_readings')).length).toBe(1);
    expect(await events(db)).toEqual([]);
  });

  it('logs once when it starts failing, stays quiet while it keeps failing, and logs once when it recovers', async () => {
    const db = await freshDb();
    expect((await runCycle(db, opts(failing))).state).toBe('failing');
    await runCycle(db, opts(failing));
    await runCycle(db, opts(failing));
    expect(await events(db)).toEqual(['Outside station: fetch failing']);
    await runCycle(db, opts(ok(page('2026-11-12T11:00:00Z'))));
    expect(await events(db)).toEqual(['Outside station: fetch failing', 'Outside station: working']);
  });

  it('flags a page that answers but has stopped updating, without storing a fake current hour', async () => {
    const db = await freshDb();
    const r = await runCycle(db, opts(ok(page('2026-11-12T05:00:00Z'))));
    expect(r.state).toBe('stale');
    expect((await db('outside_readings').first()).hour_utc).toBe('2026-11-12T05:00:00.000Z');
    expect(await events(db)).toEqual(['Outside station: page not updating']);
  });

  it('puts what it saw on the page into the log when the layout is not recognised', async () => {
    const db = await freshDb();
    const r = await runCycle(db, opts(ok('<html><body>Something else entirely</body></html>')));
    expect(r.state).toBe('failing');
    const e = await db('system_events').where({ kind: 'collector' }).first();
    expect(e.message).toContain('JSON blocks');
  });

  it('refuses a non-https source', async () => {
    const db = await freshDb();
    const r = await runCycle(db, { url: 'http://example.test/x', userAgent: 't', fetcher: ok('x'), now: NOW });
    expect(r.state).toBe('failing');
    expect(r.message).toMatch(/https/);
  });
});

describe('Fresh air monitoring page reading the stored outside figures', () => {
  const ha = config.homeAssistant;
  const original = { ...ha };
  afterEach(() => {
    Object.assign(ha, original);
    clearAirCache();
  });
  const layout = JSON.stringify({
    outside: { temperature: 'app:outside_temperature', humidity: 'app:outside_humidity' },
    towers: [{ name: 'MR 1', temperature: 'sensor.t1', humidity: 'sensor.h1' }],
  });
  const states: Record<string, string> = { 'sensor.t1': '25', 'sensor.h1': '50' };
  const fake = async (url: string) => {
    const v = states[url.split('/api/states/')[1] ?? ''];
    return v ? { ok: true, status: 200, json: async () => ({ state: v, last_updated: new Date().toISOString(), attributes: {} }) } : { ok: false, status: 404, json: async () => ({}) };
  };
  /** Home Assistant's statistics socket with no statistics in it (the towers here are live sensors with no history). */
  class EmptyWs {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      setTimeout(() => this.emit({ type: 'auth_required' }), 0);
    }
    emit(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      if (m.type === 'auth') setTimeout(() => this.emit({ type: 'auth_ok' }), 0);
      if (m.type === 'recorder/get_statistics_metadata') setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result: [] }), 0);
      if (m.type === 'recorder/statistics_during_period') setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result: {} }), 0);
    }
    close() {
      this.onclose = null;
    }
  }
  const ws = EmptyWs as unknown as WsCtor;
  const hourStart = (n: number) => Math.floor(Date.now() / H) * H - n * H;
  const put = (db: Db, rows: [number, number, number][]) =>
    saveReadings(db, rows.map(([h, t, hu]) => ({ hourUtc: iso(hourStart(h)), tempC: t, humidityPct: hu, usAqi: null, pm25: null, windKmh: null, pageTime: null })), iso(Date.now()));

  it('accepts app: ids in the layout', () => {
    expect(parseLayout(layout)).not.toBeNull();
  });

  it('shows the latest stored hour as the outside figure and draws the stored hours as the outside line, with moisture worked out', async () => {
    const db = await freshDb();
    await put(db, [[1, 31, 60], [2, 30, 62], [5, 29, 64]]);
    Object.assign(ha, { url: 'http://ha.local:8123', token: 'tok', airSensors: layout });
    const a = await getAir(fake, undefined, 'day', db);
    expect(a.outside!.temperature).toMatchObject({ value: 31, unit: '°C', stale: false, kind: 'hourly', updated_at: iso(hourStart(1)) });
    expect(a.outside!.humidity).toMatchObject({ value: 60, unit: '%' });
    const h = a.outside!.history!;
    expect(h.hours).toHaveLength(25);
    expect(h.series.temperature![24 - 1]).toBe(31);
    expect(h.series.temperature![24 - 2]).toBe(30);
    expect(h.series.temperature![24 - 5]).toBe(29);
    expect(h.series.moisture![24 - 1]).toBe(moisture(31, 60));
    expect(JSON.stringify(a)).not.toMatch(/app:|outside_readings/);
  });

  it('marks the outside figure old when the newest stored hour is more than three hours behind', async () => {
    const db = await freshDb();
    await put(db, [[6, 29, 64]]);
    Object.assign(ha, { url: 'http://ha.local:8123', token: 'tok', airSensors: layout });
    const a = await getAir(fake, undefined, 'day', db);
    expect(a.outside!.temperature).toMatchObject({ value: 29, stale: true });
  });

  it('covers week, month and all time (daily averages) from the stored hours', async () => {
    const db = await freshDb();
    await put(db, [[1, 31, 60], [2, 30, 62], [30, 28, 70], [26 * 24, 27, 66]]);
    Object.assign(ha, { url: 'http://ha.local:8123', token: 'tok', airSensors: layout });
    const week = await getAir(fake, ws, 'week', db);
    expect(week.outside!.history!.hours).toHaveLength(169);
    expect(week.outside!.history!.series.temperature!.filter((v) => v != null)).toEqual([28, 30, 31]);
    clearAirCache();
    const month = await getAir(fake, ws, 'month', db);
    expect(month.outside!.history!.hours).toHaveLength(721);
    expect(month.outside!.history!.series.temperature!.filter((v) => v != null)).toEqual([27, 28, 30, 31]);
    clearAirCache();
    const all = await getAir(fake, ws, 'all', db);
    const oh = all.outside!.history!;
    expect(oh.series.temperature![0]).toBe(27); // the first stored day
    expect(oh.series.temperature!.filter((v) => v != null).length).toBeGreaterThanOrEqual(3);
  });

  it('shows an empty outside figure, not an error, when nothing has been stored yet', async () => {
    const db = await freshDb();
    Object.assign(ha, { url: 'http://ha.local:8123', token: 'tok', airSensors: layout });
    const a = await getAir(fake, undefined, 'day', db);
    expect(a.enabled).toBe(true);
    expect(a.outside!.temperature).toMatchObject({ value: null, stale: true });
    expect(a.outside!.history).toBeUndefined();
  });
});

/** Home Assistant's statistics socket holding the given hourly figures; records the requests it gets. */
function statsWs(stats: Record<string, { start: number; end: number; mean?: number }[]>, units: Record<string, string> = {}) {
  const requests: { period?: string; start?: string; ids?: string[] }[] = [];
  class Ws {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      setTimeout(() => this.emit({ type: 'auth_required' }), 0);
    }
    emit(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      if (m.type === 'auth') setTimeout(() => this.emit({ type: 'auth_ok' }), 0);
      if (m.type === 'recorder/get_statistics_metadata') setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result: m.statistic_ids.map((id: string) => ({ statistic_id: id, unit_of_measurement: units[id] ?? null })) }), 0);
      if (m.type === 'recorder/statistics_during_period') {
        requests.push({ period: m.period, start: m.start_time, ids: m.statistic_ids });
        const startMs = Date.parse(m.start_time);
        const result: typeof stats = {};
        for (const id of m.statistic_ids) result[id] = (stats[id] ?? []).filter((r) => r.start >= startMs);
        setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result }), 0);
      }
    }
    close() {
      this.onclose = null;
    }
  }
  return { Ctor: Ws as unknown as WsCtor, requests };
}

describe('copy of the Home Assistant sensor history', () => {
  const ha = config.homeAssistant;
  const original = { ...ha };
  afterEach(() => {
    Object.assign(ha, original);
    clearAirCache();
  });
  const layout = JSON.stringify({
    outside: { temperature: 'app:outside_temperature' },
    towers: [{ name: 'MR 1', temperature: 'sensor.t1', humidity: 'sensor.h1' }, { name: 'MR 2', temperature: 'tower2:fresh_air_temperature', humidity: 'sensor.h2' }],
  });
  const setHa = () => Object.assign(ha, { url: 'http://ha.local:8123', token: 'tok', airSensors: layout });
  const hour = (n: number) => Math.floor(Date.now() / H) * H - n * H;
  const row = (n: number, mean: number) => ({ start: hour(n), end: hour(n - 1), mean });

  it('copies every charted sensor (not the app-kept outside ids), converting Fahrenheit, and is safe to repeat', async () => {
    setHa();
    const db = await freshDb();
    const { Ctor, requests } = statsWs({ 'sensor.t1': [row(3, 77), row(2, 78.8)], 'sensor.h1': [row(3, 50)], 'tower2:fresh_air_temperature': [row(3, 24)], 'sensor.h2': [row(2, 55)] }, { 'sensor.t1': '°F' });
    const r = await syncSensorHistory(db, { wsCtor: Ctor });
    expect(r).toMatchObject({ sensors: 4, rows: 5 });
    expect(requests[0].ids!.sort()).toEqual(['sensor.h1', 'sensor.h2', 'sensor.t1', 'tower2:fresh_air_temperature']);
    const t1 = await db('sensor_readings').where({ sensor_id: 'sensor.t1' }).orderBy('hour_utc');
    expect(t1.map((x: { value: number }) => x.value)).toEqual([25, 26]);
    await syncSensorHistory(db, { wsCtor: Ctor });
    expect((await db('sensor_readings')).length).toBe(5);
  });

  it('first copies everything Home Assistant holds, then only re-reads from three hours before the newest stored hour', async () => {
    setHa();
    const db = await freshDb();
    const all = { 'sensor.t1': [row(30, 20), row(5, 21)], 'sensor.h1': [row(5, 50)], 'tower2:fresh_air_temperature': [row(5, 24)], 'sensor.h2': [row(5, 55)] };
    const a = statsWs(all);
    await syncSensorHistory(db, { wsCtor: a.Ctor });
    expect(Date.parse(a.requests[0].start!)).toBeLessThan(hour(24 * 365));
    const b = statsWs(all);
    await syncSensorHistory(db, { wsCtor: b.Ctor });
    expect(Date.parse(b.requests[0].start!)).toBe(hour(5) - 3 * H);
    // a sensor with nothing stored yet (added to the layout later) triggers a full copy again
    await db('sensor_readings').where({ sensor_id: 'sensor.h2' }).del();
    const c = statsWs(all);
    await syncSensorHistory(db, { wsCtor: c.Ctor });
    expect(Date.parse(c.requests[0].start!)).toBeLessThan(hour(24 * 365));
    expect((await db('sensor_readings').where({ sensor_id: 'sensor.h2' })).length).toBe(1);
  });

  it('logs once when Home Assistant cannot be reached and once when it works again, keeping what is already stored', async () => {
    setHa();
    const db = await freshDb();
    const good = statsWs({ 'sensor.t1': [row(2, 25)] });
    await runSensorSync(db, { wsCtor: good.Ctor });
    class Broken {
      onerror: ((ev: unknown) => void) | null = null;
      onmessage = null;
      onclose = null;
      constructor() {
        setTimeout(() => this.onerror?.({}), 0);
      }
      send() {}
      close() {}
    }
    expect((await runSensorSync(db, { wsCtor: Broken as unknown as WsCtor })).ok).toBe(false);
    await runSensorSync(db, { wsCtor: Broken as unknown as WsCtor });
    await runSensorSync(db, { wsCtor: good.Ctor });
    const titles = (await db('system_events').where({ kind: 'collector' }).orderBy('at')).map((e: { title: string }) => e.title);
    expect(titles).toEqual(['Sensor history: Home Assistant unreachable', 'Sensor history: working']);
    expect((await db('sensor_readings').where({ sensor_id: 'sensor.t1' })).length).toBe(1);
  });

  it('still feeds the page from the stored copy when Home Assistant is down: charts, and tiles marked old', async () => {
    setHa();
    const db = await freshDb();
    const put = (id: string, vals: [number, number][]) => db('sensor_readings').insert(vals.map(([n, v]) => ({ sensor_id: id, hour_utc: iso(hour(n)), value: v, fetched_at: iso(Date.now()) })));
    await put('sensor.t1', [[6, 24], [5, 25], [4, 26], [60, 22]]);
    await put('sensor.h1', [[6, 50], [5, 52], [4, 54]]);
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    const neverUsed = class {
      constructor() {
        throw new Error('the WebSocket must not be opened when Home Assistant is down');
      }
    } as unknown as WsCtor;
    const a = await getAir(down, neverUsed, 'day', db);
    expect(a.unreachable).toBe(true);
    const mr1 = a.towers![0];
    expect(mr1.history!.series.temperature!.slice(24 - 6, 24 - 3)).toEqual([24, 25, 26]);
    expect(mr1.temperature).toMatchObject({ value: 26, stale: true, kind: 'hourly', updated_at: iso(hour(4)) });
    expect(mr1.humidity).toMatchObject({ value: 54, stale: true });
    clearAirCache();
    const all = await getAir(down, neverUsed, 'all', db);
    expect(all.towers![0].history!.series.temperature!.filter((v) => v != null)).toEqual([22, 25]); // daily means from the stored copy
  });

  it('with Home Assistant up, its figure wins for an hour it has and the stored copy fills the hours it lacks', async () => {
    setHa();
    const db = await freshDb();
    await db('sensor_readings').insert([
      { sensor_id: 'sensor.t1', hour_utc: iso(hour(3)), value: 20, fetched_at: iso(Date.now()) },
      { sensor_id: 'sensor.t1', hour_utc: iso(hour(2)), value: 21, fetched_at: iso(Date.now()) },
    ]);
    const states: Record<string, string> = { 'sensor.t1': '30', 'sensor.h1': '50', 'sensor.h2': '55' };
    const upFetch = async (url: string) => {
      if (url.includes('/api/history/period/')) {
        const rows = [{ entity_id: 'sensor.t1', state: '22', last_changed: iso(hour(2) + 600_000) }];
        return { ok: true, status: 200, json: async () => [rows] };
      }
      const v = states[url.split('/api/states/')[1] ?? ''];
      return v ? { ok: true, status: 200, json: async () => ({ state: v, last_updated: new Date().toISOString(), attributes: {} }) } : { ok: false, status: 404, json: async () => ({}) };
    };
    const { Ctor } = statsWs({});
    const a = await getAir(upFetch, Ctor, 'day', db);
    expect(a.unreachable).toBeUndefined();
    const t = a.towers![0].history!.series.temperature!;
    expect(t[24 - 3]).toBe(20); // from the stored copy
    expect(t[24 - 2]).toBe(22); // Home Assistant's own figure for that hour
    expect(a.towers![0].temperature).toMatchObject({ value: 30, stale: false });
  });
});

describe('public fresh-air page (no sign-in)', () => {
  it('is off by default, needs no login once switched on, and is marked noindex', async () => {
    const request = (await import('supertest')).default;
    const { setup } = await import('./helpers');
    const ctx = await setup();
    const off = await request(ctx.app).get('/api/public/air');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false, switched_off: true });
    expect(off.headers['x-robots-tag']).toContain('noindex');

    await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ aircon_enabled: true, air_public_enabled: true }) });
    const on = await request(ctx.app).get('/api/public/air?range=week');
    expect(on.status).toBe(200);
    expect(on.body.switched_off).toBeUndefined(); // reaches the air service with no session; Home Assistant itself is not configured in tests
    expect(on.headers['cache-control']).toContain('max-age=60');

    // the fresh air tab being off also closes the public page
    await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ aircon_enabled: false, air_public_enabled: true }) });
    expect((await request(ctx.app).get('/api/public/air')).body.switched_off).toBe(true);
  });
});
