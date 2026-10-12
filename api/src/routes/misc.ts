import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { mergeSettings } from '../domain';
import { parse, requireAuth, wrap } from '../http';
import { verifyFileLink } from '../security/crypto';
import { HttpError, recordMgmtReply } from '../services/incidents';
import { ingestTrackedEmail, inputFromRaw, type InboundInput } from '../services/inboundMail';
import { KPI_DEFINITIONS, communityKpis } from '../services/kpi';
import { getStorage } from '../services/storage';
import { addSystemEvent, summariseWatchtower } from '../services/system';

/** Photos are served through short-lived HMAC-signed links (the same links go to management by email). */
export function filesRouter(): Router {
  const r = Router();
  r.get(
    '/*',
    wrap(async (req, res) => {
      const key = decodeURIComponent((req.params as Record<string, string>)[0]);
      if (!verifyFileLink(key, Number(req.query.exp), String(req.query.sig ?? ''))) {
        throw new HttpError(403, 'This photo link has expired or is not valid.');
      }
      const file = await getStorage().get(key);
      if (!file) throw new HttpError(404, 'Photo not found.');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.setHeader('Content-Disposition', 'inline');
      res.send(file.data);
    }),
  );
  return r;
}

export function kpiRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/summary',
    wrap(async (req, res) => {
      const q = parse(z.object({ days: z.coerce.number().int().min(1).max(3650).optional() }), req.query);
      const community = await req.db('communities').where({ id: req.user!.community_id }).first();
      const from = q.days ? new Date(Date.now() - q.days * 86_400_000).toISOString() : undefined;
      const kpis = await communityKpis(req.db, community.id, mergeSettings(community.settings), { from });
      res.json({ ...kpis, community: community.name, definitions: KPI_DEFINITIONS });
    }),
  );
  return r;
}

/**
 * Webhook for management replies. A mailbox rule (e.g. Power Automate on a shared M365 mailbox, or an
 * inbound-email provider) forwards replies sent to inc+<token>@REPLY_DOMAIN here with a shared secret.
 */
export function inboundRouter(): Router {
  const r = Router();
  /**
   * Watchtower (the auto-updater) posts a notice here whenever it checks, pulls or restarts the app, so
   * the update history can be read on Admin > System without needing access to Docker.
   */
  r.post(
    '/watchtower',
    express.text({ type: '*/*', limit: '100kb' }),
    wrap(async (req, res) => {
      const got = Buffer.from(req.get('x-watchtower-secret') ?? '');
      const want = Buffer.from(config.watchtowerSecret);
      if (!config.watchtowerSecret || got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'Unauthorized');
      let body: unknown = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          /* plain text is fine */
        }
      }
      const s = summariseWatchtower(body);
      await addSystemEvent(req.db, { kind: 'watchtower', title: s.title, message: s.message });
      res.json({ ok: true });
    }),
  );
  /**
   * Tracking mailbox feed. Accepts either the raw message (Content-Type: message/rfc822, headers included, so the
   * email's own dates and authentication results are used) or JSON with the fields below.
   */
  r.post(
    '/tracking',
    express.text({ type: ['message/rfc822', 'text/plain'], limit: '8mb' }),
    wrap(async (req, res) => {
      const secret = req.get('x-inbound-secret') ?? '';
      const a = Buffer.from(secret);
      const b = Buffer.from(config.email.inboundSecret);
      if (!config.email.inboundSecret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
      let input: InboundInput;
      if (typeof req.body === 'string') {
        input = inputFromRaw(req.body);
      } else {
        const body = parse(
          z.object({
            raw: z.string().max(8_000_000).optional(),
            from: z.string().max(300).optional(),
            subject: z.string().max(300).optional(),
            date: z.string().max(100).optional(),
            message_id: z.string().max(400).optional(),
            in_reply_to: z.string().max(1000).optional(),
            references: z.string().max(4000).optional(),
            text: z.string().max(100_000).optional(),
            declared_at: z.string().max(100).optional(),
            auth: z.object({ spf: z.string().max(20).optional(), dkim: z.string().max(20).optional(), dmarc: z.string().max(20).optional() }).optional(),
            original: z.object({ date: z.string().max(100).optional(), from: z.string().max(300).optional(), subject: z.string().max(300).optional(), text: z.string().max(100_000).optional(), message_id: z.string().max(400).optional() }).optional(),
          }),
          req.body,
        );
        input = body.raw ? inputFromRaw(body.raw) : { ...body, text: body.text ?? '' };
        if (body.declared_at) input.declared_at = body.declared_at;
      }
      const community = await req.db('communities').orderBy('created_at').first('id');
      if (!community) throw new HttpError(404, 'No community');
      const result = await ingestTrackedEmail(req.db, community.id, input);
      res.json({ ok: true, ...result });
    }),
  );
  r.post(
    '/email',
    wrap(async (req, res) => {
      const secret = req.get('x-inbound-secret') ?? '';
      const a = Buffer.from(secret);
      const b = Buffer.from(config.email.inboundSecret);
      if (!config.email.inboundSecret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
      const body = parse(
        z.object({ to: z.string().max(300), from: z.string().max(300).optional(), subject: z.string().max(300).optional(), text: z.string().max(50_000) }),
        req.body,
      );
      const m = /inc\+([a-f0-9]{16})@/i.exec(body.to);
      if (!m) throw new HttpError(400, 'No incident token in recipient address');
      const result = await recordMgmtReply(req.db, m[1], { from: body.from, subject: body.subject, text: body.text });
      res.json({ ok: true, ...result });
    }),
  );
  return r;
}
