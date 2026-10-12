// Tracking mailbox: links emails to cases and takes event times from the emails themselves.
//
// Routes: the tracking mailbox is on Cc of the resident's original email (default), the resident forwards a
// management reply to it (ideally as an attached .eml), or the management company replies to everyone.
// Matching order: reference with a valid check character, management ticket number, message headers.
// Quoted-text guesses are never accepted automatically; they are held for review.

import crypto from 'node:crypto';
import type { Db } from '../db';
import { mergeSettings } from '../domain';
import { addEvent } from './events';
import { extractCaseNumber, HttpError } from './incidents';
import { findTrackingRefs, stripTrackingRefs } from './trackingRef';
import { notify } from './support';

// ---------------- parsing ----------------

export interface ParsedMessage {
  headers: Record<string, string>;
  text: string;
  /** Attached messages (message/rfc822, e.g. a forwarded .eml) */
  attached: ParsedMessage[];
}

function splitHeadBody(raw: string): [string, string] {
  const norm = raw.replace(/\r\n/g, '\n');
  const i = norm.indexOf('\n\n');
  return i < 0 ? [norm, ''] : [norm.slice(0, i), norm.slice(i + 2)];
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = head.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) {
      const k = m[1].toLowerCase();
      out[k] = out[k] ? `${out[k]}\n${m[2]}` : m[2];
    }
  }
  return out;
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const joined = body.replace(/=\n/g, '');
    return Buffer.from(joined.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  }
  return body;
}

const stripHtml = (h: string) =>
  h
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export function parseRfc822(raw: string, depth = 0): ParsedMessage {
  const [head, body] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const ctype = headers['content-type'] ?? 'text/plain';
  const result: ParsedMessage = { headers, text: '', attached: [] };
  const boundary = /boundary="?([^";\s]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary && depth < 4) {
    const parts = body.split(`--${boundary}`).slice(1);
    let html = '';
    for (const part of parts) {
      if (part.startsWith('--')) break;
      const p = part.replace(/^\n/, '');
      const [ph, pb] = splitHeadBody(p);
      const hh = parseHeaders(ph);
      const pt = (hh['content-type'] ?? 'text/plain').toLowerCase();
      if (pt.startsWith('message/rfc822') || /\.eml/i.test(hh['content-disposition'] ?? '')) {
        result.attached.push(parseRfc822(decodeBody(pb, hh['content-transfer-encoding']).replace(/^\n/, ''), depth + 1));
      } else if (pt.startsWith('multipart/')) {
        const inner = parseRfc822(p, depth + 1);
        result.text += inner.text;
        result.attached.push(...inner.attached);
      } else if (pt.startsWith('text/plain') && !/attachment/i.test(hh['content-disposition'] ?? '')) {
        result.text += decodeBody(pb, hh['content-transfer-encoding']);
      } else if (pt.startsWith('text/html')) {
        html += decodeBody(pb, hh['content-transfer-encoding']);
      }
    }
    if (!result.text.trim() && html) result.text = stripHtml(html);
  } else if (ctype.toLowerCase().startsWith('message/rfc822')) {
    result.attached.push(parseRfc822(body, depth + 1));
  } else {
    const decoded = decodeBody(body, headers['content-transfer-encoding']);
    result.text = ctype.toLowerCase().startsWith('text/html') ? stripHtml(decoded) : decoded;
  }
  result.text = result.text.replace(/\r/g, '').trim();
  return result;
}

/** SPF/DKIM/DMARC from an Authentication-Results header added by our own receiving mailbox. */
export function authFromHeader(h: string | undefined): { spf?: string; dkim?: string; dmarc?: string } {
  const out: { spf?: string; dkim?: string; dmarc?: string } = {};
  if (!h) return out;
  for (const k of ['spf', 'dkim', 'dmarc'] as const) {
    const m = new RegExp(`\\b${k}=(pass|fail|softfail|neutral|none|temperror|permerror)`, 'i').exec(h);
    if (m) out[k] = m[1].toLowerCase();
  }
  return out;
}

export function authVerdict(a: { spf?: string; dkim?: string; dmarc?: string } | undefined): 'pass' | 'fail' | 'unknown' {
  if (!a) return 'unknown';
  const vals = [a.spf, a.dkim, a.dmarc].filter(Boolean) as string[];
  if (!vals.length) return 'unknown';
  if (a.dmarc === 'pass') return 'pass';
  if (a.dkim === 'pass' && a.spf === 'pass') return 'pass';
  if (vals.some((v) => v === 'fail' || v === 'softfail' || v === 'permerror')) return 'fail';
  return 'unknown';
}

// ---------------- times ----------------

