import crypto from 'node:crypto';
import type { Db } from '../db';
import { config } from '../config';
import {
  ADMIN_ROLES,
  CATEGORY_LABELS,
  OPEN_STATUSES,
  mergeSettings,
  type Category,
  type CommunitySettings,
  type Severity,
  type Status,
  type Role,
} from '../domain';
import { addEvent } from './events';
import { queueEmail, esc } from './mailer';
import { signedAbsolute } from './fileLinks';
import { dubaiTime, notify } from './support';
import { makeTrackingRef, normaliseCommunityCode } from './trackingRef';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Actor {
  id: string;
  role: Role;
  name: string;
  tower: string | null;
  unit: string | null;
  community_id: string;
}

export interface CreateInput {
  title: string;
  description: string;
  category: Category;
  severity: Severity;
  location_text?: string | null;
  lat?: number | null;
  lng?: number | null;
  gps_accuracy?: number | null;
  device_reported_at?: string | null;
  visibility: 'community' | 'private';
  upload_ids: string[];
  tower?: string | null;
  unit?: string | null;
}

const isAdmin = (r: Role) => ADMIN_ROLES.includes(r);
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();

export async function getCommunity(db: Db, id: string) {
  const c = await db('communities').where({ id }).first();
  if (!c) throw new HttpError(404, 'Community not found');
  return { ...c, settings: mergeSettings(c.settings) as CommunitySettings, towers: JSON.parse(c.towers) as string[] };
}

export function communityCode(c: { slug: string; settings: CommunitySettings }): string {
  return normaliseCommunityCode(c.settings.community_code, c.slug);
}

/**
 * Hands out the next number from the community's single counter, shared by reports and by each
 * resident's own "affects me" case, and returns the tracking reference built from it.
 * Must run inside the transaction that saves the record.
 */
export async function allocateRef(db: Db, community: { id: string; slug: string; settings: CommunitySettings }, iso: string): Promise<{ seq: number; ref: string }> {
  await db('communities').where({ id: community.id }).increment('ref_seq', 1);
  const row = await db('communities').where({ id: community.id }).first('ref_seq');
  const seq = Number(row.ref_seq);
  return { seq, ref: makeTrackingRef(communityCode(community), iso, seq) };
}

async function claimUploads(db: Db, ids: string[], userId: string, incidentId: string, kind: string) {
  for (const id of ids) {
    const u = await db('uploads').where({ id }).first();
    if (!u || u.user_id !== userId || u.incident_id || u.deleted_at) {
      throw new HttpError(400, 'One of the photos is not available. Please upload it again.', 'bad_upload');
    }
    await db('uploads').where({ id }).update({ incident_id: incidentId, kind });
  }
}

export async function createIncident(
  db: Db,
  actor: Actor,
  input: CreateInput,
  opts: { at?: string; source?: 'app' | 'import' | 'demo'; skipEmail?: boolean; reporterId?: string | null } = {},
) {
  const community = await getCommunity(db, actor.community_id);
  const tower = (input.tower ?? actor.tower)?.trim() || null;
  const unit = (input.unit ?? actor.unit)?.trim() || null;
  if (!opts.source || opts.source === 'app') {
    if (!tower || !unit) throw new HttpError(400, 'Please set your tower and apartment number in your profile first.', 'profile_incomplete');
    const count = await db('incidents').where({ reporter_id: actor.id }).andWhere('created_at', '>', dayAgo()).count({ c: '*' }).first();
    if (Number(count?.c ?? 0) >= community.settings.reports_max_per_day) {
      throw new HttpError(429, `Daily report limit reached (${community.settings.reports_max_per_day}). Please add to an existing report instead.`, 'rate_limited');
    }
  }
  const now = opts.at ?? new Date().toISOString();
  const id = crypto.randomUUID();

  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (trx) => {
        const { seq, ref } = await allocateRef(trx, community, now);
        await trx('incidents').insert({
          id,
          community_id: community.id,
          seq,
          ref,
          reporter_id: opts.reporterId !== undefined ? opts.reporterId : actor.id,
          tower,
          unit,
          title: input.title.trim(),
          description: input.description.trim(),
          category: input.category,
          severity: input.severity,
          status: 'reported',
          visibility: input.visibility,
          location_text: input.location_text?.trim() || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          gps_accuracy: input.gps_accuracy ?? null,
          device_reported_at: input.device_reported_at ?? null,
          reported_at: now,
          reply_token: crypto.randomBytes(8).toString('hex'),
          last_activity_at: now,
          source: opts.source ?? 'app',
          created_at: now,
          updated_at: now,
        });
        await claimUploads(trx, input.upload_ids, actor.id, id, 'report');
        await addEvent(trx, {
          incidentId: id,
          type: opts.source === 'import' ? 'imported' : 'reported',
          actorId: actor.id,
          actorRole: actor.role,
          at: now,
          payload: { title: input.title.trim(), category: input.category, severity: input.severity, photos: input.upload_ids.length, gps: input.lat != null },
        });
        if (!opts.skipEmail && community.settings.email_mode === 'platform') await queueMgmtEmail(trx, id, 'new', actor);
      });
      break;
    } catch (e) {
      // Two residents reporting at the same instant can race on seq; retry once or twice.
      if (attempt < 3 && /unique|duplicate/i.test(String((e as Error).message))) continue;
      throw e;
    }
  }
  return getIncidentRow(db, id);
}

