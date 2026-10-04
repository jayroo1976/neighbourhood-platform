import express, { type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { createApp } from './app';
import { ensureCommunity } from './bootstrap';
import { config } from './config';
import { createDb, migrate } from './db';
import { startScheduler } from './services/scheduler';
import { WAKE_HTML, WAKE_JS, serverState, sleepManaged, wakeServer } from './services/sleep';

/**
 * The HTTP server starts immediately and answers from a small "gate" while the database is down
 * (stopped overnight to save cost). Once the database accepts connections the real app takes over.
 */
async function main() {
  const db = createDb();
  let real: RequestHandler | null = null;
  let stopScheduler = () => undefined as void;

  const gate = express();
  gate.disable('x-powered-by');
  gate.set('trust proxy', 1);
  gate.get('/healthz', (_req, res) => res.json({ ok: true, ready: Boolean(real) }));
  gate.get('/api/system/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ state: real ? 'up' : await serverState() });
  });
  gate.post(
    '/api/system/wake',
    rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      if (req.get('x-requested-with') !== 'neighbourhood') return res.status(403).json({ error: 'Forbidden' });
      res.json({ state: real ? 'up' : await wakeServer() });
    },
  );
  gate.get('/__wake.js', (_req, res) => res.type('js').send(WAKE_JS));
  gate.use('/api', (_req, res) => res.status(503).json({ error: 'The service is asleep. Reload to start it.', code: 'asleep' }));
  gate.get('*', (_req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'" });
    res.status(503).type('html').send(WAKE_HTML);
  });

  const server = express()
    .use((req, res, next) => {
      // system endpoints and health always come from the gate, so they work in both modes
      if (req.path === '/healthz' || req.path.startsWith('/api/system/') || req.path === '/__wake.js') return gate(req, res, next);
      return (real ?? gate)(req, res, next);
    })
    .listen(config.port, () => console.log(`API listening on :${config.port} (${config.isProd ? 'production' : 'development'})`));

  async function dbReachable(): Promise<boolean> {
    try {
      await Promise.race([db.raw('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
      return true;
    } catch {
      return false;
    }
  }

  async function bringUp() {
    while (!(await dbReachable())) await new Promise((r) => setTimeout(r, sleepManaged ? 5000 : 3000));
    await migrate(db);
    await ensureCommunity(db);
    const c = await db('communities').where({ slug: config.defaults.communitySlug }).first('dh_email');
    if (config.isProd && /example\.(com|invalid)/.test(c?.dh_email ?? '')) {
      console.warn('[warn] The management (Dubai Holding) email address is still a placeholder. Set it in Admin > Settings before real use.');
    }
    if (config.isProd && config.email.provider === 'console') console.warn('[warn] EMAIL_PROVIDER=console: no real emails will be sent.');
    real = createApp(db);
    if (config.schedulerEnabled) stopScheduler = startScheduler(db);
    console.log('Database ready: serving the full app');
  }
  bringUp().catch((e) => {
    console.error(e);
    process.exit(1);
  });

  const shutdown = () => {
    stopScheduler();
    server.close(() => void db.destroy().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
