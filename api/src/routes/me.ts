import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { mergeSettings } from '../domain';
import { clientIp, parse, requireAuth, wrap } from '../http';
import { hashPassword, passwordProblem, verifyPassword } from '../security/crypto';
import { addEvent } from '../services/events';
import { HttpError } from '../services/incidents';
import { getStorage } from '../services/storage';
import { audit } from '../services/support';

export function meRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  /** Personal invite link: neighbours who sign up through it are recorded as invited by this resident. */
  r.get(
    '/invite',
    wrap(async (req, res) => {
      let u = await req.db('users').where({ id: req.user!.id }).first();
      if (!u.invite_token) {
        const token = crypto.randomBytes(7).toString('base64url');
        await req.db('users').where({ id: u.id }).update({ invite_token: token });
        u = { ...u, invite_token: token };
      }
      const community = await req.db('communities').where({ id: u.community_id }).first();
      const st = mergeSettings(community.settings);
      const c = await req.db('users').where({ invited_by: u.id }).count({ c: '*' }).first();
      res.json({ url: `${config.appBaseUrl}/register?ref=${u.invite_token}`, invited: Number(c?.c ?? 0), auto_approved: st.require_approval ? st.trust_resident_invites : true, approval_required: st.require_approval });
    }),
  );

  r.patch(
    '/profile',
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          name: z.string().trim().min(2).max(80).optional(),
          tower: z.string().trim().min(1).max(40).optional(),
          unit: z.string().trim().min(1).max(20).optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          notify_email: z.boolean().optional(),
        }),
        req.body,
      );
      const patch: Record<string, unknown> = { ...body };
      if (body.notify_email !== undefined) patch.notify_email = body.notify_email ? 1 : 0;
      if (Object.keys(patch).length) await req.db('users').where({ id: req.user!.id }).update(patch);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/password',
    wrap(async (req, res) => {
      const body = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
      const u = await req.db('users').where({ id: req.user!.id }).first();
      if (!(await verifyPassword(body.current, u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
      const problem = passwordProblem(body.next, u.email);
      if (problem) throw new HttpError(400, problem, 'weak_password');
      await req.db('users').where({ id: u.id }).update({ password_hash: await hashPassword(body.next), token_version: u.token_version + 1 });
      await audit(req.db, { actorId: u.id, action: 'password_changed', ip: clientIp(req) });
      res.clearCookie('np_session', { path: '/' });
      res.json({ ok: true, signed_out: true });
    }),
  );

  // PDPL: right of access / portability
  r.get(
    '/export',
    wrap(async (req, res) => {
      const id = req.user!.id;
      const u = await req.db('users').where({ id }).first();
      const incidents = await req.db('incidents').where({ reporter_id: id });
      const events = await req.db('incident_events').whereIn('incident_id', incidents.map((i) => i.id)).orderBy('created_at');
      const payload = {
        exported_at: new Date().toISOString(),
        profile: { name: u.name, email: u.email, phone: u.phone, tower: u.tower, unit: u.unit, consent_at: u.consent_at, consent_version: u.consent_version, created_at: u.created_at },
        reports: incidents,
        report_events: events.map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
        affects: await req.db('affects').where({ user_id: id }),
        photos: await req.db('uploads').where({ user_id: id }).select('id', 'incident_id', 'kind', 'created_at', 'bytes'),
        notifications: await req.db('notifications').where({ user_id: id }),
        tracked_emails: await req.db('inbound_emails').where({ from_user_id: id }).select('route', 'subject', 'snippet', 'received_at', 'event_at', 'event_at_source', 'status'),
        emails_to_you: await req.db('email_outbox').where({ to_addr: u.email }).select('kind', 'subject', 'status', 'created_at'),
      };
      await audit(req.db, { actorId: id, action: 'data_export', ip: clientIp(req) });
      res.setHeader('Content-Disposition', 'attachment; filename="my-neighbourhood-data.json"');
      res.json(payload);
    }),
  );

  // PDPL: erasure. Personal identifiers are removed; reports stay as an anonymous community record unless withdrawn.
  r.post(
    '/delete',
    wrap(async (req, res) => {
      const body = parse(z.object({ password: z.string().max(200), withdraw_reports: z.boolean().default(false) }), req.body);
      const u = await req.db('users').where({ id: req.user!.id }).first();
      if (!(await verifyPassword(body.password, u.password_hash))) throw new HttpError(400, 'Password is incorrect.');
      if (['admin', 'super_admin'].includes(u.role)) throw new HttpError(400, 'Ask another administrator to remove admin accounts.');
      const now = new Date().toISOString();
      await req.db.transaction(async (trx) => {
        if (body.withdraw_reports) {
          const mine = await trx('incidents').where({ reporter_id: u.id }).whereNot({ status: 'withdrawn' });
          for (const inc of mine) {
            await trx('incidents').where({ id: inc.id }).update({ status: 'withdrawn', updated_at: now, last_activity_at: now });
            await addEvent(trx, { incidentId: inc.id, type: 'withdrawn', actorId: u.id, actorRole: 'resident', payload: { reason: 'account_deleted' } });
          }
          const photos = await trx('uploads').where({ user_id: u.id }).whereNull('deleted_at');
          for (const p of photos) {
            await getStorage().delete(p.key);
            await getStorage().delete(p.thumb_key);
          }
          await trx('uploads').where({ user_id: u.id }).update({ deleted_at: now });
        }
        await trx('incidents').where({ reporter_id: u.id }).update({ unit: null });
        await trx('affects').where({ user_id: u.id }).update({ unit: null });
        await trx('notifications').where({ user_id: u.id }).delete();
        await trx('inbound_emails').where({ from_user_id: u.id }).update({ from_addr: null, snippet: null, subject: null, from_user_id: null });
        await trx('users').where({ id: u.id }).update({
          email: `deleted+${u.id}@invalid.local`,
          name: 'Deleted resident',
          phone: null,
          tower: null,
          unit: null,
          password_hash: await hashPassword(crypto.randomBytes(32).toString('hex')),
          active: 0,
          token_version: u.token_version + 1,
          mfa_secret_enc: null,
          mfa_enabled: 0,
          deleted_at: now,
        });
      });
      await audit(req.db, { actorId: u.id, action: 'account_deleted', ip: clientIp(req), detail: { withdraw_reports: body.withdraw_reports } });
      res.clearCookie('np_session', { path: '/' });
      res.json({ ok: true });
    }),
  );

  return r;
}

export function notificationsRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.get(
    '/',
    wrap(async (req, res) => {
      const items = await req.db('notifications').where({ user_id: req.user!.id }).orderBy('created_at', 'desc').limit(60);
      const unread = items.filter((n) => !n.read_at).length;
      res.json({ unread, items });
    }),
  );
  r.post(
    '/read',
    wrap(async (req, res) => {
      const body = parse(z.object({ ids: z.array(z.string()).max(100).optional() }), req.body ?? {});
      const q = req.db('notifications').where({ user_id: req.user!.id }).whereNull('read_at');
      if (body.ids?.length) q.whereIn('id', body.ids);
      await q.update({ read_at: new Date().toISOString() });
      res.json({ ok: true });
    }),
  );
  return r;
}
