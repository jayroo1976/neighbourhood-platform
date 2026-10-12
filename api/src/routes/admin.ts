import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { config } from '../config';
import { CATEGORIES, SEVERITIES, STATUSES, mergeSettings, type Category, type Severity, type Status } from '../domain';
import { communityKpis } from '../services/kpi';
import { clientIp, parse, requireAdmin, requireStaff, wrap } from '../http';
import { hashPassword, sha256 } from '../security/crypto';
import { addEvent, verifyChain } from '../services/events';
import {
  HttpError,
  addNote,
  changeStatus,
  createIncident,
  getIncidentRow,
  linkIncidents,
  queueMgmtEmail,
  setCaseNumber,
  unlinkIncident,
} from '../services/incidents';
import { queueEmail } from '../services/mailer';
import { adminListItem, affectsCounts, incidentDetail } from '../services/serializers';
import { getStorage } from '../services/storage';
import { publicVersion } from '../version';
import { audit } from '../services/support';
import { assignInbound, caseByRef } from '../services/inboundMail';

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

export function adminRouter(): Router {
  const r = Router();

  // ---------------- system: which build is running, and the update history ----------------
  r.get(
    '/system',
    requireStaff,
    wrap(async (req, res) => {
      const events = await req.db('system_events').orderBy('at', 'desc').limit(100);
      res.json({
        ...publicVersion(),
        watchtower_configured: Boolean(config.watchtowerSecret),
        watchtower_last: events.find((e: { kind: string }) => e.kind === 'watchtower')?.at ?? null,
        events,
      });
    }),
  );

  // ---------------- incidents ----------------
  r.get(
    '/insights',
    requireStaff,
    wrap(async (req, res) => {
      const q = parse(z.object({ days: z.coerce.number().int().min(1).max(3650).optional() }), req.query);
      const me = req.user!;
      const community = await req.db('communities').where({ id: me.community_id }).first();
      const settings = mergeSettings(community.settings);
      const now = Date.now();
      const from = q.days ? new Date(now - q.days * 86_400_000).toISOString() : undefined;
      const kpis = await communityKpis(req.db, me.community_id, settings, { from });
      const open = (await req.db('incidents').where({ community_id: me.community_id }).whereIn('status', ['reported', 'case_number_received', 'in_progress', 'reopened']).select()) as Record<string, any>[];
      const age = (iso: string) => Math.round(((now - Date.parse(iso)) / 86_400_000) * 10) / 10;
      const waiting = open
        .filter((x) => !x.case_number_at && !x.mgmt_first_reply_at)
        .map((x) => ({ id: x.id, ref: x.ref, title: x.title, tower: x.tower, hours: Math.round((now - Date.parse(x.emailed_at ?? x.reported_at)) / 3_600_000), emailed: !!x.emailed_at }))
        .sort((a, b) => b.hours - a.hours);
      const notEmailed = waiting.filter((x) => !x.emailed && x.hours >= 1);
      const longest = open
        .map((x) => ({ id: x.id, ref: x.ref, title: x.title, tower: x.tower, severity: x.severity, age_days: age(x.reported_at) }))
        .sort((a, b) => b.age_days - a.age_days)
        .slice(0, 5);
      const people = (await req.db('users').where({ community_id: me.community_id }).whereNull('deleted_at').select('role', 'approval_status', 'active')) as { role: string; approval_status: string; active: number }[];
      res.json({
        kpis,
        awaiting_reply: waiting.filter((x) => x.emailed).slice(0, 5),
        awaiting_reply_total: waiting.filter((x) => x.emailed).length,
        not_emailed: notEmailed.slice(0, 5),
        not_emailed_total: notEmailed.length,
        longest_open: longest,
        people: {
          residents: people.filter((u) => u.role === 'resident' && u.approval_status === 'approved' && u.active).length,
          pending: people.filter((u) => u.approval_status === 'pending').length,
          staff: people.filter((u) => u.role !== 'resident' && u.active).length,
        },
      });
    }),
  );

  r.get(
    '/incidents',
    requireStaff,
    wrap(async (req, res) => {
      const q = parse(
        z.object({
          status: z.string().max(200).optional(), // comma separated
          category: z.enum(CATEGORIES).optional(),
          tower: z.string().max(40).optional(),
          q: z.string().max(100).optional(),
          flag: z.enum(['ack_breached', 'overdue', 'disputed', 'awaiting_verification', 'unlinked_dupes']).optional(),
          source: z.enum(['app', 'import', 'demo']).optional(),
          page: z.coerce.number().int().min(0).max(500).default(0),
        }),
        req.query,
      );
      const me = req.user!;
      const community = await req.db('communities').where({ id: me.community_id }).first();
      const settings = mergeSettings(community.settings);
      const qb = req.db('incidents').where({ community_id: me.community_id });
      if (q.status) qb.whereIn('status', q.status.split(',').filter((s) => (STATUSES as readonly string[]).includes(s)));
      else qb.whereNot({ status: 'withdrawn' });
      if (q.category) qb.where({ category: q.category });
      if (q.tower) qb.where({ tower: q.tower });
      if (q.source) qb.where({ source: q.source });
      if (q.q) qb.where((b) => b.whereILike('title', `%${q.q}%`).orWhereILike('description', `%${q.q}%`).orWhereILike('ref', `%${q.q}%`).orWhereILike('mgmt_case_number', `%${q.q}%`));
      qb.orderBy('reported_at', 'desc');
      // Flags are computed from KPI rules, so filter after load (pilot-scale data).
      let rows = await qb.limit(2000);
      const counts = await affectsCounts(req.db, rows.map((x) => x.id));
      const clusterRows = (await req.db('incidents').whereNotNull('cluster_id').groupBy('cluster_id').select('cluster_id').count({ c: '*' })) as unknown as { cluster_id: string; c: number | string }[];
      const clusterSizes = new Map<string, number>(clusterRows.map((c: { cluster_id: string; c: number | string }) => [c.cluster_id, Number(c.c)]));
      let items = rows.map((x) => adminListItem(x, counts, clusterSizes, settings));
      if (q.flag === 'ack_breached') items = items.filter((i) => i.kpis.acknowledgement_sla === 'breached');
      if (q.flag === 'overdue') items = items.filter((i) => i.kpis.resolution_sla === 'breached' && !['resolved_ok', 'resolved_poor', 'withdrawn'].includes(i.status));
      if (q.flag === 'disputed') items = items.filter((i) => i.kpis.disputed_closure);
      if (q.flag === 'awaiting_verification') items = items.filter((i) => i.status === 'mgmt_closed');
      if (q.flag === 'unlinked_dupes') items = items.filter((i) => !i.cluster_id && i.linked_reports === 0 && ['reported', 'case_number_received', 'in_progress', 'reopened'].includes(i.status));
      const total = items.length;
      items = items.slice(q.page * 100, q.page * 100 + 100);
      rows = [];
      res.json({ items, total, page: q.page });
    }),
  );

  r.get(
    '/incidents/:id',
    requireStaff,
    wrap(async (req, res) => {
      const row = await getIncidentRow(req.db, req.params.id);
      if (row.community_id !== req.user!.community_id) throw new HttpError(404, 'Not found');
      res.json(await incidentDetail(req.db, row, req.user!, { forAdmin: true }));
    }),
  );

  r.patch(
    '/incidents/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          title: z.string().trim().min(3).max(120).optional(),
          description: z.string().trim().max(2000).optional(),
          category: z.enum(CATEGORIES).optional(),
          severity: z.enum(SEVERITIES).optional(),
          visibility: z.enum(['community', 'private']).optional(),
        }),
        req.body,
      );
      const row = await getIncidentRow(req.db, req.params.id);
      if (row.community_id !== req.user!.community_id) throw new HttpError(404, 'Not found');
      const changed = Object.entries(body).filter(([k, v]) => v !== undefined && (row as Record<string, unknown>)[k] !== v);
      if (!changed.length) return res.json({ ok: true });
      const now = new Date().toISOString();
      await req.db.transaction(async (trx) => {
        await trx('incidents').where({ id: row.id }).update({ ...Object.fromEntries(changed), updated_at: now, last_activity_at: now });
        await addEvent(trx, {
          incidentId: row.id,
          type: 'edited',
          actorId: req.user!.id,
          actorRole: req.user!.role,
          payload: { fields: Object.fromEntries(changed.map(([k, v]) => [k, { from: (row as Record<string, unknown>)[k], to: v }])) },
        });
      });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'incident_edit', targetType: 'incident', targetId: row.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/:id/case-number',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(z.object({ case_number: z.string().max(60) }), req.body);
      await setCaseNumber(req.db, req.user!, req.params.id, body.case_number);
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'case_number_set', targetType: 'incident', targetId: req.params.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/:id/status',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          to: z.enum(['in_progress', 'mgmt_closed', 'resolved_ok', 'resolved_poor', 'reopened', 'withdrawn']),
          note: z.string().max(1000).optional(),
          upload_id: z.string().uuid().nullish(),
        }),
        req.body,
      );
      await changeStatus(req.db, req.user!, req.params.id, body.to, { note: body.note, uploadId: body.upload_id });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'status_set', targetType: 'incident', targetId: req.params.id, ip: clientIp(req), detail: { to: body.to } });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/:id/note',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(z.object({ text: z.string().min(1).max(1500), internal: z.boolean().default(true) }), req.body);
      await addNote(req.db, req.user!, req.params.id, body.text, body.internal);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/:id/resend-email',
    requireAdmin,
    wrap(async (req, res) => {
      const row = await getIncidentRow(req.db, req.params.id);
      if (row.community_id !== req.user!.community_id) throw new HttpError(404, 'Not found');
      await queueMgmtEmail(req.db, row.id, 'resend', req.user!);
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'email_resend', targetType: 'incident', targetId: row.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/link',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(z.object({ primary_id: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(50) }), req.body);
      await linkIncidents(req.db, req.user!, body.primary_id, body.ids);
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'incident_link', targetType: 'incident', targetId: body.primary_id, ip: clientIp(req), detail: { count: body.ids.length } });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/incidents/:id/unlink',
    requireAdmin,
    wrap(async (req, res) => {
      await unlinkIncident(req.db, req.user!, req.params.id);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/incidents/:id/verify-chain',
    requireStaff,
    wrap(async (req, res) => {
      res.json(await verifyChain(req.db, req.params.id));
    }),
  );

  // ---------------- settings ----------------
  r.get(
    '/settings',
    requireStaff,
    wrap(async (req, res) => {
      const c = await req.db('communities').where({ id: req.user!.community_id }).first();
      res.json({ community: { name: c.name, mgmt_email: c.mgmt_email, towers: JSON.parse(c.towers) }, settings: mergeSettings(c.settings), ai_available: config.ai.enabled });
    }),
  );

  r.patch(
    '/settings',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          name: z.string().trim().min(2).max(80).optional(),
          mgmt_email: z.string().email().max(200).optional(),
          towers: z.array(z.string().trim().min(1).max(40)).max(100).optional(),
          settings: z
            .object({
              require_photo_for_affects: z.boolean(),
              affects_max_per_day: z.number().int().min(1).max(100),
              reports_max_per_day: z.number().int().min(1).max(100),
              case_reminder_hours: z.number().int().min(1).max(720),
              verify_reminder_days: z.number().int().min(1).max(60),
              sla_case_hours: z.number().int().min(1).max(720),
              sla_resolve_days: z.object({ urgent: z.number().min(0.5).max(365), high: z.number().min(0.5).max(365), normal: z.number().min(0.5).max(365), low: z.number().min(0.5).max(365) }).partial(),
              cc_reporter: z.boolean(),
              ai_suggest_enabled: z.boolean(),
              registration_open: z.boolean(),
              email_mode: z.enum(['resident', 'platform']),
              require_approval: z.boolean(),
              trust_resident_invites: z.boolean(),
              community_code: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9]{2,5}$/.test(v), 'Use 2 to 5 letters or digits').transform((v) => v.toUpperCase()),
              tracking_mailbox: z.string().trim().max(200).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter an email address'),
              cc_tracking_mailbox: z.boolean(),
              management_domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter domains like example.com')).max(20),
              management_entity_short: z.string().trim().min(2).max(60),
              include_other_reports_line: z.boolean(),
              include_closure_details_line: z.boolean(),
              whatsapp_group_url: z.string().trim().max(200).refine((v) => v === '' || /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(v), 'Use a WhatsApp group invite link starting https://chat.whatsapp.com/'),
            })
            .partial()
            .optional(),
        }),
        req.body,
      );
      const c = await req.db('communities').where({ id: req.user!.community_id }).first();
      const merged = mergeSettings({ ...JSON.parse(c.settings), ...body.settings, sla_resolve_days: { ...mergeSettings(c.settings).sla_resolve_days, ...(body.settings?.sla_resolve_days ?? {}) } });
      await req.db('communities').where({ id: c.id }).update({
        settings: JSON.stringify(merged),
        ...(body.name ? { name: body.name } : {}),
        ...(body.mgmt_email ? { mgmt_email: body.mgmt_email } : {}),
        ...(body.towers ? { towers: JSON.stringify(body.towers) } : {}),
      });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'settings_update', ip: clientIp(req), detail: { keys: Object.keys(body.settings ?? {}), mgmt_email_changed: !!body.mgmt_email } });
      res.json({ ok: true, settings: merged });
    }),
  );

  // ---------------- users ----------------
  r.get(
    '/users',
    requireAdmin,
    wrap(async (req, res) => {
      const users = await req.db('users').where({ community_id: req.user!.community_id }).orderBy('created_at', 'desc').limit(1000);
      const counts = (await req.db('incidents').groupBy('reporter_id').select('reporter_id').count({ c: '*' })) as unknown as { reporter_id: string; c: number | string }[];
      const cm = new Map(counts.map((c: { reporter_id: string; c: number | string }) => [c.reporter_id, Number(c.c)]));
      const byId = new Map(users.map((u) => [u.id, `${u.name}${u.tower ? ` (${u.tower})` : ''}`]));
      res.json({
        items: users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          tower: u.tower,
          unit: u.unit,
          active: !!u.active,
          mfa_enabled: !!u.mfa_enabled,
          reports: cm.get(u.id) ?? 0,
          created_at: u.created_at,
          last_login_at: u.last_login_at,
          deleted: !!u.deleted_at,
          approval_status: u.approval_status ?? 'approved',
          invited_by: u.invited_by ? (byId.get(u.invited_by) ?? null) : null,
        })),
      });
    }),
  );

  r.get(
    '/users/pending-count',
    requireAdmin,
    wrap(async (req, res) => {
      const c = await req.db('users').where({ community_id: req.user!.community_id, approval_status: 'pending' }).whereNull('deleted_at').count({ c: '*' }).first();
      res.json({ count: Number(c?.c ?? 0) });
    }),
  );

  r.post(
    '/users',
    requireAdmin,
    wrap(async (req, res) => {
      const me = req.user!;
      const body = parse(
        z.object({
          name: z.string().trim().min(2).max(80),
          email: z.string().trim().toLowerCase().email().max(200),
          tower: z.string().trim().max(40).optional(),
          unit: z.string().trim().max(20).optional(),
          role: z.enum(['resident', 'committee', 'admin', 'super_admin']).default('resident'),
        }),
        req.body,
      );
      if ((body.role === 'admin' || body.role === 'super_admin') && me.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can add an admin.');
      if (await req.db('users').where({ email: body.email }).first()) throw new HttpError(409, 'An account with this email already exists.');
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await req.db('users').insert({
        id,
        community_id: me.community_id,
        email: body.email,
        password_hash: await hashPassword(crypto.randomBytes(24).toString('base64url') + 'Aa1!'), // unusable until they set their own
        name: body.name,
        tower: body.tower || null,
        unit: body.unit || null,
        role: body.role,
        approval_status: 'approved',
        created_at: now,
      });
      const token = crypto.randomBytes(32).toString('base64url');
      await req.db('password_resets').insert({ id: crypto.randomUUID(), user_id: id, token_hash: sha256(token), expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
      const setup_link = `${config.appBaseUrl}/reset?token=${token}`;
      await queueEmail(req.db, { kind: 'user_invite', communityId: me.community_id, to: body.email, subject: 'You have been added to Neighbourhood Reports', text: `Hello ${body.name},\n\nYou have been added to your community's reporting platform. Set your password within 7 days using this link:\n${setup_link}\n\nThen sign in at ${config.appBaseUrl}` });
      await audit(req.db, { actorId: me.id, actorRole: me.role, action: 'user_create', targetType: 'user', targetId: id, ip: clientIp(req), detail: { role: body.role } });
      res.status(201).json({ ok: true, id, setup_link });
    }),
  );

  r.post(
    '/users/:id/approve',
    requireAdmin,
    wrap(async (req, res) => {
      const me = req.user!;
      const u = await req.db('users').where({ id: req.params.id, community_id: me.community_id, approval_status: 'pending' }).whereNull('deleted_at').first();
      if (!u) throw new HttpError(404, 'No pending request found.');
      await req.db('users').where({ id: u.id }).update({ approval_status: 'approved' });
      await queueEmail(req.db, { kind: 'signup_approved', communityId: me.community_id, to: u.email, subject: 'Your request to join was approved', text: `Hello ${u.name},\n\nYour request to join was approved. You can sign in now:\n${config.appBaseUrl}/login` });
      await audit(req.db, { actorId: me.id, actorRole: me.role, action: 'user_approve', targetType: 'user', targetId: u.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/users/:id/decline',
    requireAdmin,
    wrap(async (req, res) => {
      const me = req.user!;
      const u = await req.db('users').where({ id: req.params.id, community_id: me.community_id, approval_status: 'pending' }).whereNull('deleted_at').first();
      if (!u) throw new HttpError(404, 'No pending request found.');
      await req.db('users').where({ id: u.id }).update({ approval_status: 'rejected', active: 0 });
      await queueEmail(req.db, { kind: 'signup_declined', communityId: me.community_id, to: u.email, subject: 'Your request to join', text: `Hello ${u.name},\n\nWe could not approve your request to join at this time. If you think this is a mistake, please contact your community moderators.` });
      await audit(req.db, { actorId: me.id, actorRole: me.role, action: 'user_decline', targetType: 'user', targetId: u.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.patch(
    '/users/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(z.object({ role: z.enum(['resident', 'committee', 'admin', 'super_admin']).optional(), active: z.boolean().optional() }), req.body);
      const me = req.user!;
      const u = await req.db('users').where({ id: req.params.id, community_id: me.community_id }).first();
      if (!u || u.deleted_at) throw new HttpError(404, 'User not found');
      if (u.id === me.id) throw new HttpError(400, 'You cannot change your own role or status.');
      const privileged = (r: string) => r === 'admin' || r === 'super_admin';
      if ((body.role && privileged(body.role)) || privileged(u.role)) {
        if (me.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can grant or change admin access.');
      }
      const patch: Record<string, unknown> = {};
      if (body.role) patch.role = body.role;
      if (body.active !== undefined) patch.active = body.active ? 1 : 0;
      if (Object.keys(patch).length) {
        patch.token_version = u.token_version + 1; // force re-login so role changes apply immediately
        await req.db('users').where({ id: u.id }).update(patch);
        await audit(req.db, { actorId: me.id, actorRole: me.role, action: 'user_update', targetType: 'user', targetId: u.id, ip: clientIp(req), detail: body });
      }
      res.json({ ok: true });
    }),
  );

  r.post(
    '/users/:id/reset-password',
    requireAdmin,
    wrap(async (req, res) => {
      const u = await req.db('users').where({ id: req.params.id, community_id: req.user!.community_id, active: 1 }).whereNull('deleted_at').first();
      if (!u) throw new HttpError(404, 'User not found');
      const token = crypto.randomBytes(32).toString('base64url');
      await req.db('password_resets').insert({ id: crypto.randomUUID(), user_id: u.id, token_hash: sha256(token), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      await queueEmail(req.db, { kind: 'password_reset', communityId: u.community_id, to: u.email, subject: 'Reset your Neighbourhood Reports password', text: `A moderator started a password reset for you. Use this link within one hour:\n${config.appBaseUrl}/reset?token=${token}` });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'user_reset_password', targetType: 'user', targetId: u.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/users/:id/reset-mfa',
    requireAdmin,
    wrap(async (req, res) => {
      if (req.user!.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can reset two-factor authentication.');
      const u = await req.db('users').where({ id: req.params.id, community_id: req.user!.community_id }).first();
      if (!u) throw new HttpError(404, 'User not found');
      await req.db('users').where({ id: u.id }).update({ mfa_enabled: 0, mfa_secret_enc: null, recovery_hashes: '[]', token_version: u.token_version + 1 });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'user_reset_mfa', targetType: 'user', targetId: u.id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  // ---------------- import / export ----------------
  r.post(
    '/import',
    requireAdmin,
    csvUpload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'Attach a CSV file.');
      const dry = req.body?.dry_run === 'true' || req.body?.dry_run === true;
      let records: Record<string, string>[];
      try {
        records = parseCsv(req.file.buffer, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')), bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
      } catch (e) {
        throw new HttpError(400, `Could not read the CSV: ${(e as Error).message}`);
      }
      if (records.length > 2000) throw new HttpError(400, 'Import at most 2,000 rows at a time.');
      const errors: { row: number; error: string }[] = [];
      let imported = 0;
      for (const [i, rec] of records.entries()) {
        try {
          const row = parseImportRow(rec);
          if (dry) {
            imported++;
            continue;
          }
          const reporter = rec.reporter_email ? await req.db('users').where({ email: rec.reporter_email.toLowerCase() }).first('id') : null;
          const inc = await createIncident(
            req.db,
            req.user!,
            { title: row.title, description: row.description, category: row.category, severity: row.severity, location_text: row.location, visibility: 'community', upload_ids: [], tower: row.tower, unit: row.unit },
            { at: row.reported_at, source: 'import', skipEmail: true, reporterId: reporter?.id ?? null },
          );
          const patch: Record<string, unknown> = { status: row.status, last_activity_at: row.last_activity_at };
          if (row.emailed_at) patch.emailed_at = row.emailed_at;
          if (row.case_number) {
            patch.mgmt_case_number = row.case_number;
            patch.case_number_at = row.case_number_at;
          }
          if (row.status === 'mgmt_closed') {
            patch.mgmt_closed_at = row.last_activity_at;
            patch.mgmt_closed_count = 1;
          }
          if (row.status === 'resolved_ok' || row.status === 'resolved_poor') {
            patch.resolved_at = row.resolved_at;
            patch.resolution = row.status === 'resolved_ok' ? 'ok' : 'poor';
          }
          if (row.status === 'reopened') patch.reopen_count = 1;
          await req.db('incidents').where({ id: inc.id }).update(patch);
          imported++;
        } catch (e) {
          errors.push({ row: i + 2, error: e instanceof Error ? e.message : 'Invalid row' });
        }
      }
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: dry ? 'import_dry_run' : 'import', ip: clientIp(req), detail: { imported, errors: errors.length } });
      res.json({ dry_run: dry, rows: records.length, imported, errors: errors.slice(0, 50) });
    }),
  );

  r.get(
    '/export.csv',
    requireAdmin,
    wrap(async (req, res) => {
      const rows = await req.db('incidents').where({ community_id: req.user!.community_id }).orderBy('seq');
      const counts = await affectsCounts(req.db, rows.map((x) => x.id));
      const head = ['ref', 'reported_at', 'category', 'severity', 'status', 'tower', 'unit', 'title', 'mgmt_case_number', 'emailed_at', 'case_number_at', 'mgmt_closed_at', 'resolved_at', 'resolution', 'reopen_count', 'management_closures', 'affects', 'linked_to', 'source'];
      const cell = (v: unknown) => {
        let s = v == null ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
        return `"${s.replace(/"/g, '""')}"`;
      };
      const byId = new Map(rows.map((x) => [x.id, x.ref]));
      const lines = [head.join(',')];
      for (const x of rows) {
        lines.push([x.ref, x.reported_at, x.category, x.severity, x.status, x.tower, x.unit, x.title, x.mgmt_case_number, x.emailed_at, x.case_number_at, x.mgmt_closed_at, x.resolved_at, x.resolution, x.reopen_count, x.mgmt_closed_count, counts.get(x.id) ?? 0, x.cluster_id ? byId.get(x.cluster_id) : '', x.source].map(cell).join(','));
      }
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'export_csv', ip: clientIp(req) });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="incidents.csv"');
      res.send(lines.join('\n'));
    }),
  );

  // ---------------- tracking mailbox: emails that need a person to match them ----------------
  r.get(
    '/inbound',
    requireAdmin,
    wrap(async (req, res) => {
      const status = req.query.status === 'all' ? null : 'review';
      const rows = await req
        .db('inbound_emails')
        .where({ community_id: req.user!.community_id })
        .modify((q) => {
          if (status) q.where({ status });
        })
        .orderBy('received_at', 'desc')
        .limit(200);
      res.json({
        items: rows.map((x: any) => ({
          id: x.id,
          status: x.status,
          route: x.route,
          from: x.from_addr,
          subject: x.subject,
          snippet: x.snippet,
          reason: x.review_reason,
          candidate_refs: x.candidate_refs ? JSON.parse(x.candidate_refs) : [],
          auth_result: x.auth_result,
          received_at: x.received_at,
          event_at: x.event_at,
          event_at_source: x.event_at_source,
          event_at_offset: x.event_at_offset,
          skew: !!x.skew_flag,
          incident_id: x.incident_id,
        })),
      });
    }),
  );

  r.post(
    '/inbound/:id/assign',
    requireAdmin,
    wrap(async (req, res) => {
      const body = parse(z.object({ incident_id: z.string().min(10).max(60).optional(), reference: z.string().trim().max(40).optional() }), req.body);
      let incidentId = body.incident_id;
      if (!incidentId && body.reference) {
        const hit = await caseByRef(req.db, req.user!.community_id, body.reference.toUpperCase());
        if (!hit) throw new HttpError(404, 'No report found with that reference.');
        incidentId = hit.incident.id as string;
      }
      if (!incidentId) throw new HttpError(400, 'Give a reference or a report.');
      await assignInbound(req.db, req.user!, req.params.id, incidentId);
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'inbound_assign', ip: clientIp(req), detail: { inbound: req.params.id, incident: incidentId } });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/inbound/:id/dismiss',
    requireAdmin,
    wrap(async (req, res) => {
      const n = await req.db('inbound_emails').where({ id: req.params.id, community_id: req.user!.community_id, status: 'review' }).update({ status: 'dismissed' });
      if (!n) throw new HttpError(404, 'Email not found in the review list');
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'inbound_dismiss', ip: clientIp(req), detail: { inbound: req.params.id } });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/audit',
    requireAdmin,
    wrap(async (req, res) => {
      const items = await req.db('audit_log').orderBy('at', 'desc').limit(200);
      res.json({ items: items.map((a) => ({ ...a, detail: JSON.parse(a.detail) })) });
    }),
  );

  r.post(
    '/demo/wipe',
    requireAdmin,
    wrap(async (req, res) => {
      if (req.user!.role !== 'super_admin') throw new HttpError(403, 'Only a super admin can remove demo data.');
      const ids = (await req.db('incidents').where({ source: 'demo' }).select('id')).map((x) => x.id);
      const uploads = ids.length ? await req.db('uploads').whereIn('incident_id', ids) : [];
      for (const u of uploads) {
        await getStorage().delete(u.key);
        await getStorage().delete(u.thumb_key);
      }
      await req.db.transaction(async (trx) => {
        if (ids.length) {
          await trx('uploads').whereIn('incident_id', ids).delete();
          await trx('affects').whereIn('incident_id', ids).delete();
          await trx('notifications').whereIn('incident_id', ids).delete();
          await trx('email_outbox').whereIn('incident_id', ids).delete();
          await trx('incident_events').whereIn('incident_id', ids).delete();
          await trx('incidents').whereIn('id', ids).delete();
        }
        const demoUsers = (await trx('users').where({ is_demo: 1 }).select('id')).map((x) => x.id);
        if (demoUsers.length) {
          await trx('notifications').whereIn('user_id', demoUsers).delete();
          await trx('uploads').whereIn('user_id', demoUsers).delete();
          await trx('affects').whereIn('user_id', demoUsers).delete();
          await trx('password_resets').whereIn('user_id', demoUsers).delete();
          await trx('users').whereIn('id', demoUsers).delete();
        }
      });
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'demo_wipe', ip: clientIp(req), detail: { incidents: ids.length } });
      res.json({ ok: true, removed_incidents: ids.length });
    }),
  );

  return r;
}

// ---------------- CSV import parsing ----------------

function parseDate(v: string | undefined, fallback?: string): string {
  if (!v) {
    if (fallback) return fallback;
    throw new Error('Missing date');
  }
  const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(v.trim());
  if (dm) {
    const [, d, m, y, hh = '0', mm = '0'] = dm;
    // Spreadsheet dates are day-first and Dubai local time (UTC+4)
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 4, Number(mm))).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Unreadable date "${v}"`);
  return new Date(t).toISOString();
}

const STATUS_ALIASES: Record<string, Status> = {
  open: 'reported',
  new: 'reported',
  reported: 'reported',
  'in progress': 'in_progress',
  in_progress: 'in_progress',
  'case number received': 'case_number_received',
  case_number_received: 'case_number_received',
  closed: 'mgmt_closed',
  'closed by management': 'mgmt_closed',
  mgmt_closed: 'mgmt_closed',
  resolved: 'resolved_ok',
  fixed: 'resolved_ok',
  resolved_ok: 'resolved_ok',
  'poorly resolved': 'resolved_poor',
  resolved_poor: 'resolved_poor',
  reopened: 'reopened',
};

function parseImportRow(rec: Record<string, string>) {
  const title = (rec.title ?? '').trim();
  if (title.length < 3) throw new Error('Title is required');
  const category = (rec.category ?? 'other').trim().toLowerCase().replace(/[\s/]+/g, '_') as Category;
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new Error(`Unknown category "${rec.category}". Use one of: ${CATEGORIES.join(', ')}`);
  const severity = ((rec.severity ?? 'normal').trim().toLowerCase() || 'normal') as Severity;
  if (!(SEVERITIES as readonly string[]).includes(severity)) throw new Error(`Unknown severity "${rec.severity}"`);
  const statusRaw = (rec.status ?? 'reported').trim().toLowerCase();
  const status = STATUS_ALIASES[statusRaw];
  if (!status) throw new Error(`Unknown status "${rec.status}"`);
  const reported_at = parseDate(rec.reported_at);
  const emailed_at = rec.emailed_at ? parseDate(rec.emailed_at) : reported_at;
  const case_number = rec.case_number?.trim() || '';
  const resolved_at = status === 'resolved_ok' || status === 'resolved_poor' ? parseDate(rec.resolved_at, new Date().toISOString()) : null;
  return {
    title: title.slice(0, 120),
    description: (rec.description ?? '').slice(0, 2000),
    category,
    severity,
    tower: rec.tower?.trim() || null,
    unit: rec.unit?.trim() || null,
    location: rec.location?.trim() || null,
    status,
    reported_at,
    emailed_at,
    case_number: case_number || null,
    case_number_at: rec.case_number_at ? parseDate(rec.case_number_at) : emailed_at,
    resolved_at,
    last_activity_at: resolved_at ?? (rec.updated_at ? parseDate(rec.updated_at) : reported_at),
  };
}
