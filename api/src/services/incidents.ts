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

async function nextSeq(db: Db, communityId: string): Promise<number> {
  const r = await db('incidents').where({ community_id: communityId }).max({ m: 'seq' }).first();
  return Number(r?.m ?? 0) + 1;
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
        const seq = await nextSeq(trx, community.id);
        await trx('incidents').insert({
          id,
          community_id: community.id,
          seq,
          ref: `INC-${String(seq).padStart(4, '0')}`,
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
        if (!opts.skipEmail) await queueMgmtEmail(trx, id, 'new', actor);
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

export async function queueMgmtEmail(
  db: Db,
  incidentId: string,
  kind: 'new' | 'affects' | 'resend',
  actor: Actor,
  extra: { uploadId?: string | null } = {},
): Promise<string> {
  const inc = await getIncidentRow(db, incidentId);
  const community = await getCommunity(db, inc.community_id);
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

  const affector = kind === 'affects' ? actor : null;
  const unitLine = kind === 'affects' ? `${affector?.tower ?? ''}, Unit ${affector?.unit ?? ''}` : `${inc.tower ?? ''}, Unit ${inc.unit ?? ''}`;
  const firstName = (kind === 'affects' ? affector?.name : reporter?.name)?.split(' ')[0] ?? 'A resident';
  const loc = [inc.location_text, inc.lat != null ? `https://www.google.com/maps?q=${inc.lat},${inc.lng}` : null].filter(Boolean).join(' | ');
  const catLabel = CATEGORY_LABELS[inc.category as Category] ?? inc.category;
  const replyTo = config.email.replyDomain ? `inc+${inc.reply_token}@${config.email.replyDomain}` : null;

  const lines: string[] = [
    'Dear Management Team,',
    '',
    kind === 'affects'
      ? `Another resident has confirmed they are ALSO affected by the issue below (${affectsCount} additional resident${affectsCount === 1 ? '' : 's'} so far). Please link this to the existing case.`
      : kind === 'resend'
        ? 'This is a re-send of an earlier report; we have not yet received a case number.'
        : 'A resident has reported the following issue.',
    '',
    `Reference:     ${inc.ref}`,
    inc.mgmt_case_number ? `Your case no.:  ${inc.mgmt_case_number}` : null,
    `First reported: ${dubaiTime(inc.reported_at)}`,
    `Category:      ${catLabel}`,
    `Priority:      ${inc.severity}`,
    `Location:      ${loc || 'Not specified'}`,
    `Resident unit: ${unitLine} (${firstName})`,
    '',
    `Title: ${inc.title}`,
    inc.description ? `Details: ${inc.description}` : null,
    '',
    photoLinks.length ? `Photos (secure links, valid ${config.email.linkTtlDays} days):` : null,
    ...photoLinks.map((l: string) => `  ${l}`),
    photoLinks.length ? '' : null,
    'Please reply to this email with your case / ticket number and the expected resolution date.',
    replyTo ? 'Your reply is recorded automatically against this report.' : null,
    '',
    'Sent by Neighbourhood Reports, an independent resident-run platform (not operated by your management company).',
  ].filter((l): l is string => l !== null);

  const text = lines.join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b2a2a">${lines
    .map((l: string) => (l === '' ? '<br>' : `<div>${esc(l).replace(/(https?:\/\/[^\s|]+)/g, '<a href="$1">$1</a>')}</div>`))
    .join('')}</div>`;

  const subjectPrefix = kind === 'affects' ? 'Additional resident affected' : kind === 'resend' ? 'Reminder' : 'New report';
  const subject = `[${inc.ref}${inc.mgmt_case_number ? ` / ${inc.mgmt_case_number}` : ''}] ${subjectPrefix}: ${catLabel} - ${inc.title} - ${inc.tower ?? ''}`.slice(0, 200);

  const cc = community.settings.cc_reporter && reporter?.email && kind === 'new' ? reporter.email : null;
  const outboxId = await queueEmail(db, {
    kind: `mgmt_${kind}`,
    communityId: community.id,
    incidentId,
    to: community.mgmt_email,
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

export async function addAffect(db: Db, actor: Actor, incidentId: string, uploadId?: string | null, opts: { at?: string; skipEmail?: boolean } = {}) {
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
    await trx('affects').insert({
      id: crypto.randomUUID(),
      incident_id: incidentId,
      user_id: actor.id,
      tower: actor.tower,
      unit: actor.unit,
      upload_id: uploadId ?? null,
      created_at: now,
    });
    const count = Number((await trx('affects').where({ incident_id: incidentId }).count({ c: '*' }).first())?.c ?? 0);
    await addEvent(trx, { incidentId, type: 'affects_added', actorId: actor.id, actorRole: actor.role, at: now, payload: { affects_count: count, upload_id: uploadId ?? null } });
    await trx('incidents').where({ id: incidentId }).update({ last_activity_at: now, updated_at: now });
    if (!opts.skipEmail) await queueMgmtEmail(trx, incidentId, 'affects', actor, { uploadId });
    if (inc.reporter_id) {
      await notify(trx, { userId: inc.reporter_id, incidentId, type: 'affects', at: now, message: `${count} neighbour${count === 1 ? '' : 's'} confirmed they're also affected by ${inc.ref}.` });
    }
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
