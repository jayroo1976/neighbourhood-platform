import type { Db } from '../db';
import { ADMIN_ROLES, mergeSettings, type Role } from '../domain';
import { incidentKpis } from './kpi';
import { signedPath } from './fileLinks';
import type { Actor } from './incidents';

type Viewer = Pick<Actor, 'id' | 'role' | 'community_id'>;
const isAdmin = (v: Viewer) => ADMIN_ROLES.includes(v.role);
const isStaff = (v: Viewer) => isAdmin(v) || v.role === 'committee';

/** ~110 m precision: enough to see which building, not which balcony. */
const blur = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);

export async function affectsCounts(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = (await db('affects').whereIn('incident_id', ids).groupBy('incident_id').select('incident_id').count({ c: '*' })) as unknown as { incident_id: string; c: number | string }[];
  return new Map(rows.map((r: { incident_id: string; c: number | string }) => [r.incident_id, Number(r.c)]));
}

async function firstThumbs(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db('uploads').whereIn('incident_id', ids).whereNull('deleted_at').andWhere({ kind: 'report' }).orderBy('created_at');
  const m = new Map<string, string>();
  for (const r of rows) if (!m.has(r.incident_id)) m.set(r.incident_id, signedPath(r.thumb_key, 3600));
  return m;
}

export async function listItems(db: Db, rows: any[], viewer: Viewer) {
  const ids = rows.map((r) => r.id);
  const [counts, thumbs, mineAffects, clusters] = await Promise.all([
    affectsCounts(db, ids),
    firstThumbs(db, ids),
    db('affects').where({ user_id: viewer.id }).whereIn('incident_id', ids).select('incident_id'),
    db('incidents').whereIn('cluster_id', ids).groupBy('cluster_id').select('cluster_id').count({ c: '*' }) as unknown as Promise<{ cluster_id: string; c: number | string }[]>,
  ]);
  const iAffect = new Set(mineAffects.map((a: { incident_id: string }) => a.incident_id));
  const clusterSize = new Map(clusters.map((c: { cluster_id: string; c: number | string }) => [c.cluster_id, Number(c.c)]));
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    title: r.title,
    category: r.category,
    severity: r.severity,
    status: r.status,
    tower: r.tower,
    reported_at: r.reported_at,
    last_activity_at: r.last_activity_at,
    dh_case_number: r.dh_case_number,
    affects_count: counts.get(r.id) ?? 0,
    linked_reports: clusterSize.get(r.id) ?? 0,
    is_linked_child: !!r.cluster_id,
    thumb_url: thumbs.get(r.id) ?? null,
    is_mine: r.reporter_id === viewer.id,
    i_affect: iAffect.has(r.id),
    private: r.visibility === 'private',
  }));
}

function actorLabel(e: { actor_id: string | null; actor_role: string }, incident: { reporter_id: string | null }, viewer: Viewer): string {
  if (e.actor_id && e.actor_id === viewer.id) return 'You';
  if (e.actor_role === 'system') return 'System';
  if (ADMIN_ROLES.includes(e.actor_role as Role)) return 'Moderator';
  if (e.actor_id && e.actor_id === incident.reporter_id) return 'Reporter';
  return 'A neighbour';
}

const PUBLIC_PAYLOAD_KEYS: Record<string, string[]> = {
  reported: ['title', 'category', 'severity', 'photos'],
  imported: ['title', 'category'],
  email_sent: ['kind'],
  case_number_added: ['case_number', 'previous', 'source'],
  status_changed: ['from', 'to', 'note'],
  dh_closed: ['from', 'to', 'note'],
  resolved_ok: ['from', 'to', 'note', 'upload_id', 'admin_override'],
  resolved_poor: ['from', 'to', 'note', 'upload_id', 'admin_override'],
  reopened: ['from', 'to', 'note', 'upload_id'],
  withdrawn: ['reason'],
  note_added: ['text'],
  affects_added: ['affects_count', 'upload_id'],
  linked: ['primary', 'linked'],
  unlinked: [],
  edited: ['fields'],
  dh_reply_received: ['snippet', 'case_number_found', 'suggests_closed'],
};

