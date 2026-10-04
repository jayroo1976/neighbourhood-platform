import crypto from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app';
import { ensureCommunity } from '../src/bootstrap';
import { createDb, migrate, type Db } from '../src/db';
import { hashPassword } from '../src/security/crypto';
import { ConsoleProvider, setMailProviderForTests } from '../src/services/mailer';
import { MemoryStorage, setStorageForTests } from '../src/services/storage';

export const PASSWORD = 'Correct-Horse-Battery-9';
export const H = { 'X-Requested-With': 'neighbourhood' };

export async function setup() {
  const db = createDb('sqlite::memory:');
  await migrate(db);
  const communityId = await ensureCommunity(db);
  const mail = new ConsoleProvider();
  setMailProviderForTests(mail);
  setStorageForTests(new MemoryStorage());
  const app = createApp(db);
  return { db, app, communityId, mail };
}

export async function jpeg(color = '#3a7f7f'): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg().toBuffer();
}

export type Client = ReturnType<typeof request.agent>;

export async function register(app: Express.Application | any, over: Partial<{ email: string; name: string; tower: string; unit: string }> = {}) {
  const agent = request.agent(app);
  const body = {
    email: over.email ?? `user${crypto.randomBytes(3).toString('hex')}@example.test`,
    password: PASSWORD,
    name: over.name ?? 'Test Resident',
    tower: over.tower ?? 'Tower A',
    unit: over.unit ?? '1204',
    consent: true,
  };
  const res = await agent.post('/api/auth/register').set(H).send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email: body.email };
}

export async function makeStaff(db: Db, communityId: string, role: 'admin' | 'super_admin' | 'committee', app: any) {
  const email = `${role}${crypto.randomBytes(3).toString('hex')}@example.test`;
  await db('users').insert({
    id: crypto.randomUUID(),
    community_id: communityId,
    email,
    password_hash: await hashPassword(PASSWORD),
    name: `${role} user`,
    role,
    consent_at: new Date().toISOString(),
    consent_version: 'x',
    created_at: new Date().toISOString(),
  });
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(H).send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`staff login failed ${res.status}`);
  return { agent, email };
}

export async function uploadPhoto(agent: Client, kind: 'report' | 'resolution' | 'affects' = 'report') {
  const res = await agent.post('/api/uploads').set(H).field('kind', kind).attach('file', await jpeg(), { filename: 'p.jpg', contentType: 'image/jpeg' });
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export async function createReport(agent: Client, over: Record<string, unknown> = {}) {
  const upload_id = await uploadPhoto(agent);
  const res = await agent
    .post('/api/incidents')
    .set(H)
    .send({ title: 'Water leaking in car park', description: 'Drip near bay 12', category: 'plumbing_leak', severity: 'normal', upload_ids: [upload_id], lat: 25.20481, lng: 55.27078, ...over });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; ref: string };
}
