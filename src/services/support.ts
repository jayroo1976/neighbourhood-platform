import crypto from 'node:crypto';
import type { Db } from '../db';
import type { Role } from '../domain';

export async function audit(
  db: Db,
  a: { actorId?: string | null; actorRole?: Role | string | null; action: string; targetType?: string; targetId?: string; ip?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db('audit_log').insert({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor_id: a.actorId ?? null,
    actor_role: a.actorRole ?? null,
    action: a.action,
    target_type: a.targetType ?? null,
    target_id: a.targetId ?? null,
    ip: a.ip ?? null,
    detail: JSON.stringify(a.detail ?? {}),
  });
}

export async function notify(
  db: Db,
  n: { userId: string; incidentId?: string | null; type: string; message: string; at?: string },
): Promise<void> {
  await db('notifications').insert({
    id: crypto.randomUUID(),
    user_id: n.userId,
    incident_id: n.incidentId ?? null,
    type: n.type,
    message: n.message,
    created_at: n.at ?? new Date().toISOString(),
  });
}

/** Formats an ISO timestamp in Dubai time for emails / UI text. */
export function dubaiTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso)) + ' GST';
}