export async function getIncidentRow(db: Db, id: string) {
  const row = await db('incidents').where({ id }).first();
  if (!row) throw new HttpError(404, 'Incident not found');
  return row;
}

// ---------------- emails to management ----------------

export async function composeMgmtEmail(
  db: Db,
  incidentId: string,
  kind: 'new' | 'affects' | 'resend',
  actor: Actor,
  extra: { uploadId?: string | null; caseNumber?: string | null; resident?: boolean } = {},
) {
  const resident = !!extra.resident;
  const inc = await getIncidentRow(db, incidentId);
  const community = await getCommunity(db, inc.community_id);
  const st = community.settings;
  const reporter = inc.reporter_id ? await db('users').where({ id: inc.reporter_id }).first('name', 'email') : null;

  const uploadRows = await db('uploads')
    .where({ incident_id: incidentId })
    .whereNull('deleted_at')
    .modify((q) => {
      if (kind === 'affects' && extra.uploadId) q.where({ id: extra.uploadId });
      else q.where({ kind: 'report' });
    })
    .orderBy('created_at');
  const photoLinks = uploadRows.map((u: { key: string }) => signedAbsolute(u.key));
  const affectsCount = Number((await db('affects').where({ incident_id: incidentId }).count({ c: '*' }).first())?.c ?? 0);

  // Each resident's report is their own case with their own reference.
  const affectRow = kind === 'affects' ? await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first() : null;
  const ref: string = (affectRow?.ref as string | null) ?? inc.ref;
  const caseNo = kind === 'affects' ? (extra.caseNumber ?? affectRow?.mgmt_case_number ?? null) : inc.mgmt_case_number;

  const sender = kind === 'affects' ? actor : null;
  const tower = kind === 'affects' ? sender?.tower : inc.tower;
  const unit = kind === 'affects' ? sender?.unit : inc.unit;
  const fullName = (kind === 'affects' ? sender?.name : reporter?.name) ?? 'A resident';
  const signName = resident ? fullName : fullName.split(' ')[0];
  const catLabel = CATEGORY_LABELS[inc.category as Category] ?? inc.category;
  const maps = inc.lat != null ? `https://www.google.com/maps?q=${inc.lat},${inc.lng}` : null;
  const locShort = (inc.location_text?.trim() || tower || '').slice(0, 60);
  const loc = [inc.location_text, maps].filter(Boolean).join(' | ');
  const urgency = inc.severity === 'urgent' ? 'Urgent (safety or water damage)' : inc.severity === 'high' ? 'High' : inc.severity === 'low' ? 'Low' : 'Standard';
  const replyTo = config.email.replyDomain ? `inc+${inc.reply_token}@${config.email.replyDomain}` : null;
  const trackingMailbox = st.cc_tracking_mailbox && st.tracking_mailbox ? st.tracking_mailbox : null;
  const entity = st.management_entity_short || 'Community Management';

  const lines: string[] = [
    `Dear ${entity},`,
    '',
    kind === 'resend' ? 'This is a reminder of my earlier report, for which I have not yet received a ticket number.' : null,
    kind === 'resend' ? '' : null,
    `I am reporting the following issue in ${tower || community.name}:`,
    '',
    `- Reference: ${ref}`,
    caseNo ? `- Your ticket no.: ${caseNo}` : null,
    `- Location: ${loc || 'Not specified'}`,
    `- Category: ${catLabel}`,
    `- Description: ${inc.title}${inc.description ? `. ${inc.description}` : ''}`,
    `- Urgency: ${urgency}`,
    photoLinks.length ? `- Photos (${photoLinks.length}): secure links, valid ${config.email.linkTtlDays} days` : null,
    ...photoLinks.map((l: string) => `    ${l}`),
    `- First noticed: ${dubaiTime(inc.reported_at)}`,
    '',
    'Please acknowledge with a ticket number and an expected resolution date.',
    st.include_closure_details_line ? 'It would also be helpful if your reply could note the cause, the action taken, and any steps to help prevent it recurring.' : null,
    st.include_other_reports_line && affectsCount > 0 ? `Other residents have also reported this issue: ${affectsCount}.` : null,
    '',
    'This report is being tracked. Please quote the reference above in any reply so it can be matched to this report.',
    '',
    'Regards,',
    signName,
    `${unit ? `Unit ${unit}, ` : ''}${community.name}`,
  ].filter((l): l is string => l !== null);

  const text = lines.join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b2a2a">${lines
    .map((l: string) => (l === '' ? '<br>' : `<div>${esc(l).replace(/(https?:\/\/[^\s|]+)/g, '<a href="$1">$1</a>')}</div>`))
    .join('')}</div>`;

  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(inc.reported_at));
  const subject = `${community.name} – ${catLabel} – ${locShort} – ${day} – Ref ${ref}`.slice(0, 200);

  // The reporter copy (platform mode) and the tracking mailbox both go on Cc.
  const ccList = [community.settings.cc_reporter && reporter?.email && kind === 'new' ? reporter.email : null, trackingMailbox].filter((x): x is string => !!x);
  const cc = ccList.length ? ccList.join(', ') : null;
  return { community, to: community.mgmt_email as string, cc, replyTo, subject, text, html, ref, tracking_mailbox: trackingMailbox };
}

/** Follow-up for a ticket that was closed without saying the cause, the action taken or how recurrence is prevented. */
export async function composeFollowUp(db: Db, actor: Actor, incidentId: string) {
  const inc = await getIncidentRow(db, incidentId);
  if (inc.community_id !== actor.community_id) throw new HttpError(404, 'Incident not found');
  const affectRow = await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first();
  const mine = inc.reporter_id === actor.id;
  if (!mine && !affectRow) throw new HttpError(403, 'Only the reporter or an affected resident can send a follow-up.');
  const community = await getCommunity(db, inc.community_id);
  const st = community.settings;
  const ref: string = mine ? inc.ref : (affectRow.ref as string) ?? inc.ref;
  const ticket: string | null = mine ? inc.mgmt_case_number : (affectRow.mgmt_case_number as string | null) ?? inc.mgmt_case_number;
  const catLabel = CATEGORY_LABELS[inc.category as Category] ?? inc.category;
  const locShort = (inc.location_text?.trim() || inc.tower || '').slice(0, 60);
  const closure = inc.mgmt_closed_at ? dubaiTime(inc.mgmt_closed_at) : null;
  const entity = st.management_entity_short || 'Community Management';
  const body = [
    `Dear ${entity},`,
    '',
    closure && ticket ? `Thank you for your message of ${closure} confirming that ticket ${ticket} is now closed.` : ticket ? `Thank you for your message confirming that ticket ${ticket} is now closed.` : 'Thank you for your message confirming that this report is now closed.',
    '',
    'For my records, could you please let me know:',
    '1. the cause of the issue,',
    '2. the work or action carried out, and',
    '3. any steps planned to help prevent it recurring.',
    '',
    `If the issue is still present, please treat this message as a request to reopen the ticket. Original report: ${dubaiTime(inc.reported_at)}, Ref ${ref}.`,
    '',
    'This report is being tracked. Please quote the reference above in any reply.',
    '',
    'Regards,',
    actor.name,
    `${actor.unit ? `Unit ${actor.unit}, ` : ''}${community.name}`,
  ].join('\n');
  const subject = `Follow-up – ${community.name} – ${catLabel} – ${locShort} – Ref ${ref}${ticket ? ` – Management ticket ${ticket}` : ''}`.slice(0, 200);
  const trackingMailbox = st.cc_tracking_mailbox && st.tracking_mailbox ? st.tracking_mailbox : null;
  await addEvent(db, { incidentId, type: 'followup_drafted', actorId: actor.id, actorRole: actor.role, isPublic: false, payload: { ref } });
  return { kind: 'followup' as const, to: community.mgmt_email as string, cc: trackingMailbox, subject, body, ref };
}

export async function queueMgmtEmail(
  db: Db,
  incidentId: string,
  kind: 'new' | 'affects' | 'resend',
  actor: Actor,
  extra: { uploadId?: string | null; caseNumber?: string | null } = {},
): Promise<string> {
  const { community, to, cc, replyTo, subject, text, html } = await composeMgmtEmail(db, incidentId, kind, actor, extra);
  const outboxId = await queueEmail(db, {
    kind: `mgmt_${kind}`,
    communityId: community.id,
    incidentId,
    to,
    cc,
    replyTo,
    subject,
    text,
    html,
  });
  await addEvent(db, {
    incidentId,
    type: 'email_queued',
    actorId: actor.id,
    actorRole: actor.role,
    isPublic: false,
    payload: { outbox_id: outboxId, kind },
  });
  return outboxId;
}

// ---------------- "Affects me" ----------------

export async function addAffect(db: Db, actor: Actor, incidentId: string, uploadId?: string | null, opts: { at?: string; skipEmail?: boolean; caseNumber?: string | null } = {}) {
  const ownCase = opts.caseNumber?.trim() || null;
  if (ownCase && !CASE_RE.test(ownCase)) throw new HttpError(400, 'That incident ID looks invalid. Use letters, numbers and dashes (3-40 characters).');
  const inc = await getIncidentRow(db, incidentId);
  if (inc.community_id !== actor.community_id) throw new HttpError(404, 'Incident not found');
  const community = await getCommunity(db, inc.community_id);
  if (inc.reporter_id === actor.id) throw new HttpError(400, 'You reported this one, so it already counts.');
  if (inc.visibility === 'private') throw new HttpError(404, 'Incident not found');
  if (!OPEN_STATUSES.includes(inc.status) && inc.status !== 'mgmt_closed') {
    throw new HttpError(400, 'This report is already closed. Please log a new report if the problem is back.');
  }
  if (!actor.tower || !actor.unit) throw new HttpError(400, 'Please set your tower and apartment number first.', 'profile_incomplete');
  if (await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first()) {
    throw new HttpError(409, 'You have already added yourself to this report.');
  }
  if (community.settings.require_photo_for_affects && !uploadId) {
    throw new HttpError(400, 'Please add a new photo showing how this affects you.', 'photo_required');
  }
  const today = await db('affects').where({ user_id: actor.id }).andWhere('created_at', '>', dayAgo()).count({ c: '*' }).first();
  if (Number(today?.c ?? 0) >= community.settings.affects_max_per_day) {
    throw new HttpError(429, 'Daily limit reached for "Affects me". This keeps the platform useful for everyone.', 'rate_limited');
  }

  const now = opts.at ?? new Date().toISOString();
  await db.transaction(async (trx) => {
    if (uploadId) await claimUploads(trx, [uploadId], actor.id, incidentId, 'affects');
    const own = await allocateRef(trx, community, now);
    await trx('affects').insert({
      id: crypto.randomUUID(),
      seq: own.seq,
      ref: own.ref,
      incident_id: incidentId,
      user_id: actor.id,
      tower: actor.tower,
      unit: actor.unit,
      upload_id: uploadId ?? null,
      mgmt_case_number: ownCase,
      created_at: now,
    });
    const count = Number((await trx('affects').where({ incident_id: incidentId }).count({ c: '*' }).first())?.c ?? 0);
    await addEvent(trx, { incidentId, type: 'affects_added', actorId: actor.id, actorRole: actor.role, at: now, payload: { affects_count: count, upload_id: uploadId ?? null, own_ref: own.ref } });
    await trx('incidents').where({ id: incidentId }).update({ last_activity_at: now, updated_at: now });
    if (!opts.skipEmail && community.settings.email_mode === 'platform') await queueMgmtEmail(trx, incidentId, 'affects', actor, { uploadId, caseNumber: ownCase });
    if (inc.reporter_id) {
      await notify(trx, { userId: inc.reporter_id, incidentId, type: 'affects', at: now, message: `${count} neighbour${count === 1 ? '' : 's'} confirmed they're also affected by ${inc.ref}.` });
    }
  });
}

