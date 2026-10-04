import crypto from 'node:crypto';
import type { Db } from './db';
import { config } from './config';

/** Ensures at least one community exists so registration works on a fresh database. */
export async function ensureCommunity(db: Db): Promise<string> {
  const existing = await db('communities').where({ slug: config.defaults.communitySlug }).first('id');
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db('communities').insert({
    id,
    name: config.defaults.communityName,
    slug: config.defaults.communitySlug,
    dh_email: config.defaults.dhEmail,
    towers: JSON.stringify(['Tower A', 'Tower B', 'Tower C']),
    settings: '{}',
    created_at: new Date().toISOString(),
  });
  return id;
}
