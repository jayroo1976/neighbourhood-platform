import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CATEGORIES, SEVERITIES, mergeSettings, type Category } from '../domain';
import { parse, requireAuth, wrap } from '../http';
import { suggestFromPhoto, heuristicSuggestion } from '../services/ai';
import { config } from '../config';
import { MAX_UPLOAD_BYTES, processImage, resizeForAi } from '../services/images';
import {
  HttpError,
  addAffect,
  addNote,
  changeStatus,
  createIncident,
  getIncidentRow,
  setCaseNumber,
  setMyCaseNumber,
  residentEmailDraft,
  composeFollowUp,
  setClosureDetails,
  confirmResidentEmail,
} from '../services/incidents';
import { shareUrl, signedPath } from '../services/fileLinks';
import { affectsCounts, incidentDetail, listItems } from '../services/serializers';
import { findSimilar } from '../services/similar';
import { getStorage } from '../services/storage';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).default(''),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES).default('normal'),
  location_text: z.string().trim().max(200).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  gps_accuracy: z.number().min(0).max(100000).nullish(),
  device_reported_at: z.string().datetime().nullish(),
  visibility: z.enum(['community', 'private']).default('community'),
  upload_ids: z.array(z.string().uuid()).min(1, 'Add at least one photo.').max(4),
});

export function uploadsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'No photo received.');
      const kind = z.enum(['report', 'resolution', 'affects']).catch('report').parse(req.body?.kind);
      let img;
      try {
        img = await processImage(req.file.buffer);
      } catch {
        throw new HttpError(400, 'That file is not a supported image. Please use a JPEG or PNG photo.', 'bad_image');
      }
      const recent = await req.db('uploads').where({ user_id: req.user!.id }).andWhere('created_at', '>', new Date(Date.now() - 3_600_000).toISOString()).count({ c: '*' }).first();
      if (Number(recent?.c ?? 0) >= 40) throw new HttpError(429, 'Too many uploads this hour.');
      const id = crypto.randomUUID();
      const key = `${req.user!.community_id}/${id}.jpg`;
      const thumbKey = `${req.user!.community_id}/${id}_t.jpg`;
      await getStorage().put(key, img.full, 'image/jpeg');
      await getStorage().put(thumbKey, img.thumb, 'image/jpeg');
      await req.db('uploads').insert({
        id,
        user_id: req.user!.id,
        key,
        thumb_key: thumbKey,
        mime: 'image/jpeg',
        bytes: img.full.length,
        width: img.width,
        height: img.height,
        kind,
        created_at: new Date().toISOString(),
      });
      res.status(201).json({ id, thumb_url: signedPath(thumbKey, 3600), width: img.width, height: img.height });
    }),
  );
  return r;
}

export function aiRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.post(
    '/suggest',
    wrap(async (req, res) => {
      const body = parse(z.object({ upload_id: z.string().uuid().optional(), note: z.string().max(1000).default('') }), req.body);
      const community = await req.db('communities').where({ id: req.user!.community_id }).first();
      const allowed = config.ai.enabled && mergeSettings(community.settings).ai_suggest_enabled;
      if (!allowed || !body.upload_id) return res.json({ ...heuristicSuggestion(body.note), ai_used: false });
      const u = await req.db('uploads').where({ id: body.upload_id, user_id: req.user!.id }).whereNull('deleted_at').first();
      if (!u) throw new HttpError(404, 'Photo not found.');
      const file = await getStorage().get(u.key);
      if (!file) throw new HttpError(404, 'Photo not found.');
      const s = await suggestFromPhoto(await resizeForAi(file.data), body.note);
      res.json({ ...s, ai_used: s.source === 'ai' });
    }),
  );
  return r;
}

