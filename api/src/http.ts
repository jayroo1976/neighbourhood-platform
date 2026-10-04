import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { Db } from './db';
import { config } from './config';
import { ADMIN_ROLES, type Role } from './domain';
import { HttpError, type Actor } from './services/incidents';

export interface SessionUser extends Actor {
  email: string;
  mfa_enabled: boolean;
  notify_email: boolean;
  consent_version: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      session?: { mfaOk: boolean; limited: boolean };
      db: Db;
    }
  }
}

export const COOKIE = 'np_session';

export function issueSession(res: Response, user: { id: string; token_version: number }, opts: { mfaOk: boolean; limited?: boolean }): void {
  const token = jwt.sign({ tv: user.token_version, mfa: opts.mfaOk, lim: !!opts.limited }, config.jwtSecret, {
    subject: user.id,
    expiresIn: `${config.sessionHours}h`,
    algorithm: 'HS256',
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: config.sessionHours * 3_600_000,
    path: '/',
  });
}

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    void fn(req, res, next).catch(next);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first.path.join('.') || 'request'}: ${first.message}`, 'validation');
  }
  return r.data;
}

/** Reads the session cookie, loads the user and rejects revoked / deactivated accounts. */
export const loadSession: RequestHandler = wrap(async (req, _res, next) => {
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    const u = await req.db('users').where({ id: p.sub }).first();
    if (u && u.active && !u.deleted_at && u.token_version === p.tv) {
      req.user = {
        id: u.id,
        role: u.role,
        name: u.name,
        tower: u.tower,
        unit: u.unit,
        community_id: u.community_id,
        email: u.email,
        mfa_enabled: !!u.mfa_enabled,
        notify_email: !!u.notify_email,
        consent_version: u.consent_version,
      };
      req.session = { mfaOk: !!p.mfa, limited: !!p.lim };
    }
  } catch {
    /* invalid or expired token: treat as signed out */
  }
  next();
});

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  if (req.session?.limited) return next(new HttpError(403, 'Set up two-factor authentication to continue.', 'mfa_enrol_required'));
  next();
};

/** For endpoints a limited (pre-MFA-enrolment) session may call. */
export const requireAuthAllowLimited: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.', 'unauthenticated'));
    if (req.session?.limited) return next(new HttpError(403, 'Set up two-factor authentication to continue.', 'mfa_enrol_required'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Not allowed.', 'forbidden'));
    if (ADMIN_ROLES.includes(req.user.role) && config.requireAdminMfa && !req.session?.mfaOk) {
      return next(new HttpError(403, 'Two-factor sign-in required.', 'mfa_required'));
    }
    next();
  };

export const requireAdmin = requireRole('admin', 'super_admin');
export const requireStaff = requireRole('admin', 'super_admin', 'committee');

/**
 * Cookies are SameSite=Lax; on top of that every state-changing /api call must carry a custom header,
 * which browsers will not send cross-site without a CORS pre-flight that we never approve.
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/inbound/')) return next(); // machine webhook, authenticated by secret
  if (req.get('x-requested-with') !== 'neighbourhood') return next(new HttpError(403, 'Missing request header.', 'csrf'));
  next();
};

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid request', code: 'validation' });
    return;
  }
  const e = err as { code?: string; message?: string };
  if (e.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Photo is too large (max 12 MB).', code: 'too_large' });
    return;
  }
  // Never leak internals to the client; log without request bodies (they may contain personal data).
  console.error(JSON.stringify({ level: 'error', path: req.path, method: req.method, message: e.message }));
  res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'internal' });
};

export const clientIp = (req: Request): string => req.ip ?? '';
