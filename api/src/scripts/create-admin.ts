import crypto from 'node:crypto';
import { ensureCommunity } from '../bootstrap';
import { createDb, migrate } from '../db';
import { hashPassword, passwordProblem } from '../security/crypto';

/**
 * Usage: npm run create-admin -w api -- admin@example.com "Full Name" [super_admin|admin|committee]
 * Password comes from ADMIN_PASSWORD, or a strong one is generated and printed once.
 */
async function main() {
  const [email, name, role = 'super_admin'] = process.argv.slice(2);
  if (!email || !name) {
    console.error('Usage: create-admin <email> "<name>" [super_admin|admin|committee]');
    process.exit(1);
  }
  const db = createDb();
  await migrate(db);
  const communityId = await ensureCommunity(db);
  const password = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(15).toString('base64url');
  const problem = passwordProblem(password, email);
  if (problem) throw new Error(problem);
  const now = new Date().toISOString();
  const existing = await db('users').where({ email: email.toLowerCase() }).first('id');
  if (existing) {
    await db('users').where({ id: existing.id }).update({ role, active: 1, password_hash: await hashPassword(password), token_version: db.raw('token_version + 1') });
  } else {
    await db('users').insert({ id: crypto.randomUUID(), community_id: communityId, email: email.toLowerCase(), password_hash: await hashPassword(password), name, role, tower: null, unit: null, consent_at: now, consent_version: 'admin-bootstrap', created_at: now });
  }
  console.log(`${existing ? 'Updated' : 'Created'} ${role}: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Temporary password (shown once): ${password}`);
  console.log('You will be asked to set up two-factor authentication at first sign-in.');
  await db.destroy();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