export async function incidentDetail(db: Db, row: any, viewer: Viewer, opts: { forAdmin?: boolean } = {}) {
  const staff = opts.forAdmin && isStaff(viewer);
  const admin = opts.forAdmin && isAdmin(viewer);
  const mine = row.reporter_id === viewer.id;
  const affectRow = await db('affects').where({ incident_id: row.id, user_id: viewer.id }).first();
  const community = await db('communities').where({ id: row.community_id }).first();
  const settings = mergeSettings(community.settings);

  const eventsQ = db('incident_events').where({ incident_id: row.id }).orderBy('n');
  if (!admin) eventsQ.andWhere({ is_public: 1 });
  const events = (await eventsQ).map((e) => {
    const payload = JSON.parse(e.payload) as Record<string, unknown>;
    const allowed = PUBLIC_PAYLOAD_KEYS[e.type];
    const shown = admin ? payload : Object.fromEntries(Object.entries(payload).filter(([k]) => allowed?.includes(k)));
    return { n: e.n, type: e.type, at: e.created_at, actor: actorLabel(e, row, viewer), internal: !e.is_public, payload: shown };
  });

  const photos = (await db('uploads').where({ incident_id: row.id }).whereNull('deleted_at').orderBy('created_at')).map((u) => ({
    id: u.id,
    kind: u.kind,
    url: signedPath(u.key, 3600),
    thumb_url: signedPath(u.thumb_key, 3600),
    created_at: u.created_at,
    mine: u.user_id === viewer.id,
  }));

  const affectsRows = await db('affects').where({ incident_id: row.id }).orderBy('created_at');
  const cluster = await db('incidents')
    .where((q) => q.where({ cluster_id: row.cluster_id ?? row.id }).orWhere({ id: row.cluster_id ?? row.id }))
    .andWhereNot({ id: row.id })
    .modify((q) => {
      if (!staff) q.where({ visibility: 'community' });
    })
    .select('id', 'ref', 'title', 'status', 'tower');

  const reporter = admin && row.reporter_id ? await db('users').where({ id: row.reporter_id }).first('name', 'email', 'phone') : null;
  const showExact = mine || staff;
  const detail: Record<string, unknown> = {
    id: row.id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    category: row.category,
    severity: row.severity,
    status: row.status,
    visibility: row.visibility,
    tower: row.tower,
    unit: mine || admin ? row.unit : undefined,
    location_text: row.location_text,
    lat: showExact && (mine || admin) ? row.lat : blur(row.lat),
    lng: showExact && (mine || admin) ? row.lng : blur(row.lng),
    gps_blurred: !(mine || admin),
    reported_at: row.reported_at,
    emailed_at: row.emailed_at,
    dh_case_number: row.dh_case_number,
    case_number_at: row.case_number_at,
    dh_closed_at: row.dh_closed_at,
    resolved_at: row.resolved_at,
    resolution: row.resolution,
    reopen_count: row.reopen_count,
    source: row.source,
    cluster_id: row.cluster_id,
    affects_count: affectsRows.length,
    linked: cluster,
    photos,
    events,
    kpis: incidentKpis(row, settings),
    permissions: {
      is_mine: mine,
      i_affect: !!affectRow,
      can_act: isAdmin(viewer) || mine || !!affectRow,
      can_affect: !mine && !affectRow && row.visibility === 'community' && ['reported', 'case_number_received', 'in_progress', 'reopened', 'dh_closed'].includes(row.status),
      affect_needs_photo: settings.require_photo_for_affects,
    },
  };
  if (admin) {
    detail.reporter = reporter;
    detail.affects = affectsRows.map((a) => ({ tower: a.tower, unit: a.unit, at: a.created_at }));
    detail.reply_address_token = row.reply_token;
    detail.dh_first_reply_at = row.dh_first_reply_at;
    detail.reminders_sent = row.reminders_sent;
  }
  return detail;
}

export function adminListItem(r: any, counts: Map<string, number>, clusterSizes: Map<string, number>, settings: ReturnType<typeof mergeSettings>) {
  const k = incidentKpis(r, settings);
  return {
    id: r.id,
    ref: r.ref,
    title: r.title,
    category: r.category,
    severity: r.severity,
    status: r.status,
    tower: r.tower,
    unit: r.unit,
    visibility: r.visibility,
    reported_at: r.reported_at,
    emailed_at: r.emailed_at,
    dh_case_number: r.dh_case_number,
    affects_count: counts.get(r.id) ?? 0,
    cluster_id: r.cluster_id,
    linked_reports: clusterSizes.get(r.id) ?? 0,
    source: r.source,
    kpis: { age_days: k.age_days, acknowledgement_sla: k.acknowledgement_sla, resolution_sla: k.resolution_sla, days_since_update: k.days_since_update, disputed_closure: k.disputed_closure, reopen_count: k.reopen_count },
  };
}