// ---------------- resident sends the email from their own mail app ----------------

/** The email a resident sends from their own email app (so it comes from them). */
export async function residentEmailDraft(db: Db, actor: Actor, incidentId: string) {
  const inc = await getIncidentRow(db, incidentId);
  if (inc.community_id !== actor.community_id) throw new HttpError(404, 'Incident not found');
  if (inc.reporter_id === actor.id) {
    const d = await composeMgmtEmail(db, incidentId, 'new', actor, { resident: true });
    return { kind: 'new' as const, to: d.to, cc: d.tracking_mailbox, ref: d.ref, subject: d.subject, body: d.text, confirmed_at: inc.emailed_at as string | null };
  }
  const mine = await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first();
  if (!mine) throw new HttpError(403, 'Only the reporter or an affected resident can email management.');
  const d = await composeMgmtEmail(db, incidentId, 'affects', actor, { uploadId: mine.upload_id, caseNumber: mine.mgmt_case_number, resident: true });
  return { kind: 'affects' as const, to: d.to, cc: d.tracking_mailbox, ref: d.ref, subject: d.subject, body: d.text, confirmed_at: (mine.email_confirmed_at as string | null) ?? null };
}

/** The resident confirms they pressed send in their own email app. Recorded with a timestamp. */
export async function confirmResidentEmail(db: Db, actor: Actor, incidentId: string) {
  const inc = await getIncidentRow(db, incidentId);
  if (inc.community_id !== actor.community_id) throw new HttpError(404, 'Incident not found');
  const now = new Date().toISOString();
  if (inc.reporter_id === actor.id) {
    if (inc.emailed_at) return;
    await db.transaction(async (trx) => {
      await trx('incidents').where({ id: incidentId }).update({ emailed_at: now, last_activity_at: now, updated_at: now });
      await addEvent(trx, { incidentId, type: 'email_sent', actorId: actor.id, actorRole: actor.role, at: now, payload: { kind: 'resident_new' } });
    });
    return;
  }
  const mine = await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first();
  if (!mine) throw new HttpError(403, 'Only the reporter or an affected resident can do this.');
  if (mine.email_confirmed_at) return;
  await db.transaction(async (trx) => {
    await trx('affects').where({ id: mine.id }).update({ email_confirmed_at: now });
    await addEvent(trx, { incidentId, type: 'email_sent', actorId: actor.id, actorRole: actor.role, at: now, payload: { kind: 'resident_affects' } });
  });
}

