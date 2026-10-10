import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config';
import { ADMIN_ROLES, mergeSettings } from '../domain';
import { COOKIE, clientIp, issueSession, parse, requireAuth, requireAuthAllowLimited, wrap } from '../http';
import { decryptSecret, encryptSecret, hashPassword, passwordProblem, sha256, verifyPassword } from '../security/crypto';
import { generateSecret, otpauthUri, verifyTotp } from '../security/totp';
import { HttpError } from '../services/incidents';
import { queueEmail } from '../services/mailer';
import { audit } from '../services/support';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

const email = z.string().trim().toLowerCase().email().max(200);

export function authRouter(): Router {
  const r = Router();

  r.post(
    '/register',
    wrap(async (req, res) => {
      const body = parse(
        z.object({
          email,
          password: z.string().max(200),
          name: z.string().trim().min(2).max(80),
          tower: z.string().trim().min(1).max(40),
          unit: z.string().trim().min(1).max(20),
          phone: z.string().trim().max(30).optional(),
          invite_code: z.string().max(100).optional(),
          ref: z.string().max(40).optional(),
          community: z.string().max(60).optional(),
          consent: z.literal(true, { errorMap: () => ({ message: 'You must accept the privacy notice to register.' }) }),
          terms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms of use to register.' }) }),
        }),
        req.body,
      );
      const community = await req.db('communities').where({ slug: body.community ?? config.defaults.communitySlug }).first();
      if (!community) throw new HttpError(404, 'Community not found.');
      if (!mergeSettings(community.settings).registration_open) throw new HttpError(403, 'Registration is currently closed.');
      const settings = mergeSettings(community.settings);
      const given = body.invite_code?.trim() ?? '';
      let codeValid = false;
      if (config.registrationCode && given) {
        const a = Buffer.from(given);
        const b = Buffer.from(config.registrationCode);
        codeValid = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (config.registrationCode && !codeValid) {
        // With approval on, the code is optional (it only skips the wait); a wrong code is still an error.
        if (!settings.require_approval || given) throw new HttpError(403, 'That invite code is not valid.', 'bad_invite');
      }
      const inviter = body.ref ? await req.db('users').where({ invite_token: body.ref, community_id: community.id, active: 1 }).whereNull('deleted_at').first() : null;
      const approved = !settings.require_approval || codeValid || (!!inviter && settings.trust_resident_invites);
      const problem = passwordProblem(body.password, body.email);
      if (problem) throw new HttpError(400, problem, 'weak_password');
      if (await req.db('users').where({ email: body.email }).first()) {
        throw new HttpError(409, 'An account with this email already exists. Try signing in.');
      }
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await req.db('users').insert({
        id,
        community_id: community.id,
        email: body.email,
        password_hash: await hashPassword(body.password),
        name: body.name,
        phone: body.phone || null,
        tower: body.tower,
        unit: body.unit,
        role: 'resident',
        approval_status: approved ? 'approved' : 'pending',
        invited_by: inviter?.id ?? null,
        consent_at: now,
        consent_version: config.privacyNoticeVersion,
        terms_at: now,
        terms_version: config.termsVersion,
        created_at: now,
      });
      await audit(req.db, { actorId: id, actorRole: 'resident', action: approved ? 'register' : 'register_request', targetType: 'user', targetId: id, ip: clientIp(req) });
      if (!approved) {
        const admins = await req.db('users').where({ community_id: community.id, active: 1 }).whereIn('role', ['admin', 'super_admin']).whereNull('deleted_at').select('email');
        for (const a of admins) {
          await queueEmail(req.db, {
            kind: 'signup_request',
            communityId: community.id,
            to: a.email,
            subject: 'New sign-up request waiting for approval',
            text: `${body.name} (${body.tower}, ${body.unit}) asked to join ${community.name}${inviter ? `, invited by ${inviter.name}` : ''}.\nReview it under Admin > People: ${config.appBaseUrl}/admin/users`,
          });
        }
        res.status(202).json({ ok: true, pending: true });
        return;
      }
      issueSession(res, { id, token_version: 0 }, { mfaOk: false });
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    '/login',
    wrap(async (req, res) => {
      const body = parse(
        z.object({ email, password: z.string().max(200), mfa_code: z.string().max(20).optional(), recovery_code: z.string().max(40).optional() }),
        req.body,
      );
      const u = await req.db('users').where({ email: body.email }).first();
      const now = Date.now();
      const locked = u?.locked_until && Date.parse(u.locked_until) > now;
      const passwordOk = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);

      if (u && passwordOk && !locked && !u.deleted_at && u.approval_status === 'pending') {
        throw new HttpError(403, 'Your request to join is waiting for approval. We will email you as soon as a moderator has reviewed it.', 'pending_approval');
      }
      if (u && passwordOk && !locked && !u.deleted_at && u.approval_status === 'rejected') {
        throw new HttpError(403, 'Your request to join was not approved. Please contact your community moderators.', 'not_approved');
      }
      if (!u || !u.active || u.deleted_at || locked || !passwordOk) {
        if (u && !locked && !passwordOk) {
          const fails = u.failed_logins + 1;
          await req.db('users').where({ id: u.id }).update({
            failed_logins: fails >= MAX_FAILS ? 0 : fails,
            locked_until: fails >= MAX_FAILS ? new Date(now + LOCK_MINUTES * 60_000).toISOString() : null,
          });
          if (fails >= MAX_FAILS) await audit(req.db, { actorId: u.id, action: 'account_locked', targetType: 'user', targetId: u.id, ip: clientIp(req) });
        }
        await audit(req.db, { actorId: u?.id, action: 'login_failed', ip: clientIp(req), detail: { locked: !!locked } });
        throw new HttpError(locked ? 429 : 401, locked ? 'Too many attempts. Try again in 15 minutes.' : 'Email or password is incorrect.', locked ? 'locked' : 'bad_credentials');
      }

      let mfaOk = false;
      if (u.mfa_enabled) {
        if (body.recovery_code) {
          const hashes: string[] = JSON.parse(u.recovery_hashes);
          const h = sha256(body.recovery_code.trim().toLowerCase());
          if (!hashes.includes(h)) throw new HttpError(401, 'Recovery code is not valid.', 'bad_mfa');
          await req.db('users').where({ id: u.id }).update({ recovery_hashes: JSON.stringify(hashes.filter((x) => x !== h)) });
          mfaOk = true;
        } else if (body.mfa_code) {
          if (!verifyTotp(decryptSecret(u.mfa_secret_enc), body.mfa_code)) {
            await audit(req.db, { actorId: u.id, action: 'mfa_failed', ip: clientIp(req) });
            throw new HttpError(401, 'That code is not right. Check your authenticator app.', 'bad_mfa');
          }
          mfaOk = true;
        } else {
          throw new HttpError(401, 'Enter your authentication code.', 'mfa_required');
        }
      }

      await req.db('users').where({ id: u.id }).update({ failed_logins: 0, locked_until: null, last_login_at: new Date().toISOString() });
      const mustEnrol = ADMIN_ROLES.includes(u.role) && config.requireAdminMfa && !u.mfa_enabled;
      issueSession(res, u, { mfaOk, limited: mustEnrol });
      await audit(req.db, { actorId: u.id, actorRole: u.role, action: 'login', ip: clientIp(req) });
      res.json({ ok: true, mfa_enrol_required: mustEnrol });
    }),
  );

  r.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.get(
    '/me',
    wrap(async (req, res) => {
      if (!req.user) {
        const c = await req.db('communities').where({ slug: config.defaults.communitySlug }).first();
        const st = c ? mergeSettings(c.settings) : null;
        return res.json({ user: null, config: { ...publicConfig(), approval_required: !!st?.require_approval, registration_open: st?.registration_open ?? true } });
      }
      const community = await req.db('communities').where({ id: req.user.community_id }).first();
      const s = mergeSettings(community.settings);
      res.json({
        user: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email,
          role: req.user.role,
          tower: req.user.tower,
          unit: req.user.unit,
          notify_email: req.user.notify_email,
          mfa_enabled: req.user.mfa_enabled,
          mfa_enrol_required: !!req.session?.limited,
          consent_current: req.user.consent_version === config.privacyNoticeVersion,
        },
        community: { name: community.name, towers: JSON.parse(community.towers) },
        config: {
          ...publicConfig(),
          require_photo_for_affects: s.require_photo_for_affects,
          ai_suggest: s.ai_suggest_enabled && config.ai.enabled,
          sla_case_hours: s.sla_case_hours,
          whatsapp_group_url: s.whatsapp_group_url,
        },
      });
    }),
  );

  r.post(
    '/forgot',
    wrap(async (req, res) => {
      const { email: addr } = parse(z.object({ email }), req.body);
      const u = await req.db('users').where({ email: addr, active: 1 }).whereNull('deleted_at').first();
      if (u) {
        const token = crypto.randomBytes(32).toString('base64url');
        await req.db('password_resets').insert({
          id: crypto.randomUUID(),
          user_id: u.id,
          token_hash: sha256(token),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await queueEmail(req.db, {
          kind: 'password_reset',
          communityId: u.community_id,
          to: u.email,
          subject: 'Reset your Neighbourhood Reports password',
          text: `Hi ${u.name.split(' ')[0]},\n\nUse this link within one hour to choose a new password:\n${config.appBaseUrl}/reset?token=${token}\n\nIf you did not ask for this, ignore this email.`,
        });
      }
      res.json({ ok: true }); // identical response whether or not the account exists
    }),
  );

  r.post(
    '/reset',
    wrap(async (req, res) => {
      const body = parse(z.object({ token: z.string().min(20).max(100), password: z.string().max(200) }), req.body);
      const row = await req.db('password_resets').where({ token_hash: sha256(body.token) }).first();
      if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) throw new HttpError(400, 'This reset link has expired. Request a new one.');
      const u = await req.db('users').where({ id: row.user_id }).first();
      const problem = passwordProblem(body.password, u.email);
      if (problem) throw new HttpError(400, problem, 'weak_password');
      await req.db.transaction(async (trx) => {
        await trx('users').where({ id: u.id }).update({
          password_hash: await hashPassword(body.password),
          token_version: u.token_version + 1, // signs out every existing session
          failed_logins: 0,
          locked_until: null,
        });
        await trx('password_resets').where({ id: row.id }).update({ used_at: new Date().toISOString() });
      });
      await audit(req.db, { actorId: u.id, action: 'password_reset', ip: clientIp(req) });
      res.json({ ok: true });
    }),
  );

  // ---- two-factor authentication (TOTP) ----
  r.post(
    '/mfa/setup',
    requireAuthAllowLimited,
    wrap(async (req, res) => {
      if (req.user!.mfa_enabled) throw new HttpError(400, 'Two-factor authentication is already on.');
      const secret = generateSecret();
      await req.db('users').where({ id: req.user!.id }).update({ mfa_secret_enc: encryptSecret(secret) });
      const uri = otpauthUri(secret, req.user!.email);
      res.json({ secret, otpauth_uri: uri, qr_data_url: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
    }),
  );

  r.post(
    '/mfa/enable',
    requireAuthAllowLimited,
    wrap(async (req, res) => {
      const { code } = parse(z.object({ code: z.string().max(10) }), req.body);
      const u = await req.db('users').where({ id: req.user!.id }).first();
      if (!u.mfa_secret_enc) throw new HttpError(400, 'Start setup first.');
      if (!verifyTotp(decryptSecret(u.mfa_secret_enc), code)) throw new HttpError(400, 'That code is not right. Try the next one in your app.', 'bad_mfa');
      const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
      await req.db('users').where({ id: u.id }).update({ mfa_enabled: 1, recovery_hashes: JSON.stringify(recovery.map((c) => sha256(c))) });
      await audit(req.db, { actorId: u.id, actorRole: u.role, action: 'mfa_enabled', ip: clientIp(req) });
      issueSession(res, u, { mfaOk: true });
      res.json({ ok: true, recovery_codes: recovery });
    }),
  );

  r.post(
    '/consent',
    requireAuth,
    wrap(async (req, res) => {
      parse(z.object({ accept: z.literal(true) }), req.body);
      await req.db('users').where({ id: req.user!.id }).update({ consent_at: new Date().toISOString(), consent_version: config.privacyNoticeVersion });
      res.json({ ok: true });
    }),
  );

  return r;
}

function publicConfig() {
  return { privacy_notice_version: config.privacyNoticeVersion, terms_version: config.termsVersion, invite_required: !!config.registrationCode };
}
