import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Db } from './db';
import { config } from './config';
import { withPreview } from './services/sharePreview';
import { csrfGuard, errorHandler, loadSession } from './http';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { aiRouter, incidentsRouter, uploadsRouter } from './routes/incidents';
import { filesRouter, inboundRouter, kpiRouter } from './routes/misc';
import { meRouter, notificationsRouter } from './routes/me';

export function createApp(db: Db): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Azure Container Apps ingress terminates TLS in front of us

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          // Only the two providers a resident can opt to use with their OWN key from their own browser (see web/src/ownAi.ts)
          'connect-src': ["'self'", 'https://api.anthropic.com', 'https://api.openai.com'],
          'font-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'same-origin' },
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.db = db;
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  const limit = (windowMs: number, max: number) =>
    config.isTest ? (_q: unknown, _r: unknown, n: () => void) => n() : rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.', code: 'rate_limited' } });

  api.use(limit(15 * 60_000, 600));
  api.use('/auth/login', limit(15 * 60_000, 20));
  api.use('/auth/register', limit(60 * 60_000, 15));
  api.use('/auth/forgot', limit(60 * 60_000, 10));
  api.use('/inbound', inboundRouter());
  api.use(csrfGuard);
  api.use(loadSession);
  api.use('/auth', authRouter());
  api.use('/me', meRouter());
  api.use('/notifications', notificationsRouter());
  api.use('/uploads', uploadsRouter());
  api.use('/ai', limit(60 * 60_000, 60), aiRouter());
  api.use('/incidents', incidentsRouter());
  api.use('/kpi', kpiRouter());
  api.use('/admin', adminRouter());
  app.use('/api/files', filesRouter());
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built web client (single container deployment)
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h', setHeaders: (res, p) => p.endsWith('sw.js') && res.setHeader('Cache-Control', 'no-cache') }));
    const indexPath = path.join(webDist, 'index.html');
    app.get('/incident/:id', async (req, res, next) => {
      try {
        const html = await withPreview(db, fs.readFileSync(indexPath, 'utf8'), req.path, req.params.id, req.query.s);
        res.set('Cache-Control', 'no-cache').type('html').send(html);
      } catch (e) {
        next(e);
      }
    });
    app.get('*', (_req, res) => res.sendFile(indexPath));
  }

  app.use(errorHandler);
  return app;
}