// ---------------- case number ----------------

const CASE_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/. ]{2,39}$/;

export async function canActOn(db: Db, actor: Actor, inc: { id: string; reporter_id: string | null; community_id: string }): Promise<boolean> {
  if (inc.community_id !== actor.community_id) return false;
  if (isAdmin(actor.role)) return true;
  if (inc.reporter_id === actor.id) return true;
  return !!(await db('affects').where({ incident_id: inc.id, user_id: actor.id }).first());
}

async function notifyParticipants(db: Db, inc: { id: string; ref: string; reporter_id: string | null }, exceptUserId: string | null, type: string, message: string) {
  const ids = new Set<string>();
  if (inc.reporter_id) ids.add(inc.reporter_id);
  for (const a of await db('affects').where({ incident_id: inc.id }).select('user_id')) ids.add(a.user_id);
  if (exceptUserId) ids.delete(exceptUserId);
  for (const userId of ids) await notify(db, { userId, incidentId: inc.id, type, message });
}

export async function setCaseNumber(db: Db, actor: Actor | null, incidentId: string, raw: string, source: 'user' | 'inbound_email' = 'user', at?: string) {
  const value = raw.trim();
  if (!CASE_RE.test(value)) throw new HttpError(400, 'Case number looks invalid. Use letters, numbers and dashes (3-40 characters).');
  const inc = await getIncidentRow(db, incidentId);
  if (actor && !(await canActOn(db, actor, inc))) throw new HttpError(403, 'Only the reporter or an affected resident can add a case number.');
  if (inc.mgmt_case_number === value) return inc;
  const now = at ?? new Date().toISOString();
  await db.transaction(async (trx) => {
    const patch: Record<string, unknown> = { mgmt_case_number: value, last_activity_at: now, updated_at: now };
    if (!inc.case_number_at) patch.case_number_at = now;
    if (inc.status === 'reported') patch.status = 'case_number_received';
    await trx('incidents').where({ id: incidentId }).update(patch);
    await addEvent(trx, {
      incidentId,
      type: 'case_number_added',
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'system',
      at: now,
      payload: { case_number: value, previous: inc.mgmt_case_number, source },
    });
    await notifyParticipants(trx, inc, actor?.id ?? null, 'case_number', `${inc.ref} now has management case number ${value}.`);
  });
  return getIncidentRow(db, incidentId);
}

