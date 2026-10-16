import { Router } from 'express';
import { z } from 'zod';
import { MAX_TOWNHOUSE_UNIT, ODOUR_FREQUENCIES, ODOUR_TYPES, ODOUR_WHERE, PENTHOUSE_LEVEL } from '../domain';
import { clientIp, parse, requireAdmin, requireAuth, wrap } from '../http';
import { HttpError } from '../services/incidents';
import { adminOdourList, createOdourReport, deleteOdourReport, myOdourReports, odourCsv, odourItem, odourOptions, residentOdourSummary } from '../services/odour';
import { audit } from '../services/support';

const reportBody = z.object({
  building: z.string().trim().min(1).max(60),
  level: z.number().int().min(0).max(PENTHOUSE_LEVEL),
  flat: z.number().int().min(1).max(MAX_TOWNHOUSE_UNIT),
  smell_type: z.enum(ODOUR_TYPES),
  strength: z.number().int().min(1).max(4),
  frequency: z.enum(ODOUR_FREQUENCIES),
  where_noticed: z.enum(ODOUR_WHERE),
  observed_at: z.string().max(40).optional(),
  notes: z.string().max(280).optional(),
});

const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() });

/**
 * Smell reports for residents. A resident can log a smell against their own home and see their own reports.
 * Everyone else only gets counts per building and per group of levels (never a flat): see residentOdourSummary.
 */
export function odourRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/options',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await odourOptions(req.db, req.user!.community_id));
    }),
  );

  r.get(
    '/summary',
    wrap(async (req, res) => {
      const q = parse(daysQuery, req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json(await residentOdourSummary(req.db, req.user!, q.days));
    }),
  );

  r.get(
    '/mine',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: await myOdourReports(req.db, req.user!) });
    }),
  );

  r.post(
    '/',
    wrap(async (req, res) => {
      const body = parse(reportBody, req.body);
      const row = await createOdourReport(req.db, req.user!, body);
      res.status(201).json(odourItem(row));
    }),
  );

  r.delete(
    '/:id',
    wrap(async (req, res) => {
      const ok = await deleteOdourReport(req.db, String(req.params.id), { communityId: req.user!.community_id, userId: req.user!.id });
      if (!ok) throw new HttpError(404, 'Report not found.');
      res.json({ ok: true });
    }),
  );

  return r;
}

/** Admin only: the exact level and flat of every report, for pattern spotting. Mounted at /api/admin/odour. */
export function odourAdminRouter(): Router {
  const r = Router();

  r.get(
    '/',
    requireAdmin,
    wrap(async (req, res) => {
      const q = parse(z.object({ days: z.coerce.number().int().min(1).max(3650).optional(), type: z.enum(ODOUR_TYPES).optional(), where: z.enum(ODOUR_WHERE).optional() }), req.query);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items: await adminOdourList(req.db, req.user!.community_id, q), options: await odourOptions(req.db, req.user!.community_id) });
    }),
  );

  r.get(
    '/export.csv',
    requireAdmin,
    wrap(async (req, res) => {
      const items = await adminOdourList(req.db, req.user!.community_id);
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'odour_export_csv', ip: clientIp(req), detail: { rows: items.length } });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="smell-reports.csv"');
      res.send(odourCsv(items));
    }),
  );

  r.delete(
    '/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      const ok = await deleteOdourReport(req.db, id, { communityId: req.user!.community_id });
      if (!ok) throw new HttpError(404, 'Report not found.');
      await audit(req.db, { actorId: req.user!.id, actorRole: req.user!.role, action: 'odour_delete', targetType: 'odour_report', targetId: id, ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  return r;
}
