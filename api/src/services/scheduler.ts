import type { Db } from '../db';
import { mergeSettings } from '../domain';
import { addEvent } from './events';
import { processOutbox, queueEmail } from './mailer';
import { getStorage } from './storage';
import { notify } from './support';
import { config } from '../config';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Nudges reporters to add a case number once management has had time to reply, and to verify
 * "closed" reports. Idempotent: counters on the incident stop the same nudge firing twice.
 */
export async function runReminders(db: Db, now = Date.now()): Promise<{ caseReminders: number; verifyReminders: number }> {
  let caseReminders = 0;
  let verifyReminders = 0;
  const communities = await db('communities').select('id', 'settings');
  for (const c of communities) {
    const s = mergeSettings(c.settings);

    // Reminder ladder for "no case number yet": after N hours, 3x N, 7 days
    const caseRows = await db('incidents')
      .where({ community_id: c.id, status: 'reported' })
      .whereNotNull('emailed_at')
      .andWhere('reminders_sent', '<', 3)
      .whereNot({ source: 'demo' });
    for (const r of caseRows) {
      const steps = [s.case_reminder_hours * HOUR, s.case_reminder_hours * 3 * HOUR, 7 * DAY];
      if (now - Date.parse(r.emailed_at) < steps[r.reminders_sent]) continue;
      if (!r.reporter_id) continue;
      await db.transaction(async (trx) => {
        await trx('incidents').where({ id: r.id }).update({ reminders_sent: r.reminders_sent + 1 });
        await notify(trx, { userId: r.reporter_id, incidentId: r.id, type: 'reminder_case', message: `Has the management company replied on ${r.ref}? Add the case number so we can track it.` });
        await addEvent(trx, { incidentId: r.id, type: 'reminder_sent', isPublic: false, payload: { kind: 'case_number', n: r.reminders_sent + 1 } });
        const u = await trx('users').where({ id: r.reporter_id }).first('email', 'notify_email', 'deleted_at', 'active');
        if (u?.notify_email && !u.deleted_at && u.active) {
          await queueEmail(trx, {
            kind: 'reminder_case',
            communityId: c.id,
            incidentId: r.id,
            to: u.email,
            subject: `${r.ref}: did you get a case number?`,
            text: `Hi,\n\nWe emailed the management company about "${r.title}" (${r.ref}). If they replied with a case number, please add it in the app so we can track their response time:\n${config.appBaseUrl}/incident/${r.id}\n\nThanks,\nNeighbourhood Reports`,
          });
        }
      });
      caseReminders++;
    }

    // "Management says closed" but nobody has verified it
    const verifyRows = await db('incidents')
      .where({ community_id: c.id, status: 'mgmt_closed' })
      .andWhere('verify_reminders_sent', '<', 2)
      .whereNot({ source: 'demo' });
    for (const r of verifyRows) {
      const due = Date.parse(r.mgmt_closed_at ?? r.updated_at) + s.verify_reminder_days * DAY * (r.verify_reminders_sent + 1);
      if (now < due) continue;
      await db.transaction(async (trx) => {
        await trx('incidents').where({ id: r.id }).update({ verify_reminders_sent: r.verify_reminders_sent + 1 });
        const ids = new Set<string>(r.reporter_id ? [r.reporter_id] : []);
        for (const a of await trx('affects').where({ incident_id: r.id }).select('user_id')) ids.add(a.user_id);
        for (const userId of ids) {
          await notify(trx, { userId, incidentId: r.id, type: 'reminder_verify', message: `${r.ref} was marked closed by management. Is it really fixed? Add a photo to confirm or reopen.` });
        }
        await addEvent(trx, { incidentId: r.id, type: 'reminder_sent', isPublic: false, payload: { kind: 'verify', n: r.verify_reminders_sent + 1 } });
      });
      verifyReminders++;
    }
  }
  return { caseReminders, verifyReminders };
}

/** Removes photos that were uploaded but never attached to a report within 24h. */
export async function cleanupOrphanUploads(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - DAY).toISOString();
  const rows = await db('uploads').whereNull('incident_id').whereNull('deleted_at').andWhere('created_at', '<', cutoff);
  for (const u of rows) {
    await getStorage().delete(u.key);
    await getStorage().delete(u.thumb_key);
    await db('uploads').where({ id: u.id }).update({ deleted_at: new Date(now).toISOString() });
  }
  return rows.length;
}

/** Applies email send results to the incident timeline. */
export async function deliverOutbox(db: Db) {
  return processOutbox(db, async (r) => {
    if (!r.incident_id || !r.kind.startsWith('mgmt_')) return;
    const now = new Date().toISOString();
    await db.transaction(async (trx) => {
      if (r.status === 'sent') {
        const inc = await trx('incidents').where({ id: r.incident_id }).first('emailed_at');
        if (inc && !inc.emailed_at) await trx('incidents').where({ id: r.incident_id }).update({ emailed_at: now });
        await addEvent(trx, { incidentId: r.incident_id!, type: 'email_sent', payload: { kind: r.kind, outbox_id: r.id } });
      } else {
        await addEvent(trx, { incidentId: r.incident_id!, type: 'email_failed', isPublic: false, payload: { kind: r.kind, outbox_id: r.id, error: r.error } });
      }
    });
  });
}

export function startScheduler(db: Db): () => void {
  const timers = [
    setInterval(() => void deliverOutbox(db).catch((e) => console.error('outbox', e)), 30_000),
    setInterval(() => void runReminders(db).catch((e) => console.error('reminders', e)), 15 * 60_000),
    setInterval(() => void cleanupOrphanUploads(db).catch((e) => console.error('cleanup', e)), 6 * HOUR),
  ];
  void deliverOutbox(db).catch(() => undefined);
  return () => timers.forEach(clearInterval);
}