/** An affected resident records the management company's reference for THEIR OWN report/ticket. */
export async function setMyCaseNumber(db: Db, actor: Actor, incidentId: string, raw: string) {
  const value = raw.trim();
  if (!CASE_RE.test(value)) throw new HttpError(400, 'That incident ID looks invalid. Use letters, numbers and dashes (3-40 characters).');
  const row = await db('affects').where({ incident_id: incidentId, user_id: actor.id }).first();
  if (!row) throw new HttpError(403, 'Add yourself with "This affects me too" first.');
  await db('affects').where({ id: row.id }).update({ mgmt_case_number: value });
}

// ---------------- status transitions ----------------

export type StatusAction = 'in_progress' | 'mgmt_closed' | 'resolved_ok' | 'resolved_poor' | 'reopened' | 'withdrawn';

export async function changeStatus(
  db: Db,
  actor: Actor,
  incidentId: string,
  to: StatusAction,
  opts: { note?: string; uploadId?: string | null; at?: string } = {},
) {
  const inc = await getIncidentRow(db, incidentId);
  if (!(await canActOn(db, actor, inc))) throw new HttpError(403, 'You cannot update this report.');
  const admin = isAdmin(actor.role);
  const from = inc.status as Status;
  const now = opts.at ?? new Date().toISOString();

  if (from === 'withdrawn') throw new HttpError(400, 'This report was withdrawn.');
  if (to === 'in_progress' && !admin) throw new HttpError(403, 'Only moderators can mark a report in progress.');

  const resolving = to === 'resolved_ok' || to === 'resolved_poor';
  if (resolving && !opts.uploadId && !(admin && opts.note)) {
    throw new HttpError(400, 'Please add a photo of the current state as evidence.', 'photo_required');
  }
  if (to === 'mgmt_closed' && !(OPEN_STATUSES as Status[]).includes(from)) throw new HttpError(400, 'Only an open report can be marked closed by management.');
  if (to === 'reopened' && (OPEN_STATUSES as Status[]).includes(from)) throw new HttpError(400, 'This report is already open.');
  if (to === 'in_progress' && !(OPEN_STATUSES as Status[]).includes(from)) throw new HttpError(400, 'Re-open the report first.');
  if (to === 'withdrawn') {
    const others = Number((await db('affects').where({ incident_id: incidentId }).count({ c: '*' }).first())?.c ?? 0);
    if (!admin && (inc.reporter_id !== actor.id || others > 0)) throw new HttpError(403, 'Only the reporter can withdraw, and only if nobody else is affected.');
  }

  await db.transaction(async (trx) => {
    const patch: Record<string, unknown> = { status: to, last_activity_at: now, updated_at: now };
    if (to === 'mgmt_closed') {
      patch.mgmt_closed_at = now;
      patch.mgmt_closed_count = Number(inc.mgmt_closed_count ?? 0) + 1;
      // Whatever the closure message said about cause, action and prevention. Empty = "Closure details not provided".
      patch.closure_details = opts.note?.trim().slice(0, 1500) || null;
      patch.verify_reminders_sent = 0;
    }
    if (resolving) {
      patch.resolved_at = now;
      patch.resolution = to === 'resolved_ok' ? 'ok' : 'poor';
    }
    if (to === 'reopened') {
      patch.reopen_count = Number(inc.reopen_count) + 1;
      patch.resolved_at = null;
      patch.resolution = null;
    }
    if (opts.uploadId) await claimUploads(trx, [opts.uploadId], actor.id, incidentId, 'resolution');
    await trx('incidents').where({ id: incidentId }).update(patch);
    const type = to === 'in_progress' ? 'status_changed' : to === 'reopened' ? 'reopened' : to;
    await addEvent(trx, {
      incidentId,
      type: type as never,
      actorId: actor.id,
      actorRole: actor.role,
      at: now,
      payload: { from, to, note: opts.note?.trim().slice(0, 1000) || undefined, upload_id: opts.uploadId ?? undefined, admin_override: admin && resolving && !opts.uploadId ? true : undefined },
    });
    const msg: Record<StatusAction, string> = {
      in_progress: `${inc.ref} is now marked in progress.`,
      mgmt_closed: `${inc.ref} was marked closed by management. Is it really fixed? Please verify with a photo.`,
      resolved_ok: `${inc.ref} was confirmed fixed.`,
      resolved_poor: `${inc.ref} was closed but reported as poorly fixed.`,
      reopened: `${inc.ref} was reopened - the problem is still there.`,
      withdrawn: `${inc.ref} was withdrawn.`,
    };
    await notifyParticipants(trx, inc, actor.id, 'status', msg[to]);
  });
  return getIncidentRow(db, incidentId);
}

