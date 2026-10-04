import crypto from 'node:crypto';
import sharp from 'sharp';
import { ensureCommunity } from '../bootstrap';
import { config } from '../config';
import { createDb, migrate, type Db } from '../db';
import type { Category, Severity } from '../domain';
import { hashPassword } from '../security/crypto';
import { processImage } from '../services/images';
import { addAffect, changeStatus, createIncident, setCaseNumber, type Actor } from '../services/incidents';
import { getStorage } from '../services/storage';

/**
 * Temporary demo data so the feed and scorecard have something to show while real
 * historic issues are being collected. Everything is flagged source='demo' / is_demo=1
 * and can be removed in Admin > Import (super admin) without touching real data.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Outcome = 'open' | 'progress' | 'ok' | 'poor' | 'reopened' | 'unverified';
interface Scenario {
  title: string;
  description: string;
  category: Category;
  severity: Severity;
  tower: string;
  daysAgo: number;
  caseAfterH?: number;
  closedAfterD?: number;
  outcome: Outcome;
  affects?: number;
}

const SCENARIOS: Scenario[] = [
  { title: 'Water leaking from ceiling in B2 car park', description: 'Steady drip near bay 214, puddle forming.', category: 'plumbing_leak', severity: 'high', tower: 'Tower A', daysAgo: 71, caseAfterH: 30, closedAfterD: 20, outcome: 'poor', affects: 4 },
  { title: 'Lift 2 out of service', description: 'Sign on door, no estimated return.', category: 'lift', severity: 'high', tower: 'Tower B', daysAgo: 66, caseAfterH: 8, closedAfterD: 6, outcome: 'ok', affects: 6 },
  { title: 'Pool filter noise and cloudy water', description: 'Pool water cloudy since the weekend.', category: 'pool_gym', severity: 'normal', tower: 'Tower A', daysAgo: 60, outcome: 'open', affects: 2 },
  { title: 'Corridor lights out on level 14', description: 'Half the corridor is dark in the evenings.', category: 'electrical', severity: 'normal', tower: 'Tower C', daysAgo: 58, caseAfterH: 52, closedAfterD: 9, outcome: 'reopened', affects: 1 },
  { title: 'Bin room smell on level 9', description: 'Bin chute room not cleaned for days.', category: 'waste', severity: 'normal', tower: 'Tower B', daysAgo: 54, caseAfterH: 20, closedAfterD: 4, outcome: 'ok' },
  { title: 'Gym treadmill broken', description: 'Treadmill 3 belt slipping.', category: 'pool_gym', severity: 'low', tower: 'Tower A', daysAgo: 50, outcome: 'open' },
  { title: 'Cockroaches near lobby', description: 'Seen several near the mailboxes.', category: 'pests', severity: 'normal', tower: 'Tower C', daysAgo: 47, caseAfterH: 60, closedAfterD: 12, outcome: 'poor', affects: 3 },
  { title: 'Basement gate barrier stuck', description: 'Barrier arm stuck up, security issue.', category: 'security', severity: 'high', tower: 'Tower B', daysAgo: 44, caseAfterH: 5, outcome: 'progress', affects: 2 },
  { title: 'Cracked tiles at entrance', description: 'Tile lifting, trip hazard.', category: 'structural', severity: 'normal', tower: 'Tower A', daysAgo: 41, outcome: 'open', affects: 1 },
  { title: 'AC chiller noise at night', description: 'Loud humming from plant room above.', category: 'hvac_ac', severity: 'normal', tower: 'Tower C', daysAgo: 39, caseAfterH: 40, closedAfterD: 15, outcome: 'unverified' },
  { title: 'Garden irrigation flooding path', description: 'Sprinklers running mid-day on the path.', category: 'landscaping', severity: 'low', tower: 'Tower A', daysAgo: 36, caseAfterH: 70, closedAfterD: 3, outcome: 'ok' },
  { title: 'Fire exit door blocked by boxes', description: 'Level 6 stairwell exit blocked.', category: 'fire_safety', severity: 'urgent', tower: 'Tower B', daysAgo: 33, caseAfterH: 3, closedAfterD: 1, outcome: 'ok' },
  { title: 'Water leak from level 22 balcony drain', description: 'Water runs down the facade onto balconies.', category: 'plumbing_leak', severity: 'normal', tower: 'Tower C', daysAgo: 30, outcome: 'open', affects: 5 },
  { title: 'Visitor parking blocked by contractor van', description: 'Same van parked every day.', category: 'parking', severity: 'low', tower: 'Tower A', daysAgo: 28, outcome: 'open' },
  { title: 'Lift 1 stops between floors', description: 'Jolts and stops randomly.', category: 'lift', severity: 'high', tower: 'Tower A', daysAgo: 26, caseAfterH: 15, closedAfterD: 8, outcome: 'poor', affects: 3 },
  { title: 'Broken light in car park B1', description: 'Bay 120 area is very dark.', category: 'electrical', severity: 'normal', tower: 'Tower B', daysAgo: 24, caseAfterH: 28, outcome: 'progress' },
  { title: 'Lobby floor dirty and sticky', description: 'Spill not cleaned for two days.', category: 'cleaning', severity: 'low', tower: 'Tower C', daysAgo: 22, caseAfterH: 6, closedAfterD: 1, outcome: 'ok' },
  { title: 'Loud drilling before 8am', description: 'Fit-out works starting 7am.', category: 'noise', severity: 'low', tower: 'Tower A', daysAgo: 21, outcome: 'open' },
  { title: 'Sewage smell in level 3 corridor', description: 'Strong smell near stairwell.', category: 'plumbing_leak', severity: 'high', tower: 'Tower B', daysAgo: 19, caseAfterH: 90, closedAfterD: 5, outcome: 'unverified' },
  { title: 'Intercom panel not working', description: 'Visitors cannot call apartments.', category: 'security', severity: 'normal', tower: 'Tower C', daysAgo: 17, outcome: 'open' },
  { title: 'Pool hoist and ladder loose', description: 'Handrail loose at deep end.', category: 'pool_gym', severity: 'high', tower: 'Tower A', daysAgo: 15, caseAfterH: 12, outcome: 'progress', affects: 1 },
  { title: 'Rubbish left in stairwell', description: 'Bags on level 11 stairs.', category: 'waste', severity: 'low', tower: 'Tower B', daysAgo: 12, caseAfterH: 18, closedAfterD: 2, outcome: 'ok' },
  { title: 'Ceiling paint peeling after leak', description: 'Level 5 corridor ceiling.', category: 'structural', severity: 'low', tower: 'Tower C', daysAgo: 10, outcome: 'open' },
  { title: 'AC not cooling in gym', description: 'Gym very hot in the evenings.', category: 'hvac_ac', severity: 'normal', tower: 'Tower A', daysAgo: 8, outcome: 'open', affects: 2 },
  { title: 'Gate access card reader fault', description: 'Pedestrian gate not reading cards.', category: 'security', severity: 'normal', tower: 'Tower B', daysAgo: 5, outcome: 'open' },
  { title: 'Lift 3 doors do not close', description: 'Needs several attempts.', category: 'lift', severity: 'normal', tower: 'Tower C', daysAgo: 3, outcome: 'open', affects: 1 },
];

async function placeholderPhoto(db: Db, userId: string, communityId: string, label: string, hue: number): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},35%,38%)"/><stop offset="1" stop-color="hsl(${hue + 30},30%,62%)"/></linearGradient></defs><rect width="900" height="650" fill="url(#g)"/><text x="450" y="300" font-family="sans-serif" font-size="46" fill="white" text-anchor="middle">DEMO PHOTO</text><text x="450" y="360" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle" opacity="0.85">${label.replace(/[<&>]/g, '')}</text></svg>`;
  const img = await processImage(await sharp(Buffer.from(svg)).jpeg().toBuffer());
  const id = crypto.randomUUID();
  const key = `${communityId}/${id}.jpg`;
  const thumbKey = `${communityId}/${id}_t.jpg`;
  await getStorage().put(key, img.full, 'image/jpeg');
  await getStorage().put(thumbKey, img.thumb, 'image/jpeg');
  await db('uploads').insert({ id, user_id: userId, key, thumb_key: thumbKey, mime: 'image/jpeg', bytes: img.full.length, width: img.width, height: img.height, kind: 'report', created_at: new Date().toISOString() });
  return id;
}

async function main() {
  if (config.isProd && process.env.FORCE_SEED !== 'true') {
    console.error('Refusing to seed demo data in production. Set FORCE_SEED=true if you really mean it.');
    process.exit(1);
  }
  const db = createDb();
  await migrate(db);
  const communityId = await ensureCommunity(db);
  if (await db('incidents').where({ source: 'demo' }).first()) {
    console.log('Demo data already present. Remove it from Admin > Import, or delete the dev database, then re-run.');
    await db.destroy();
    return;
  }
  // Demo reports must never email the real management address.
  const community = await db('communities').where({ id: communityId }).first();
  if (!/example\.(com|invalid)/.test(community.dh_email)) {
    console.warn('Note: demo reports are created without sending any email.');
  }

  const now = Date.now();
  const creds: string[] = [];
  const mkUser = async (email: string, name: string, role: string, tower: string | null, unit: string | null) => {
    const password = crypto.randomBytes(12).toString('base64url') + 'Aa1!';
    const id = crypto.randomUUID();
    await db('users').insert({ id, community_id: communityId, email, password_hash: await hashPassword(password), name, role, tower, unit, consent_at: new Date().toISOString(), consent_version: config.privacyNoticeVersion, is_demo: 1, created_at: new Date(now - 80 * DAY).toISOString() });
    creds.push(`${role.padEnd(11)} ${email.padEnd(26)} ${password}`);
    return { id, role: role as Actor['role'], name, tower, unit, community_id: communityId } as Actor;
  };

  const admin = await mkUser('admin@pilot.test', 'Demo Admin', 'super_admin', null, null);
  await mkUser('committee@pilot.test', 'Demo Committee', 'committee', null, null);
  const residents: Actor[] = [];
  const towers = ['Tower A', 'Tower B', 'Tower C'];
  const names = ['Aisha', 'Ben', 'Carla', 'Dev', 'Elena', 'Faisal', 'Grace', 'Hamdan', 'Ines'];
  for (let i = 0; i < names.length; i++) {
    residents.push(await mkUser(`resident${i + 1}@pilot.test`, `${names[i]} Demo`, 'resident', towers[i % 3], String(300 + i * 111)));
  }

  let n = 0;
  for (const sc of SCENARIOS) {
    n++;
    const pool = residents.filter((r) => r.tower === sc.tower);
    const reporter = pool[n % pool.length];
    const reported = now - sc.daysAgo * DAY - (n % 5) * HOUR;
    const photo = await placeholderPhoto(db, reporter.id, communityId, sc.title.slice(0, 38), (n * 37) % 360);
    const inc = await createIncident(
      db,
      reporter,
      { title: sc.title, description: sc.description, category: sc.category, severity: sc.severity, location_text: `${sc.tower} common area`, visibility: 'community', upload_ids: [photo] },
      { at: new Date(reported).toISOString(), source: 'demo', skipEmail: true },
    );
    await db('incidents').where({ id: inc.id }).update({ emailed_at: new Date(reported + 10 * 60_000).toISOString() });

    for (let a = 0; a < (sc.affects ?? 0); a++) {
      const other = residents.filter((r) => r.id !== reporter.id)[(n + a) % (residents.length - 1)];
      try {
        const up = await placeholderPhoto(db, other.id, communityId, `affects ${inc.ref}`, (n * 37 + 90) % 360);
        await addAffect(db, other, inc.id, up, { at: new Date(reported + (a + 1) * 6 * HOUR).toISOString(), skipEmail: true });
      } catch {
        /* same resident twice – skip */
      }
    }

    let t = reported + 10 * 60_000;
    if (sc.caseAfterH != null) {
      t = reported + sc.caseAfterH * HOUR;
      await setCaseNumber(db, reporter, inc.id, `SR-${40000 + n * 17}`, 'user', new Date(t).toISOString());
    }
    if (sc.outcome === 'progress') {
      await changeStatus(db, admin, inc.id, 'in_progress', { at: new Date(t + 6 * HOUR).toISOString() });
    }
    if (sc.closedAfterD != null && ['ok', 'poor', 'reopened', 'unverified'].includes(sc.outcome)) {
      const closedAt = reported + sc.closedAfterD * DAY;
      await changeStatus(db, reporter, inc.id, 'dh_closed', { at: new Date(closedAt).toISOString() });
      const verifyAt = new Date(closedAt + 2 * DAY).toISOString();
      if (sc.outcome === 'ok' || sc.outcome === 'poor') {
        const evidence = await placeholderPhoto(db, reporter.id, communityId, sc.outcome === 'ok' ? 'fixed' : 'not properly fixed', sc.outcome === 'ok' ? 140 : 8);
        await changeStatus(db, reporter, inc.id, sc.outcome === 'ok' ? 'resolved_ok' : 'resolved_poor', { uploadId: evidence, at: verifyAt });
      } else if (sc.outcome === 'reopened') {
        await changeStatus(db, reporter, inc.id, 'reopened', { note: 'Still not working', at: verifyAt });
      }
    }
  }

  console.log(`\nSeeded ${SCENARIOS.length} demo reports. Sign-in details (shown once):\n`);
  console.log(creds.join('\n'));
  console.log('\nAll demo accounts end in @pilot.test and can be removed with Admin > Import > Remove demo data.');
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