export function incidentsRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/',
    wrap(async (req, res) => {
      const q = parse(
        z.object({
          scope: z.enum(['community', 'mine']).default('community'),
          state: z.enum(['open', 'closed', 'all']).default('open'),
          tower: z.string().max(40).optional(),
          category: z.enum(CATEGORIES).optional(),
          q: z.string().max(100).optional(),
          sort: z.enum(['recent', 'affected', 'oldest']).default('recent'),
          page: z.coerce.number().int().min(0).max(200).default(0),
        }),
        req.query,
      );
      const me = req.user!;
      const qb = req.db('incidents').where({ community_id: me.community_id }).whereNot({ status: 'withdrawn' });
      if (q.scope === 'mine') {
        qb.where((b) => b.where({ reporter_id: me.id }).orWhereIn('id', req.db('affects').select('incident_id').where({ user_id: me.id })));
      } else {
        qb.where((b) => b.where({ visibility: 'community' }).orWhere({ reporter_id: me.id }));
      }
      if (q.state === 'open') qb.whereIn('status', ['reported', 'case_number_received', 'in_progress', 'reopened', 'mgmt_closed']);
      if (q.state === 'closed') qb.whereIn('status', ['resolved_ok', 'resolved_poor']);
      if (q.tower) qb.where({ tower: q.tower });
      if (q.category) qb.where({ category: q.category });
      if (q.q) qb.where((b) => b.whereILike('title', `%${q.q}%`).orWhereILike('description', `%${q.q}%`).orWhereILike('ref', `%${q.q}%`));
      if (q.sort === 'oldest') qb.orderBy('reported_at', 'asc');
      else qb.orderBy('last_activity_at', 'desc');
      let rows = await qb.limit(31).offset(q.page * 30);
      const hasMore = rows.length > 30;
      rows = rows.slice(0, 30);
      let items = await listItems(req.db, rows, me);
      if (q.sort === 'affected') items = items.sort((a, b) => b.affects_count - a.affects_count);
      res.json({ items, has_more: hasMore });
    }),
  );

  r.get(
    '/attention',
    wrap(async (req, res) => {
      // Reports where the user is expected to do something next
      const me = req.user!;
      const rows = await req
        .db('incidents')
        .where({ community_id: me.community_id })
        .where((b) => b.where({ reporter_id: me.id }).orWhereIn('id', req.db('affects').select('incident_id').where({ user_id: me.id })))
        .whereIn('status', ['reported', 'mgmt_closed'])
        .orderBy('reported_at', 'asc')
        .limit(10);
      const community = await req.db('communities').where({ id: me.community_id }).first();
      const s = mergeSettings(community.settings);
      const now = Date.now();
      res.json({
        items: rows
          .filter((r) => (r.status === 'mgmt_closed' ? true : r.emailed_at && now - Date.parse(r.emailed_at) > s.case_reminder_hours * 3_600_000))
          .map((r) => ({ id: r.id, ref: r.ref, title: r.title, action: r.status === 'mgmt_closed' ? 'verify' : 'case_number' })),
      });
    }),
  );

  r.get(
    '/similar',
    wrap(async (req, res) => {
      const q = parse(
        z.object({
          category: z.enum(CATEGORIES).optional(),
          tower: z.string().max(40).optional(),
          lat: z.coerce.number().optional(),
          lng: z.coerce.number().optional(),
          text: z.string().max(500).default(''),
        }),
        req.query,
      );
      const me = req.user!;
      const found = await findSimilar(req.db, { communityId: me.community_id, userId: me.id, tower: q.tower ?? me.tower, category: q.category, lat: q.lat, lng: q.lng, text: q.text });
      const counts = await affectsCounts(req.db, found.map((f) => f.id));
      res.json({ items: found.map((f) => ({ ...f, affects_count: counts.get(f.id) ?? 0 })) });
    }),
  );

  r.post(
    '/',
    wrap(async (req, res) => {
      const body = parse(createSchema, req.body);
      const inc = await createIncident(req.db, req.user!, { ...body, category: body.category as Category });
      const community = await req.db('communities').where({ id: req.user!.community_id }).first();
      res.status(201).json({ id: inc.id, ref: inc.ref, email_mode: mergeSettings(community.settings).email_mode, share_url: inc.visibility === 'community' ? shareUrl(inc.id) : null });
    }),
  );

  r.get(
    '/:id',
    wrap(async (req, res) => {
      const row = await getIncidentRow(req.db, req.params.id);
      const me = req.user!;
      const allowed = row.community_id === me.community_id && (row.visibility === 'community' || row.reporter_id === me.id);
      if (!allowed || row.status === 'withdrawn') throw new HttpError(404, 'Report not found.');
      res.json(await incidentDetail(req.db, row, me));
    }),
  );

  r.post(
    '/:id/affects',
    wrap(async (req, res) => {
      const body = parse(z.object({ upload_id: z.string().uuid().nullish(), case_number: z.string().max(60).nullish() }), req.body ?? {});
      await addAffect(req.db, req.user!, req.params.id, body.upload_id, { caseNumber: body.case_number });
      res.status(201).json({ ok: true });
    }),
  );

  r.get(
    '/:id/email-draft',
    wrap(async (req, res) => {
      res.json(await residentEmailDraft(req.db, req.user!, req.params.id));
    }),
  );

  r.get(
    '/:id/followup-draft',
    wrap(async (req, res) => {
      res.json(await composeFollowUp(req.db, req.user!, req.params.id));
    }),
  );

  r.post(
    '/:id/closure-details',
    wrap(async (req, res) => {
      const body = parse(z.object({ text: z.string().max(1500) }), req.body);
      await setClosureDetails(req.db, req.user!, req.params.id, body.text);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/email-sent',
    wrap(async (req, res) => {
      await confirmResidentEmail(req.db, req.user!, req.params.id);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/my-case-number',
    wrap(async (req, res) => {
      const body = parse(z.object({ case_number: z.string().max(60) }), req.body);
      await setMyCaseNumber(req.db, req.user!, req.params.id, body.case_number);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/case-number',
    wrap(async (req, res) => {
      const body = parse(z.object({ case_number: z.string().max(60) }), req.body);
      await setCaseNumber(req.db, req.user!, req.params.id, body.case_number);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/status',
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          to: z.enum(['mgmt_closed', 'resolved_ok', 'resolved_poor', 'reopened', 'withdrawn']),
          note: z.string().max(1000).optional(),
          upload_id: z.string().uuid().nullish(),
        }),
        req.body,
      );
      await changeStatus(req.db, req.user!, req.params.id, body.to, { note: body.note, uploadId: body.upload_id });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:id/note',
    wrap(async (req, res) => {
      const body = parse(z.object({ text: z.string().min(1).max(1500) }), req.body);
      await addNote(req.db, req.user!, req.params.id, body.text, false);
      res.json({ ok: true });
    }),
  );

  return r;
}