/** Record what the management closure message said about cause, action taken and prevention. */
export async function setClosureDetails(db: Db, actor: Actor, incidentId: string, text: string) {
  const inc = await getIncidentRow(db, incidentId);
  if (!(await canActOn(db, actor, inc))) throw new HttpError(403, 'You cannot update this report.');
  const clean = text.trim().slice(0, 1500);
  if (!clean) throw new HttpError(400, 'Please enter what the closure message said.');
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await trx('incidents').where({ id: incidentId }).update({ closure_details: clean, last_activity_at: now, updated_at: now });
    await addEvent(trx, { incidentId, type: 'note_added', actorId: actor.id, actorRole: actor.role, payload: { text: `Closure details recorded: ${clean}` } });
  });
}

export async function addNote(db: Db, actor: Actor, incidentId: string, text: string, internal = false) {
  const inc = await getIncidentRow(db, incidentId);
  if (!(await canActOn(db, actor, inc))) throw new HttpError(403, 'You cannot update this report.');
  if (internal && !isAdmin(actor.role)) throw new HttpError(403, 'Only moderators can add internal notes.');
  const clean = text.trim().slice(0, 1500);
  if (!clean) throw new HttpError(400, 'Note is empty.');
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await addEvent(trx, { incidentId, type: 'note_added', actorId: actor.id, actorRole: actor.role, isPublic: !internal, payload: { text: clean } });
    await trx('incidents').where({ id: incidentId }).update({ last_activity_at: now, updated_at: now });
  });
}