export interface ParsedTime {
  iso: string;
  offset: string | null;
}

/** Parses an email date. Keeps the offset the sender used. A date with no zone is read as Dubai time (+04:00). */
export function parseEmailDate(raw: string | undefined | null, assumeOffset = '+04:00'): ParsedTime | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, ' ').trim().replace(/\(.*?\)\s*$/, '').trim();
  s = s.replace(/\bat\b/i, ' ').replace(/\bGMT\+?(\d{1,2})(?::?(\d{2}))?\b/i, (_m, h: string, mm?: string) => `+${h.padStart(2, '0')}${mm ?? '00'}`);
  s = s.replace(/\bUTC\s*([+-]\d{1,2}):?(\d{2})?\b/i, (_m, h: string, mm?: string) => `${h[0]}${h.slice(1).padStart(2, '0')}${mm ?? '00'}`);
  const off = /([+-]\d{2}):?(\d{2})\s*$/.exec(s) ?? /\s([+-]\d{2}):?(\d{2})\b/.exec(s);
  const hasZone = !!off || /\b(Z|UTC|GMT)\b/.test(s);
  // Zone-less text is parsed as UTC first so the result does not depend on the server's own time zone.
  let t = Date.parse(hasZone ? s : `${s} UTC`);
  let offset: string | null = off ? `${off[1]}:${off[2]}` : /\b(Z|UTC|GMT)\b/.test(s) ? '+00:00' : null;
  if (Number.isNaN(t)) return null;
  if (!hasZone) {
    // Shift from the UTC reading to the assumed offset.
    const sign = assumeOffset[0] === '-' ? -1 : 1;
    const mins = sign * (Number(assumeOffset.slice(1, 3)) * 60 + Number(assumeOffset.slice(4, 6)));
    t = t - mins * 60_000;
    offset = `${assumeOffset} (assumed)`;
  }
  return { iso: new Date(t).toISOString(), offset };
}

/** Looks for a forwarded-message header block ("From: ... Sent/Date: ... Subject: ...") and returns its date. */
export function forwardedBlockDate(text: string): ParsedTime | null {
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:\*\*)?(?:From|Sent|Date)\s*:/i.test(lines[i])) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      const m = /^\s*(?:\*\*)?(?:Sent|Date)\s*:\s*(.+?)\s*$/i.exec(lines[j]);
      if (m) {
        const p = parseEmailDate(m[1]);
        if (p) return p;
      }
    }
  }
  return null;
}

export type TimeSource = 'original_header' | 'forwarded_text' | 'forward_header' | 'declared' | 'system';

export function resolveEventTime(args: {
  originalHeaderDate?: string | null;
  forwardedText?: string | null;
  forwardHeaderDate?: string | null;
  declaredAt?: string | null;
  receivedAt: string;
}): { at: string; source: TimeSource; offset: string | null; skew: boolean } {
  const tries: [TimeSource, ParsedTime | null][] = [
    ['original_header', parseEmailDate(args.originalHeaderDate)],
    ['forwarded_text', args.forwardedText ? forwardedBlockDate(args.forwardedText) : null],
    ['forward_header', parseEmailDate(args.forwardHeaderDate)],
    ['declared', parseEmailDate(args.declaredAt)],
  ];
  for (const [source, p] of tries) {
    if (p) return { at: p.iso, source, offset: p.offset, skew: Date.parse(p.iso) > Date.parse(args.receivedAt) + 10 * 60_000 };
  }
  return { at: args.receivedAt, source: 'system', offset: null, skew: false };
}

// ---------------- ingest ----------------

export interface InboundInput {
  from?: string;
  subject?: string;
  date?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string;
  text: string;
  auth?: { spf?: string; dkim?: string; dmarc?: string };
  /** An attached original message (forwarded .eml) */
  original?: { date?: string; from?: string; subject?: string; text?: string; message_id?: string };
  /** A date the resident typed in, used only when the email has none */
  declared_at?: string;
}

export function inputFromRaw(raw: string): InboundInput {
  const m = parseRfc822(raw);
  const h = m.headers;
  const att = m.attached[0];
  return {
    from: h['from'],
    subject: h['subject'],
    date: h['date'],
    message_id: h['message-id'],
    in_reply_to: h['in-reply-to'],
    references: h['references'],
    text: m.text,
    auth: authFromHeader(h['authentication-results']),
    original: att ? { date: att.headers['date'], from: att.headers['from'], subject: att.headers['subject'], text: att.text, message_id: att.headers['message-id'] } : undefined,
  };
}

