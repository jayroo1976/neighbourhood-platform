import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { createDb } from './db';
import { diagnose, fetchStationPage, importCsv, parseStationPage, runCycle } from './services/outside';
import { haConfigured, runSensorSync } from './services/sensorSync';

/**
 * Collector: a second container from the same image (command `node api/dist/collector.js`). It does two jobs, both writing to the app's database:
 *  - every OUTSIDE_POLL_MINUTES it fetches the public outdoor station page and stores the report;
 *  - about once an hour, when HA_URL, HA_TOKEN and HA_AIR_SENSORS are set, it copies the hourly history of every sensor the Fresh air
 *    monitoring page charts out of Home Assistant, so the charts survive Home Assistant being offline or losing its history.
 *
 *   node api/dist/collector.js                     run forever (the container default)
 *   node api/dist/collector.js --check             fetch once and show what was read; writes nothing
 *   node api/dist/collector.js --once              fetch and store once
 *   node api/dist/collector.js --import-csv FILE   add hours from a station readings CSV (existing hours are left alone)
 *   node api/dist/collector.js --sync-ha           copy the sensor history from Home Assistant once (the first run copies everything it holds)
 */

const ALIVE = '/tmp/collector.alive'; // touched every cycle; the container health check looks at its age
const SEED = path.resolve(__dirname, '../seed-data/outside-readings.csv'); // api/seed-data from both src/ and dist/
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTable(db: ReturnType<typeof createDb>): Promise<void> {
  // The app creates the table when it starts; the collector never runs migrations itself, so the two cannot race.
  for (;;) {
    try {
      if (await db.schema.hasTable('outside_readings')) return;
      log('Waiting for the app to create the outside_readings table...');
    } catch (e) {
      log(`Waiting for the database: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(5000);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const { sourceUrl, pollMinutes, userAgent } = config.outside;

  if (args.includes('--check')) {
    const html = await fetchStationPage(sourceUrl, userAgent);
    const parsed = parseStationPage(html);
    console.log(diagnose(html));
    console.log(parsed.ok ? `\nWould store (read from the page ${parsed.via}):\n${JSON.stringify(parsed.readings, null, 2)}` : `\nNothing could be read: ${parsed.reason}`);
    process.exit(parsed.ok ? 0 : 2);
  }

  const db = createDb();
  await waitForTable(db);

  const i = args.indexOf('--import-csv');
  if (i >= 0) {
    const file = args[i + 1];
    if (!file) throw new Error('Give the CSV path after --import-csv');
    console.log(`Added ${await importCsv(db, file)} hours from ${file}`);
    await db.destroy();
    return;
  }

  // First start on an empty table: bring in the station readings kept with the app, so the charts have their history straight away.
  const have = Number((await db('outside_readings').count({ n: '*' }).first())?.n ?? 0);
  if (have === 0 && fs.existsSync(SEED)) log(`Empty table: added ${await importCsv(db, SEED)} hours of earlier station readings`);

  if (args.includes('--sync-ha')) {
    const s = await runSensorSync(db);
    console.log(`${s.ok ? 'ok' : 'failing'}: ${s.message}`);
    await db.destroy();
    process.exit(s.ok ? 0 : 2);
  }

  if (args.includes('--once')) {
    const r = await runCycle(db, { url: sourceUrl, userAgent });
    console.log(`${r.state}: ${r.message}`);
    await db.destroy();
    process.exit(r.ok ? 0 : 2);
  }

  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (stop = true));
  log(`Collector started: ${sourceUrl} every ${pollMinutes} minutes`);
  let lastSync = 0;
  let syncOk = false;
  while (!stop) {
    const r = await runCycle(db, { url: sourceUrl, userAgent });
    log(`${r.state}: ${r.message}`);
    // the sensor history copy runs hourly, and on every cycle until it works
    if (haConfigured() && (!syncOk || Date.now() - lastSync >= 55 * 60_000)) {
      const s = await runSensorSync(db);
      log(`sensor history ${s.ok ? 'ok' : 'failing'}: ${s.message}`);
      syncOk = s.ok;
      lastSync = Date.now();
    }
    try {
      fs.writeFileSync(ALIVE, new Date().toISOString());
    } catch {
      /* health file is best effort */
    }
    // a little random delay so the fetches do not land on the same second every time
    const wait = pollMinutes * 60_000 + Math.floor(Math.random() * 60_000);
    for (let waited = 0; waited < wait && !stop; waited += 1000) await sleep(1000);
  }
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