// ---------------- consolidation (linking) ----------------

export async function linkIncidents(db: Db, actor: Actor, primaryId: string, childIds: string[]) {
  const primary = await getIncidentRow(db, primaryId);
  if (primary.community_id !== actor.community_id) throw new HttpError(404, 'Incident not found');
  if (primary.cluster_id) throw new HttpError(400, 'Pick the main report of the group as the primary.');
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    for (const id of childIds) {
      if (id === primaryId) continue;
      const child = await getIncidentRow(trx, id);
      if (child.community_id !== primary.community_id) throw new HttpError(400, 'Reports must be in the same community.');
      // If the child was itself a primary, re-point its children
      await trx('incidents').where({ cluster_id: id }).update({ cluster_id: primaryId });
      await trx('incidents').where({ id }).update({ cluster_id: primaryId, updated_at: now });
      await addEvent(trx, { incidentId: id, type: 'linked', actorId: actor.id, actorRole: actor.role, payload: { primary: primary.ref } });
    }
    await addEvent(trx, { incidentId: primaryId, type: 'linked', actorId: actor.id, actorRole: actor.role, payload: { linked: childIds.length } });
  });
}

export async function unlinkIncident(db: Db, actor: Actor, id: string) {
  const inc = await getIncidentRow(db, id);
  if (!inc.cluster_id) return;
  await db.transaction(async (trx) => {
    await trx('incidents').where({ id }).update({ cluster_id: null, updated_at: new Date().toISOString() });
    await addEvent(trx, { incidentId: id, type: 'unlinked', actorId: actor.id, actorRole: actor.role, payload: {} });
  });
}

