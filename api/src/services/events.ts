import crypto from 'node:crypto';
import type { Db } from '../db';
import type { EventType, Role } from '../domain';
import { canonicalJson, sha256 } from '../security/crypto';

export const GENESIS = '0'.repeat(64);

export interface EventInput {
  incidentId: string;
  type: EventType;
  actorId?: string | null;
  actorRole?: Role | 'system';
  isPublic?: boolean;
  payload?: Record<string, unknown>;
  at?: string;
}

function eventHash(prev: string, e: { incident_id: string; n: number; type: string; actor_id: string | null; created_at: string; payload: string }): string {
  return sha256(`${prev}|${e.incident_id}|${e.n}|${e.type}|${e.actor_id ?? ''}|${e.created_at}|${e.payload}`);
}

/**
 * Appends an event to an incident's hash-chained log. Every event commits to the hash of the
 * previous one, so any later edit, deletion or reordering of history is detectable (see verifyChain).
 * Must run inside the same transaction as the state change it records.
 */
export async function addEvent(db: Db, input: EventInput): Promise<{ id: string; n: number; hash: string }> {
  const last = await db('incident_events')
    .where({ incident_id: input.incidentId })
    .orderBy('n', 'desc')
    .first('n', 'hash');
  const n = (last?.n ?? 0) + 1;
  const prev = last?.hash ?? GENESIS;
  const created_at = input.at ?? new Date().toISOString();
  const payload = canonicalJson(input.payload ?? {});
  const row = {
    id: crypto.randomUUID(),
    incident_id: input.incidentId,
    n,
    type: input.type,
    actor_id: input.actorId ?? null,
    actor_role: input.actorRole ?? 'system',
    is_public: input.isPublic === false ? 0 : 1,
    payload,
    created_at,
    prev_hash: prev,
  };
  const hash = eventHash(prev, row);
  await db('incident_events').insert({ ...row, hash });
  return { id: row.id, n, hash };
}

export async function verifyChain(
  db: Db,
  incidentId: string,
): Promise<{ ok: boolean; events: number; brokenAt?: number; head: string }> {
  const rows = await db('incident_events').where({ incident_id: incidentId }).orderBy('n', 'asc');
  let prev = GENESIS;
  let expectedN = 1;
  for (const r of rows) {
    if (r.n !== expectedN || r.prev_hash !== prev || eventHash(prev, r) !== r.hash) {
      return { ok: false, events: rows.length, brokenAt: r.n, head: prev };
    }
    prev = r.hash;
    expectedN++;
  }
  return { ok: true, events: rows.length, head: prev };
}
