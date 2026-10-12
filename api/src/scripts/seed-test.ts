import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureCommunity } from '../bootstrap';
import { config } from '../config';
import { createDb, migrate, type Db } from '../db';
import type { Category, Severity } from '../domain';
import { hashPassword } from '../security/crypto';
import { processImage } from '../services/images';
import { changeStatus, createIncident, setCaseNumber, type Actor } from '../services/incidents';
import { getStorage } from '../services/storage';

/**
 * Loads a small set of clearly-labelled TEST incidents (with real photos from a folder) into the
 * database, without emailing anyone.
 *
 *   npm run seed:test -w api -- "<photo folder>" [manifest.json]      (dev)
 *   node api/dist/scripts/seed-test.js /data/files/_testdata            (inside the app container; needs FORCE_SEED=true)
 *
 * The manifest is test-data-incidents.json in the photo folder if present, else the copy in the repo.
 *
 * - Every report is flagged source='demo', so Admin > Data > "Remove demo data" (super admin) removes it.
 * - References look like TEST-0001 and management case numbers like TEST-SR-2001.
 * - All reports belong to one test resident in tower "MR Test", apartment "Test01" (user test01@pilot.test, flagged demo).
 * - Photos are re-encoded (EXIF stripped) by the normal image pipeline. Photos are never committed to the repo.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Outcome = 'reported' | 'case_number_received' | 'in_progress' | 'mgmt_closed' | 'resolved_ok' | 'resolved_poor' | 'reopened' | 'withdrawn';
interface Entry {
  ref: string;
  title: string;
  description: string;
  category: Category;
  severity: Severity;
  location: string;
  daysAgo: number;
  outcome: Outcome;
  caseNumber?: string;
  caseAfterHours?: number;
  closedAfterDays?: number;
  photos: string[];
}
interface Manifest {
  tower: string;
  unit: string;
  incidents: Entry[];
}

async function storePhoto(db: Db, userId: string, communityId: string, file: string): Promise<string> {
  const img = await processImage(fs.readFileSync(file));
  const id = crypto.randomUUID();
  const key = `${communityId}/${id}.jpg`;
  const thumbKey = `${communityId}/${id}_t.jpg`;
  await getStorage().put(key, img.full, 'image/jpeg');
  await getStorage().put(thumbKey, img.thumb, 'image/jpeg');
  await db('uploads').insert({ id, user_id: userId, key, thumb_key: thumbKey, mime: 'image/jpeg', bytes: img.full.length, width: img.width, height: img.height, kind: 'report', created_at: new Date().toISOString() });
  return id;
}

async function main() {
  const folder = process.argv[2];
  if (!folder || !fs.existsSync(folder)) {
    console.error('Usage: npm run seed:test -w api -- "<folder with the photos>" [manifest.json]');
    process.exit(1);
  }
  // Manifest: explicit argument, else test-data-incidents.json beside the photos, else the copy in the source tree.
  const beside = path.join(folder, 'test-data-incidents.json');
  const manifestPath = process.argv[3] ?? (fs.existsSync(beside) ? beside : path.join(__dirname, 'test-data', 'incidents.json'));
  if (config.isProd && process.env.FORCE_SEED !== 'true') {
    console.error('Refusing to load test data in production. Set FORCE_SEED=true if you really mean it.');
    process.exit(1);
  }
  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const missing = manifest.incidents.flatMap((e) => e.photos).filter((f) => !fs.existsSync(path.join(folder, f)));
  if (missing.length) {
    console.error(`These photos are not in ${folder}:\n  ${missing.slice(0, 10).join('\n  ')}${missing.length > 10 ? `\n  ...and ${missing.length - 10} more` : ''}`);
    process.exit(1);
  }

  const db = createDb();
  await migrate(db);
  const communityId = await ensureCommunity(db);
  if (await db('incidents').where({ community_id: communityId }).andWhere('ref', 'like', 'TEST-%').first()) {
    console.log('TEST incidents are already present. Remove them with Admin > Data > Remove demo data, then re-run.');
    await db.destroy();
    return;
  }
  const admin = await db('users').where({ community_id: communityId }).whereIn('role', ['admin', 'super_admin']).orderBy('created_at').first();
  if (!admin) {
    console.error('No admin account exists yet. Create one first (see docs/unraid.md), then re-run.');
    process.exit(1);
  }
  const adminActor: Actor = { id: admin.id, role: admin.role, name: admin.name, tower: admin.tower, unit: admin.unit, community_id: communityId };

  // Make "MR Test" selectable in the tower list.
  const community = await db('communities').where({ id: communityId }).first();
  const towers: string[] = JSON.parse(community.towers);
  if (!towers.includes(manifest.tower)) await db('communities').where({ id: communityId }).update({ towers: JSON.stringify([...towers, manifest.tower]) });

  // One test resident owns all the reports.
  const email = 'test01@pilot.test';
  let user = await db('users').where({ email }).first();
  if (!user) {
    const id = crypto.randomUUID();
    await db('users').insert({
      id,
      community_id: communityId,
      email,
      password_hash: await hashPassword(crypto.randomBytes(18).toString('base64url') + 'Aa1!'),
      name: 'Test Resident',
      role: 'resident',
      tower: manifest.tower,
      unit: manifest.unit,
      consent_at: new Date().toISOString(),
      consent_version: config.privacyNoticeVersion,
      is_demo: 1,
      created_at: new Date().toISOString(),
    });
    user = await db('users').where({ id }).first();
  }
  const reporter: Actor = { id: user.id, role: 'resident', name: user.name, tower: manifest.tower, unit: manifest.unit, community_id: communityId };

  const now = Date.now();
  for (const e of manifest.incidents) {
    const reported = now - e.daysAgo * DAY;
    const uploadIds: string[] = [];
    for (const f of e.photos) uploadIds.push(await storePhoto(db, reporter.id, communityId, path.join(folder, f)));

    const inc = await createIncident(
      db,
      reporter,
      { title: e.title, description: e.description, category: e.category, severity: e.severity, location_text: e.location, visibility: 'community', upload_ids: uploadIds, tower: manifest.tower, unit: manifest.unit },
      { at: new Date(reported).toISOString(), source: 'demo', skipEmail: true },
    );
    await db('incidents').where({ id: inc.id }).update({ ref: e.ref, emailed_at: new Date(reported + 10 * 60_000).toISOString() });

    let t = reported + 10 * 60_000;
    if (e.caseNumber) {
      t = reported + (e.caseAfterHours ?? 12) * HOUR;
      await setCaseNumber(db, reporter, inc.id, e.caseNumber, 'user', new Date(t).toISOString());
    }
    if (e.outcome === 'in_progress') await changeStatus(db, adminActor, inc.id, 'in_progress', { at: new Date(t + 6 * HOUR).toISOString() });
    if (e.outcome === 'withdrawn') await changeStatus(db, reporter, inc.id, 'withdrawn', { at: new Date(reported + 2 * HOUR).toISOString() });

    if (['mgmt_closed', 'resolved_ok', 'resolved_poor', 'reopened'].includes(e.outcome)) {
      const closedAt = reported + (e.closedAfterDays ?? 3) * DAY;
      await changeStatus(db, reporter, inc.id, 'mgmt_closed', { at: new Date(closedAt).toISOString() });
      const verifyAt = new Date(closedAt + 2 * DAY).toISOString();
      if (e.outcome === 'resolved_ok' || e.outcome === 'resolved_poor') {
        const evidence = await storePhoto(db, reporter.id, communityId, path.join(folder, e.photos[e.photos.length - 1]));
        await changeStatus(db, reporter, inc.id, e.outcome, { uploadId: evidence, at: verifyAt });
      } else if (e.outcome === 'reopened') {
        await changeStatus(db, reporter, inc.id, 'reopened', { note: 'TEST - still not fixed when checked.', at: verifyAt });
      }
    }
    console.log(`${e.ref}  ${e.outcome.padEnd(20)} ${e.photos.length} photo(s)  ${e.title}`);
  }
  console.log(`\nLoaded ${manifest.incidents.length} TEST reports for ${manifest.tower} / ${manifest.unit}. Nothing was emailed.`);
  console.log('Remove them any time with Admin > Data > Remove demo data (super admin).');
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