const addrOf = (s: string | undefined) => (/<([^>]+)>/.exec(s ?? '')?.[1] ?? (s ?? '').trim()).toLowerCase();
const ids = (s: string | undefined) => (s ?? '').match(/<[^>]+>/g)?.map((x) => x.toLowerCase()) ?? [];
const cut = (t: string) => t.replace(/\r/g, '').split(/\n>|\nOn .* wrote:|\n-{2,} ?Original Message/i)[0].trim();

interface CaseRef {
  incident: any;
  affect: any | null;
}

export async function caseByRef(db: Db, communityId: string, ref: string): Promise<CaseRef | null> {
  const inc = await db('incidents').where({ community_id: communityId, ref }).first();
  if (inc) return { incident: inc, affect: null };
  const aff = await db('affects').where({ ref }).first();
  if (aff) {
    const i = await db('incidents').where({ id: aff.incident_id, community_id: communityId }).first();
    if (i) return { incident: i, affect: aff };
  }
  return null;
}

async function casesByTicket(db: Db, communityId: string, ticket: string): Promise<CaseRef[]> {
  const out: CaseRef[] = [];
  for (const i of await db('incidents').where({ community_id: communityId }).whereRaw('lower(mgmt_case_number) = ?', [ticket.toLowerCase()])) out.push({ incident: i, affect: null });
  const affs = await db('affects').whereRaw('lower(mgmt_case_number) = ?', [ticket.toLowerCase()]);
  for (const a of affs) {
    const i = await db('incidents').where({ id: a.incident_id, community_id: communityId }).first();
    if (i) out.push({ incident: i, affect: a });
  }
  return out;
}

const distinct = (cs: CaseRef[]) => [...new Map(cs.map((c) => [c.affect?.id ?? c.incident.id, c])).values()];

export interface IngestResult {
  status: 'linked' | 'review' | 'duplicate';
  id: string;
  incident?: string;
  reason?: string;
  event_at: string;
  event_at_source: TimeSource;
}