// ---------------- management replies (inbound email) ----------------

const CASE_PATTERNS = [
  /(?:case|ticket|service\s*request|sr|reference|ref)\s*(?:no\.?|number|#|id)?\s*[:#-]?\s*([A-Z]{0,4}[-]?\d{4,12}[A-Z0-9-]*)/i,
  /\b((?:SR|CS|TKT|CASE)[-/]?\d{4,12})\b/i,
];

export function extractCaseNumber(text: string): string | null {
  for (const re of CASE_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1] && CASE_RE.test(m[1])) return m[1].toUpperCase();
  }
  return null;
}

export async function recordMgmtReply(db: Db, replyToken: string, args: { from?: string; subject?: string; text: string }) {
  const inc = await db('incidents').where({ reply_token: replyToken.toLowerCase() }).first();
  if (!inc) throw new HttpError(404, 'Unknown reply address');
  const now = new Date().toISOString();
  const body = args.text.replace(/\r/g, '').split(/\n>|\nOn .* wrote:|\n-{2,} ?Original Message/i)[0].trim().slice(0, 2000);
  const suggestsClosed = /\b(closed|completed|resolved|rectified|fixed)\b/i.test(body);
  const found = extractCaseNumber(`${args.subject ?? ''}\n${body}`);
  await db.transaction(async (trx) => {
    const patch: Record<string, unknown> = { last_activity_at: now, updated_at: now };
    if (!inc.mgmt_first_reply_at) patch.mgmt_first_reply_at = now;
    await trx('incidents').where({ id: inc.id }).update(patch);
    await addEvent(trx, {
      incidentId: inc.id,
      type: 'mgmt_reply_received',
      actorRole: 'system',
      payload: { from_domain: args.from?.split('@')[1]?.toLowerCase(), snippet: body.slice(0, 600), case_number_found: found ?? undefined, suggests_closed: suggestsClosed || undefined },
    });
    if (suggestsClosed) {
      await notifyParticipants(trx, inc, null, 'mgmt_reply', `Management replied on ${inc.ref} and may have closed it. Please check and confirm if it is really fixed.`);
    } else {
      await notifyParticipants(trx, inc, null, 'mgmt_reply', `Management replied on ${inc.ref}.`);
    }
  });
  if (found) await setCaseNumber(db, null, inc.id, found, 'inbound_email');
  return { incident: inc.ref, caseNumber: found };
}