export async function ingestTrackedEmail(db: Db, communityId: string, input: InboundInput, opts: { receivedAt?: string } = {}): Promise<IngestResult> {
  const community = await db('communities').where({ id: communityId }).first();
  if (!community) throw new HttpError(404, 'Community not found');
  const settings = mergeSettings(community.settings);
  const receivedAt = opts.receivedAt ?? new Date().toISOString();

  const messageId = ids(input.message_id)[0] ?? (input.message_id?.trim().toLowerCase() || null);
  if (messageId) {
    const dup = await db('inbound_emails').where({ community_id: communityId, message_id: messageId }).first();
    if (dup) return { status: 'duplicate', id: dup.id, event_at: dup.event_at, event_at_source: dup.event_at_source };
  }

  const fromAddr = addrOf(input.from);
  const fromDomain = fromAddr.split('@')[1] ?? '';
  const isMgmtDomain = !!fromDomain && settings.management_domains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`));
  const auth = authVerdict(input.auth);
  const subject = (input.subject ?? '').slice(0, 300);
  const fullText = [subject, input.text, input.original?.subject ?? '', input.original?.text ?? ''].join('\n');
  const fwdSubject = /^\s*(fwd?|fw)\s*:/i.test(subject);
  const isForward = !!input.original || fwdSubject || forwardedBlockDate(input.text) !== null;
  const route: 'cc' | 'forward' | 'management_reply' = isMgmtDomain ? 'management_reply' : isForward ? 'forward' : 'cc';

  // ---- match the case ----
  let method: 'reference' | 'ticket' | 'headers' | 'quoted_text' | null = null;
  let matches: CaseRef[] = [];
  let reviewReason: string | null = null;
  let candidateRefs: string[] = [];

  const refs = findTrackingRefs(fullText);
  const byRef: CaseRef[] = [];
  for (const r of refs) {
    const c = await caseByRef(db, communityId, r);
    if (c) byRef.push(c);
  }
  const byRefD = distinct(byRef);
  if (byRefD.length > 1) {
    reviewReason = 'more_than_one_reference';
    candidateRefs = byRefD.map((c) => (c.affect?.ref ?? c.incident.ref) as string);
  } else if (byRefD.length === 1) {
    method = 'reference';
    matches = byRefD;
  }
  if (!matches.length && !reviewReason) {
    const ticket = extractCaseNumber(stripTrackingRefs(fullText));
    if (ticket) {
      const t = distinct(await casesByTicket(db, communityId, ticket));
      if (t.length === 1) {
        method = 'ticket';
        matches = t;
      } else if (t.length > 1) {
        reviewReason = 'ticket_matches_more_than_one_case';
        candidateRefs = t.map((c) => (c.affect?.ref ?? c.incident.ref) as string);
      }
    }
  }
  if (!matches.length && !reviewReason) {
    const want = [...ids(input.in_reply_to), ...ids(input.references)];
    if (want.length) {
      const prior = await db('inbound_emails').where({ community_id: communityId }).whereIn('message_id', want).whereNotNull('incident_id');
      const caseIds = [...new Set(prior.map((p: any) => `${p.incident_id}|${p.affect_id ?? ''}`))];
      if (caseIds.length === 1) {
        const [iid, aid] = caseIds[0].split('|');
        const inc = await db('incidents').where({ id: iid }).first();
        if (inc) {
          method = 'headers';
          matches = [{ incident: inc, affect: aid ? await db('affects').where({ id: aid }).first() : null }];
        }
      }
    }
  }
  if (!matches.length && !reviewReason) {
    // Text of the original quoted in the message: only ever proposed for a person to confirm.
    const hay = fullText.toLowerCase();
    const open = await db('incidents').where({ community_id: communityId }).whereNot({ status: 'withdrawn' }).orderBy('created_at', 'desc').limit(300);
    const hits = open.filter((i: any) => i.title.length >= 8 && hay.includes(String(i.title).toLowerCase()));
    candidateRefs = hits.slice(0, 5).map((i: any) => i.ref as string);
    reviewReason = hits.length ? 'possible_match_from_quoted_text' : 'no_match';
    if (hits.length) method = 'quoted_text';
  }

  // ---- who sent it, and is it trustworthy ----
  const sender = fromAddr ? await db('users').where({ community_id: communityId }).whereRaw('lower(email) = ?', [fromAddr]).whereNull('deleted_at').first() : null;
  const match = matches[0];
  if (!reviewReason && match) {
    if (auth !== 'pass') {
      reviewReason = 'sender_not_verified';
    } else if (route === 'management_reply') {
      /* accepted: management domain, verified sender, matched an existing case */
    } else if (!sender) {
      reviewReason = 'sender_not_a_member';
    } else {
      const owns = match.incident.reporter_id === sender.id || !!(await db('affects').where({ incident_id: match.incident.id, user_id: sender.id }).first());
      if (!owns) reviewReason = 'sender_not_on_this_case';
    }
  }

  // ---- when did it happen? (from the email, not from our receipt) ----
  const kindOfContent: 'resident_sent' | 'management_message' = route === 'cc' ? 'resident_sent' : 'management_message';
  const when = resolveEventTime({
    originalHeaderDate: route === 'forward' ? input.original?.date : input.date,
    forwardedText: route === 'forward' ? input.text : null,
    forwardHeaderDate: input.date,
    declaredAt: input.declared_at,
    receivedAt,
  });

  const snippetSource = route === 'forward' && input.original?.text ? input.original.text : input.text;
  const snippet = cut(snippetSource).slice(0, 2000);
  const rowId = crypto.randomUUID();
  const row = {
    id: rowId,
    community_id: communityId,
    incident_id: match?.incident.id ?? null,
    affect_id: match?.affect?.id ?? null,
    route,
    match_method: method,
    review_reason: null as string | null,
    candidate_refs: candidateRefs.length ? JSON.stringify(candidateRefs) : null,
    from_addr: fromAddr || null,
    from_domain: fromDomain || null,
    from_user_id: sender?.id ?? null,
    subject,
    snippet,
    message_id: messageId,
    in_reply_to: ids(input.in_reply_to)[0] ?? null,
    refs_header: ids(input.references).join(' ') || null,
    auth_result: auth,
    received_at: receivedAt,
    event_at: when.at,
    event_at_source: when.source,
    event_at_offset: when.offset,
    skew_flag: when.skew ? 1 : 0,
    created_at: receivedAt,
  };

  const needsReview = !!reviewReason || !match || method === 'quoted_text';
  if (needsReview) {
    await db('inbound_emails').insert({ ...row, incident_id: null, affect_id: null, status: 'review', review_reason: reviewReason ?? 'no_match' });
    await notifyAdmins(db, communityId, `An email sent to the tracking mailbox needs to be matched to a report (${reviewReason ?? 'no_match'}).`);
    return { status: 'review', id: rowId, reason: reviewReason ?? 'no_match', event_at: when.at, event_at_source: when.source };
  }

  await db.transaction(async (trx) => {
    await trx('inbound_emails').insert({ ...row, status: 'linked' });
    await applyLinkedEmail(trx, { inbound: row, match, kind: kindOfContent, text: snippet, ticketSource: fullText });
  });
  return { status: 'linked', id: rowId, incident: match.incident.ref as string, event_at: when.at, event_at_source: when.source };
}

async function notifyAdmins(db: Db, communityId: string, message: string) {
  const admins = await db('users').where({ community_id: communityId }).whereIn('role', ['admin', 'super_admin']).whereNull('deleted_at').select('id');
  for (const a of admins) await notify(db, { userId: a.id, incidentId: null, type: 'inbound_review', message });
}

/** Writes the case-side effects of a linked email: timeline event, sent/first-reply times, ticket number. */
export async function applyLinkedEmail(
  trx: Db,
  a: { inbound: any; match: CaseRef; kind: 'resident_sent' | 'management_message'; text: string; ticketSource: string },
) {
  const { inbound, match } = a;
  const inc = match.incident;
  const at = inbound.event_at as string;
  const payload: Record<string, unknown> = {
    direction: a.kind,
    route: inbound.route,
    match_method: inbound.match_method,
    event_at_source: inbound.event_at_source,
    event_at_offset: inbound.event_at_offset ?? undefined,
    received_at: inbound.received_at,
    skew: inbound.skew_flag ? true : undefined,
    auth: inbound.auth_result,
    from_domain: inbound.from_domain ?? undefined,
    snippet: a.text.slice(0, 600),
    own_ref: match.affect?.ref ?? undefined,
  };
  const patch: Record<string, unknown> = { last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  if (a.kind === 'resident_sent') {
    // The Cc copy is proof of when the resident really sent it: it replaces the tap on "I've sent it".
    if (match.affect) {
      if (!match.affect.email_confirmed_at) await trx('affects').where({ id: match.affect.id }).update({ email_confirmed_at: at });
    } else if (!inc.emailed_at) {
      patch.emailed_at = at;
    }
  } else {
    const suggestsClosed = /\b(closed|completed|resolved|rectified|fixed)\b/i.test(a.text);
    if (!inc.mgmt_first_reply_at) patch.mgmt_first_reply_at = at;
    const ticket = extractCaseNumber(stripTrackingRefs(a.ticketSource));
    if (ticket) {
      payload.case_number_found = ticket;
      if (match.affect) {
        if (!match.affect.mgmt_case_number) await trx('affects').where({ id: match.affect.id }).update({ mgmt_case_number: ticket });
      } else if (inc.mgmt_case_number !== ticket) {
        const p2: Record<string, unknown> = { mgmt_case_number: ticket };
        if (!inc.case_number_at) p2.case_number_at = at;
        if (inc.status === 'reported') p2.status = 'case_number_received';
        Object.assign(patch, p2);
      }
    }
    if (suggestsClosed) payload.suggests_closed = true;
    const users = new Set<string>();
    if (inc.reporter_id) users.add(inc.reporter_id);
    if (match.affect?.user_id) users.add(match.affect.user_id);
    for (const u of users) {
      await notify(trx, {
        userId: u,
        incidentId: inc.id,
        type: 'mgmt_reply',
        message: suggestsClosed ? `Management replied on ${match.affect?.ref ?? inc.ref} and may have closed it. Please check and confirm if it is really fixed.` : `Management replied on ${match.affect?.ref ?? inc.ref}.`,
      });
    }
  }
  await trx('incidents').where({ id: inc.id }).update(patch);
  await addEvent(trx, { incidentId: inc.id, type: 'email_linked', actorRole: 'system', at, payload });
}

// ---------------- review inbox ----------------

export async function assignInbound(db: Db, actor: { id: string; role: any; community_id: string }, inboundId: string, incidentId: string) {
  const row = await db('inbound_emails').where({ id: inboundId, community_id: actor.community_id }).first();
  if (!row || row.status !== 'review') throw new HttpError(404, 'Email not found in the review list');
  const inc = await db('incidents').where({ id: incidentId, community_id: actor.community_id }).first();
  if (!inc) throw new HttpError(404, 'Report not found');
  const kind = row.route === 'cc' ? 'resident_sent' : 'management_message';
  // If the email came from a resident on the case, use their own case reference when it is theirs.
  const affect = row.from_user_id ? await db('affects').where({ incident_id: inc.id, user_id: row.from_user_id }).first() : null;
  const match: CaseRef = { incident: inc, affect: inc.reporter_id === row.from_user_id ? null : affect ?? null };
  await db.transaction(async (trx) => {
    await trx('inbound_emails').where({ id: row.id }).update({ status: 'linked', incident_id: inc.id, affect_id: match.affect?.id ?? null, match_method: 'manual' });
    await applyLinkedEmail(trx, { inbound: { ...row, match_method: 'manual' }, match, kind, text: row.snippet ?? '', ticketSource: `${row.subject ?? ''}\n${row.snippet ?? ''}` });
  });
}
