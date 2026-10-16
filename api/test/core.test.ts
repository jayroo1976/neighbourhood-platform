import { withPreview } from '../src/services/sharePreview';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/services/events';
import { deliverOutbox } from '../src/services/scheduler';
import { signFileLink, verifyFileLink, canonicalJson, passwordProblem } from '../src/security/crypto';
import { totpAt, verifyTotp } from '../src/security/totp';
import { extractCaseNumber } from '../src/services/incidents';
import { clearAirCache, getAir, parseLayout, type WsCtor } from '../src/services/air';
import { config } from '../src/config';
import { H, PASSWORD, createReport, makeStaff, register, setup, uploadPhoto } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});

describe('security primitives', () => {
  it('matches the RFC 6238 TOTP test vector', () => {
    // ASCII "12345678901234567890" in base32; RFC gives 94287082 at T=59 (6 digits: 287082)
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });

  it('signs and expires file links', () => {
    const { exp, sig } = signFileLink('a/b.jpg', 60);
    expect(verifyFileLink('a/b.jpg', exp, sig)).toBe(true);
    expect(verifyFileLink('a/other.jpg', exp, sig)).toBe(false);
    const old = signFileLink('a/b.jpg', -10);
    expect(verifyFileLink('a/b.jpg', old.exp, old.sig)).toBe(false);
  });

  it('canonicalises JSON regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it('enforces a sensible password policy', () => {
    expect(passwordProblem('short')).toBeTruthy();
    expect(passwordProblem('password12345')).toBeTruthy();
    expect(passwordProblem('Correct-Horse-Battery-9')).toBeNull();
  });

  it('pulls case numbers out of management replies', () => {
    expect(extractCaseNumber('Your case number: SR-123456 has been logged')).toBe('SR-123456');
    expect(extractCaseNumber('Ticket #884211 created')).toBe('884211');
    expect(extractCaseNumber('Thanks for reporting')).toBeNull();
  });
});

describe('auth', () => {
  it('rejects state-changing calls without the CSRF header', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('registers, signs in, locks after repeated failures and keeps errors generic', async () => {
    const weak = await request(ctx.app).post('/api/auth/register').set(H).send({ email: 'weak@example.test', password: 'password', name: 'Weak', tower: 'MR 1', unit: '1', consent: true, terms: true });
    expect(weak.status).toBe(400);
    const noTerms = await request(ctx.app).post('/api/auth/register').set(H).send({ email: 'nt@example.test', password: PASSWORD, name: 'No Terms', tower: 'MR 1', unit: '1', consent: true });
    expect(noTerms.status).toBe(400);
    const badTower = await request(ctx.app).post('/api/auth/register').set(H).send({ email: 'bt@example.test', password: PASSWORD, name: 'Bad Tower', tower: 'Tower 99', unit: '1', consent: true, terms: true });
    expect(badTower.status).toBe(400);
    const anon = await request(ctx.app).get('/api/auth/me');
    expect(anon.body.community.towers).toEqual(['MR 1', 'MR 2', 'MR 3']);
    const noConsent = await request(ctx.app).post('/api/auth/register').set(H).send({ email: 'nc@example.test', password: PASSWORD, name: 'No Consent', tower: 'MR 1', unit: '1', consent: false });
    expect(noConsent.status).toBe(400);

    const { agent, email } = await register(ctx.app, { email: 'lock@example.test' });
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.email).toBe(email);
    expect(me.headers['set-cookie']).toBeUndefined();

    for (let i = 0; i < 5; i++) {
      const bad = await request(ctx.app).post('/api/auth/login').set(H).send({ email, password: 'Wrong-Password-1!' });
      expect(bad.status).toBe(401);
    }
    const locked = await request(ctx.app).post('/api/auth/login').set(H).send({ email, password: PASSWORD });
    expect(locked.status).toBe(429);
    const unknown = await request(ctx.app).post('/api/auth/login').set(H).send({ email: 'nobody@example.test', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('Email or password is incorrect.');
  });
});

describe('incident workflow', () => {
  it('captures a report, emails management, tracks case number and resolution with a verifiable history', async () => {
    const { agent } = await register(ctx.app, { tower: 'MR 2', unit: '903' });
    const created = await createReport(agent);
    expect(created.ref).toMatch(/^INC-\d{4}$/);

    // email is queued, then delivered to management with signed photo links and a reply-to token
    const before = ctx.mail.sent.length;
    await deliverOutbox(ctx.db);
    const sent = ctx.mail.sent.slice(before).find((m) => m.subject.includes(created.ref))!;
    expect(sent.to).toBe('community-support@mgmt.test');
    expect(sent.text).toContain('MR 2, Unit 903');
    expect(sent.text).toMatch(/https:\/\/app\.test\/api\/files\/.+sig=/);
    expect(sent.replyTo).toMatch(/^inc\+[a-f0-9]{16}@reply\.test$/);

    let detail = (await agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.status).toBe('reported');
    expect(detail.emailed_at).toBeTruthy();
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(['reported', 'email_sent']);

    // case number
    expect((await agent.post(`/api/incidents/${created.id}/case-number`).set(H).send({ case_number: '!!' })).status).toBe(400);
    expect((await agent.post(`/api/incidents/${created.id}/case-number`).set(H).send({ case_number: 'SR-77881' })).status).toBe(200);
    detail = (await agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.status).toBe('case_number_received');
    expect(detail.kpis.acknowledgement_sla).toBe('met');

    // management says closed, resident disputes with evidence
    expect((await agent.post(`/api/incidents/${created.id}/status`).set(H).send({ to: 'mgmt_closed' })).status).toBe(200);
    const noPhoto = await agent.post(`/api/incidents/${created.id}/status`).set(H).send({ to: 'resolved_poor' });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.code).toBe('photo_required');
    const evidence = await uploadPhoto(agent, 'resolution');
    expect((await agent.post(`/api/incidents/${created.id}/status`).set(H).send({ to: 'resolved_poor', upload_id: evidence, note: 'Patch already peeling' })).status).toBe(200);
    detail = (await agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.status).toBe('resolved_poor');
    expect(detail.kpis.disputed_closure).toBe(true);
    expect(detail.photos.filter((p: { kind: string }) => p.kind === 'resolution')).toHaveLength(1);

    expect((await agent.post(`/api/incidents/${created.id}/status`).set(H).send({ to: 'reopened' })).status).toBe(200);

    const chain = await verifyChain(ctx.db, created.id);
    expect(chain.ok).toBe(true);
    expect(chain.events).toBeGreaterThanOrEqual(7);
  });

  it('detects tampering with the event history', async () => {
    const { agent } = await register(ctx.app);
    const created = await createReport(agent);
    await agent.post(`/api/incidents/${created.id}/note`).set(H).send({ text: 'Original note' });
    expect((await verifyChain(ctx.db, created.id)).ok).toBe(true);
    const ev = await ctx.db('incident_events').where({ incident_id: created.id, type: 'note_added' }).first();
    await ctx.db('incident_events').where({ id: ev.id }).update({ payload: JSON.stringify({ text: 'Edited later' }) });
    const broken = await verifyChain(ctx.db, created.id);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toBe(ev.n);
  });

  it('records management replies from the inbound webhook and extracts the case number', async () => {
    const { agent } = await register(ctx.app);
    const created = await createReport(agent);
    const token = (await ctx.db('incidents').where({ id: created.id }).first()).reply_token;
    const denied = await request(ctx.app).post('/api/inbound/email').send({ to: `inc+${token}@reply.test`, text: 'hi' });
    expect(denied.status).toBe(401);
    const ok = await request(ctx.app)
      .post('/api/inbound/email')
      .set('x-inbound-secret', 'test-inbound-secret')
      .send({ to: `inc+${token}@reply.test`, from: 'support@mgmt.test', subject: `Re: [${created.ref}]`, text: 'Thanks. Your case number: SR-555123.\n\nOn Mon wrote:\n> old text' });
    expect(ok.status).toBe(200);
    expect(ok.body.caseNumber).toBe('SR-555123');
    const detail = (await agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.mgmt_case_number).toBe('SR-555123');
    expect(detail.events.some((e: { type: string }) => e.type === 'mgmt_reply_received')).toBe(true);
  });
});

describe('affects me', () => {
  it('requires a fresh photo by default, blocks duplicates and own reports, and emails management each time', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '101' });
    const b = await register(ctx.app, { tower: 'MR 1', unit: '202' });
    const created = await createReport(a.agent);

    const own = await a.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({});
    expect(own.status).toBe(400);

    const noPhoto = await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({});
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.code).toBe('photo_required');

    const queuedBefore = (await ctx.db('email_outbox').where({ kind: 'mgmt_affects' }).count({ c: '*' }).first())!.c as number;
    const up = await uploadPhoto(b.agent, 'affects');
    expect((await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({ upload_id: up })).status).toBe(201);
    const second = await uploadPhoto(b.agent, 'affects');
    expect((await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({ upload_id: second })).status).toBe(409);
    const queuedAfter = (await ctx.db('email_outbox').where({ kind: 'mgmt_affects' }).count({ c: '*' }).first())!.c as number;
    expect(Number(queuedAfter) - Number(queuedBefore)).toBe(1);

    const detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.affects_count).toBe(1);
  });

  it('records each resident own incident ID, shows it only to them, and flags can_affect in the feed', async () => {
    const a = await register(ctx.app, { tower: 'MR 2', unit: '301' });
    const b = await register(ctx.app, { tower: 'MR 2', unit: '302' });
    const created = await createReport(a.agent);
    const feedB = (await b.agent.get('/api/incidents?scope=community&state=open')).body.items.find((i: { id: string }) => i.id === created.id);
    expect(feedB.can_affect).toBe(true);
    const up1 = await uploadPhoto(b.agent, 'affects');
    const bad = await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({ upload_id: up1, case_number: '!!' });
    expect(bad.status).toBe(400);
    const up2 = await uploadPhoto(b.agent, 'affects');
    const ok = await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({ upload_id: up2, case_number: 'SR-555-B' });
    expect(ok.status).toBe(201);
    const mail = await ctx.db('email_outbox').where({ kind: 'mgmt_affects' }).orderBy('created_at', 'desc').first();
    expect(JSON.stringify(mail)).toContain('SR-555-B');
    expect((await b.agent.get(`/api/incidents/${created.id}`)).body.permissions.my_case_number).toBe('SR-555-B');
    expect((await a.agent.get(`/api/incidents/${created.id}`)).body.permissions.my_case_number ?? null).toBeNull();
    expect((await b.agent.post(`/api/incidents/${created.id}/my-case-number`).set(H).send({ case_number: 'SR-777-B' })).status).toBe(200);
    expect((await b.agent.get(`/api/incidents/${created.id}`)).body.permissions.my_case_number).toBe('SR-777-B');
    expect((await a.agent.post(`/api/incidents/${created.id}/my-case-number`).set(H).send({ case_number: 'SR-1-A' })).status).toBe(403);
  });

  it('lets an admin turn the photo requirement off', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const a = await register(ctx.app);
    const b = await register(ctx.app);
    const created = await createReport(a.agent);
    expect((await admin.agent.patch('/api/admin/settings').set(H).send({ settings: { require_photo_for_affects: false } })).status).toBe(200);
    expect((await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({})).status).toBe(201);
    await admin.agent.patch('/api/admin/settings').set(H).send({ settings: { require_photo_for_affects: true } });
  });
});

describe('adding people', () => {
  const setSettings = (o: Record<string, unknown>) => ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ email_mode: 'platform', require_photo_for_affects: true, require_approval: false, ...o }) });
  const signup = (email: string, extra: Record<string, unknown> = {}) =>
    request(ctx.app).post('/api/auth/register').set(H).send({ name: 'New Person', email, password: PASSWORD, tower: 'MR 2', unit: '77', consent: true, terms: true, ...extra });

  it('holds self-requests for approval, lets an admin approve or decline, and blocks sign-in until then', async () => {
    await setSettings({ require_approval: true });
    try {
      const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
      const r1 = await signup('pending1@example.test');
      expect(r1.status).toBe(202);
      expect(r1.body.pending).toBe(true);
      expect(r1.headers['set-cookie']).toBeUndefined();
      const login = await request(ctx.app).post('/api/auth/login').set(H).send({ email: 'pending1@example.test', password: PASSWORD });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('pending_approval');
      expect((await admin.agent.get('/api/admin/users/pending-count')).body.count).toBeGreaterThanOrEqual(1);
      const users = (await admin.agent.get('/api/admin/users')).body.items;
      const row = users.find((u: { email: string }) => u.email === 'pending1@example.test');
      expect(row.approval_status).toBe('pending');
      expect((await admin.agent.post(`/api/admin/users/${row.id}/approve`).set(H)).status).toBe(200);
      expect((await request(ctx.app).post('/api/auth/login').set(H).send({ email: 'pending1@example.test', password: PASSWORD })).status).toBe(200);

      const r2 = await signup('pending2@example.test');
      const row2 = (await admin.agent.get('/api/admin/users')).body.items.find((u: { email: string }) => u.email === 'pending2@example.test');
      expect((await admin.agent.post(`/api/admin/users/${row2.id}/decline`).set(H)).status).toBe(200);
      expect(r2.status).toBe(202);
      expect((await request(ctx.app).post('/api/auth/login').set(H).send({ email: 'pending2@example.test', password: PASSWORD })).body.code).toBe('not_approved');
    } finally {
      await setSettings({});
    }
  });

  it('lets residents invite neighbours with a personal link and admins add people directly', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '12' });
    await setSettings({ require_approval: true, trust_resident_invites: true });
    try {
      const invite = (await a.agent.get('/api/me/invite')).body;
      expect(invite.url).toContain('/register?ref=');
      const ref = new URL(invite.url).searchParams.get('ref');
      const viaInvite = await signup('invited@example.test', { ref });
      expect(viaInvite.status).toBe(201); // trusted invite: approved at once
      const viaNone = await signup('stranger@example.test');
      expect(viaNone.status).toBe(202);

      const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
      const added = await admin.agent.post('/api/admin/users').set(H).send({ name: 'Added Person', email: 'added@example.test', tower: 'MR 3', unit: '5' });
      expect(added.status).toBe(201);
      expect(added.body.setup_link).toContain('/reset?token=');
      const token = new URL(added.body.setup_link).searchParams.get('token');
      expect((await request(ctx.app).post('/api/auth/reset').set(H).send({ token, password: PASSWORD })).status).toBe(200);
      expect((await request(ctx.app).post('/api/auth/login').set(H).send({ email: 'added@example.test', password: PASSWORD })).status).toBe(200);
      expect((await admin.agent.post('/api/admin/users').set(H).send({ name: 'Boss', email: 'boss@example.test', role: 'admin' })).status).toBe(403); // only super admins add admins
    } finally {
      await setSettings({});
    }
  });
});

describe('resident sends the email from their own mail app', () => {
  it('saves the report without a server email, gives a draft, and records the confirmation', async () => {
    await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ email_mode: 'resident', require_photo_for_affects: false, require_approval: false }) });
    try {
      const a = await register(ctx.app, { tower: 'MR 3', unit: '1004' });
      const b = await register(ctx.app, { tower: 'MR 3', unit: '1005' });
      const before = (await ctx.db('email_outbox').count({ c: '*' }).first())!.c as number;
      const created = await createReport(a.agent, { title: 'Ladder left in stairwell' });
      expect(Number((await ctx.db('email_outbox').count({ c: '*' }).first())!.c)).toBe(Number(before));
      let detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
      expect(detail.permissions.needs_my_email).toBe(true);
      expect(detail.emailed_at).toBeNull();
      const draft = (await a.agent.get(`/api/incidents/${created.id}/email-draft`)).body;
      expect(draft.kind).toBe('new');
      expect(draft.to).toBeTruthy();
      expect(draft.body).toContain('Ladder left in stairwell');
      expect(draft.body).toContain('I am a resident');
      expect((await a.agent.post(`/api/incidents/${created.id}/email-sent`).set(H)).status).toBe(200);
      detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
      expect(detail.emailed_at).toBeTruthy();
      expect(detail.permissions.needs_my_email).toBe(false);

      // affects me: no photo needed, no server email, own draft
      const join = await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({});
      expect(join.status).toBe(201);
      expect(Number((await ctx.db('email_outbox').count({ c: '*' }).first())!.c)).toBe(Number(before));
      const d2 = (await b.agent.get(`/api/incidents/${created.id}/email-draft`)).body;
      expect(d2.kind).toBe('affects');
      expect(d2.body).toContain('ALSO affected');
      expect((await b.agent.post(`/api/incidents/${created.id}/email-sent`).set(H)).status).toBe(200);
      expect((await b.agent.get(`/api/incidents/${created.id}`)).body.permissions.needs_my_email).toBe(false);
      const stranger = await register(ctx.app);
      expect((await stranger.agent.get(`/api/incidents/${created.id}/email-draft`)).status).toBe(403);
    } finally {
      await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ email_mode: 'platform', require_photo_for_affects: true, require_approval: false }) });
    }
  });
});

describe('share link preview', () => {
  it('shows title and photo only with a valid share token, never the apartment number', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '9876' });
    const created = await createReport(a.agent, { title: 'Broken gate at the car park' });
    const detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.share_url).toContain(`/incident/${created.id}?affects=1&s=`);
    const token = new URL(detail.share_url).searchParams.get('s');
    const html = '<html><head></head><body></body></html>';
    const good = await withPreview(ctx.db, html, `/incident/${created.id}`, created.id, token);
    expect(good).toContain('Broken gate at the car park');
    expect(good).toContain('og:image');
    expect(good).not.toContain('9876');
    const bad = await withPreview(ctx.db, html, `/incident/${created.id}`, created.id, 'x'.repeat(24));
    expect(bad).not.toContain('Broken gate');
    expect(bad).toContain('Neighbourhood Reports');
  });
});

describe('privacy', () => {
  it('hides unit numbers, blurs GPS and keeps private reports out of the community feed', async () => {
    const a = await register(ctx.app, { tower: 'MR 3', unit: '4501' });
    const b = await register(ctx.app, { tower: 'MR 3', unit: '4502' });
    const open = await createReport(a.agent, { title: 'Shared corridor light out' });
    const priv = await createReport(a.agent, { title: 'Private matter inside my apartment', visibility: 'private' });

    const asNeighbour = (await b.agent.get(`/api/incidents/${open.id}`)).body;
    expect(asNeighbour.unit).toBeUndefined();
    expect(asNeighbour.lat).toBe(25.205);
    expect(asNeighbour.gps_blurred).toBe(true);
    expect(JSON.stringify(asNeighbour)).not.toContain('4501');

    const asOwner = (await a.agent.get(`/api/incidents/${open.id}`)).body;
    expect(asOwner.unit).toBe('4501');
    expect(asOwner.lat).toBe(25.20481);

    expect((await b.agent.get(`/api/incidents/${priv.id}`)).status).toBe(404);
    const feed = (await b.agent.get('/api/incidents?state=all')).body;
    expect(feed.items.some((i: { id: string }) => i.id === priv.id)).toBe(false);
    expect(feed.items.some((i: { id: string }) => i.id === open.id)).toBe(true);
    const mine = (await a.agent.get('/api/incidents?scope=mine&state=all')).body;
    expect(mine.items.some((i: { id: string }) => i.id === priv.id)).toBe(true);
  });

  it('strips EXIF/GPS metadata from uploaded photos', async () => {
    const sharp = (await import('sharp')).default;
    const withExif = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#888' } })
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 12/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();
    const { processImage } = await import('../src/services/images');
    const out = await processImage(withExif);
    expect((await sharp(out.full).metadata()).exif).toBeUndefined();
    expect((await sharp(out.thumb).metadata()).exif).toBeUndefined();
  });

  it('exports and erases a resident’s personal data', async () => {
    const a = await register(ctx.app, { email: 'erase@example.test', unit: '777' });
    const created = await createReport(a.agent);
    const exp = await a.agent.get('/api/me/export');
    expect(exp.status).toBe(200);
    expect(exp.body.profile.email).toBe('erase@example.test');
    expect(exp.body.reports).toHaveLength(1);

    const wrong = await a.agent.post('/api/me/delete').set(H).send({ password: 'nope-nope-nope', withdraw_reports: false });
    expect(wrong.status).toBe(400);
    expect((await a.agent.post('/api/me/delete').set(H).send({ password: PASSWORD, withdraw_reports: false })).status).toBe(200);
    const user = await ctx.db('users').where({ deleted_at: ctx.db.raw('deleted_at') }).whereNotNull('deleted_at').first();
    expect(user.email).toMatch(/^deleted\+/);
    expect(user.name).toBe('Deleted resident');
    const row = await ctx.db('incidents').where({ id: created.id }).first();
    expect(row.unit).toBeNull();
    expect((await a.agent.get('/api/auth/me')).body.user).toBeNull();
  });
});

describe('admin and KPIs', () => {
  it('blocks residents from admin routes and lets admins consolidate duplicates', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const a = await register(ctx.app, { tower: 'MR 1' });
    const b = await register(ctx.app, { tower: 'MR 1' });
    expect((await a.agent.get('/api/admin/incidents')).status).toBe(403);
    expect((await a.agent.patch('/api/admin/settings').set(H).send({ settings: { cc_reporter: true } })).status).toBe(403);

    const first = await createReport(a.agent, { title: 'Lift 2 not working' });
    const second = await createReport(b.agent, { title: 'Lift 2 broken again' });
    expect((await admin.agent.post('/api/admin/incidents/link').set(H).send({ primary_id: first.id, ids: [second.id] })).status).toBe(200);

    const d1 = (await admin.agent.get(`/api/admin/incidents/${first.id}`)).body;
    expect(d1.linked.map((l: { id: string }) => l.id)).toEqual([second.id]);
    expect(d1.reporter.email).toBeTruthy();
    const d2 = (await b.agent.get(`/api/incidents/${second.id}`)).body;
    expect(d2.cluster_id).toBe(first.id);

    expect((await admin.agent.post(`/api/admin/incidents/${first.id}/case-number`).set(H).send({ case_number: 'SR-100200' })).status).toBe(200);
    expect((await admin.agent.post(`/api/admin/incidents/${first.id}/status`).set(H).send({ to: 'in_progress' })).status).toBe(200);
    const chain = (await admin.agent.get(`/api/admin/incidents/${first.id}/verify-chain`)).body;
    expect(chain.ok).toBe(true);

    const audit = (await admin.agent.get('/api/admin/audit')).body.items;
    expect(audit.some((x: { action: string }) => x.action === 'incident_link')).toBe(true);

    // more metrics: resident-safe on the scorecard, staff-only insights
    const sc = (await a.agent.get('/api/kpi/summary')).body;
    expect(sc.response.distribution).toHaveLength(5);
    expect(sc.by_severity.map((x: { severity: string }) => x.severity)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(sc.week.this.reported).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(sc)).not.toContain('@example.test');
    expect((await a.agent.get('/api/admin/insights')).status).toBe(403);
    const ins = (await admin.agent.get('/api/admin/insights')).body;
    expect(ins.kpis.counts.total).toBeGreaterThanOrEqual(2);
    expect(ins.people.residents).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(ins.longest_open)).toBe(true);
  });

  it('computes the performance scorecard from resident-verified outcomes', async () => {
    const { communityKpis } = await import('../src/services/kpi');
    const { mergeSettings } = await import('../src/domain');
    const { createIncident, setCaseNumber, changeStatus } = await import('../src/services/incidents');
    const db = (await import('../src/db')).createDb('sqlite::memory:');
    await (await import('../src/db')).migrate(db);
    const cid = await (await import('../src/bootstrap')).ensureCommunity(db);
    const user = { id: 'u1', role: 'resident' as const, name: 'K', tower: 'MR 1', unit: '1', community_id: cid };
    await db('users').insert({ id: 'u1', community_id: cid, email: 'k@x.test', password_hash: 'x', name: 'K', role: 'resident', tower: 'MR 1', unit: '1', created_at: new Date().toISOString() });
    const now = Date.parse('2026-10-01T08:00:00Z');
    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    const mk = async (daysAgo: number, severity: 'normal' | 'high' = 'normal') => {
      const at = new Date(now - daysAgo * DAY).toISOString();
      const inc = await createIncident(db, user, { title: `Issue ${daysAgo}`, description: '', category: 'lift', severity, visibility: 'community', upload_ids: [] }, { at, source: 'demo', skipEmail: true });
      await db('incidents').where({ id: inc.id }).update({ emailed_at: at });
      return { id: inc.id, t: now - daysAgo * DAY };
    };
    const admin = { ...user, id: 'u1' };
    // 1: case in 10h, closed, verified OK in 5 days
    const i1 = await mk(20);
    await setCaseNumber(db, user, i1.id, 'SR-0001', 'user', new Date(i1.t + 10 * HOUR).toISOString());
    await changeStatus(db, user, i1.id, 'mgmt_closed', { at: new Date(i1.t + 4 * DAY).toISOString() });
    await db('uploads').insert({ id: 'p1', user_id: 'u1', key: 'k', thumb_key: 't', mime: 'image/jpeg', bytes: 1, kind: 'resolution', created_at: new Date().toISOString() });
    await changeStatus(db, admin, i1.id, 'resolved_ok', { uploadId: 'p1', at: new Date(i1.t + 5 * DAY).toISOString() });
    // 2: case in 48h (late), closed, then resident says poor
    const i2 = await mk(20);
    await setCaseNumber(db, user, i2.id, 'SR-0002', 'user', new Date(i2.t + 48 * HOUR).toISOString());
    await changeStatus(db, user, i2.id, 'mgmt_closed', { at: new Date(i2.t + 3 * DAY).toISOString() });
    await db('uploads').insert({ id: 'p2', user_id: 'u1', key: 'k2', thumb_key: 't2', mime: 'image/jpeg', bytes: 1, kind: 'resolution', created_at: new Date().toISOString() });
    await changeStatus(db, user, i2.id, 'resolved_poor', { uploadId: 'p2', at: new Date(i2.t + 4 * DAY).toISOString() });
    // 3: no response for 3 days (SLA miss), still open
    await mk(3);
    // 4: brand new (not yet due)
    await mk(0.1);

    const k = await communityKpis(db, cid, mergeSettings({}), {}, now);
    expect(k.counts.total).toBe(4);
    expect(k.counts.open).toBe(2);
    expect(k.counts.resolved_ok).toBe(1);
    expect(k.counts.resolved_poor).toBe(1);
    // ack: i1 within 24h, i2 late (48h), i3 overdue => 1 of 3
    expect(k.acknowledgement.within_sla_rate).toBeCloseTo(1 / 3, 2);
    expect(k.acknowledgement.median_hours).toBe(29);
    // closure quality: two management closures, one verified good, one disputed => 50%
    expect(k.closure_quality.management_closed_total).toBe(2);
    expect(k.closure_quality.disputed).toBe(1);
    expect(k.closure_quality.disputed_rate).toBe(0.5);
    // fix quality: 1 ok vs 1 poor
    expect(k.closure_quality.verified_fix_rate).toBe(0.5);
    expect(k.resolution.median_days).toBe(5);
    expect(k.score.value).not.toBeNull();
    expect(k.score.components.map((c) => c.weight).reduce((a, b) => a + b, 0)).toBe(100);
    expect(k.disputed_closures).toHaveLength(1);
    await db.destroy();
  });
});

describe('scorecard: first-time fix, recurrence, hotspots, evidence', () => {
  it('works out the new resident-safe metrics from existing data', async () => {
    const { communityKpis, areaOf } = await import('../src/services/kpi');
    const { mergeSettings } = await import('../src/domain');
    const { createIncident } = await import('../src/services/incidents');
    const db = (await import('../src/db')).createDb('sqlite::memory:');
    await (await import('../src/db')).migrate(db);
    const cid = await (await import('../src/bootstrap')).ensureCommunity(db);
    const user = { id: 'u1', role: 'resident' as const, name: 'K', tower: 'MR 1', unit: '1', community_id: cid };
    await db('users').insert({ id: 'u1', community_id: cid, email: 'k@x.test', password_hash: 'x', name: 'K', role: 'resident', tower: 'MR 1', unit: '1', created_at: new Date().toISOString() });
    const now = Date.parse('2026-10-01T08:00:00Z');
    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    const iso = (t: number) => new Date(t).toISOString();
    const mk = async (daysAgo: number, patch: Record<string, unknown>, severity: 'normal' | 'urgent' = 'normal') => {
      const t = now - daysAgo * DAY;
      const inc = await createIncident(db, user, { title: `Issue ${daysAgo}`, description: '', category: 'lift', severity, visibility: 'community', upload_ids: [] }, { at: iso(t), source: 'demo', skipEmail: true });
      await db('incidents').where({ id: inc.id }).update({ emailed_at: iso(t), ...patch });
      return { id: inc.id, t };
    };
    // A: lift fault, closed by management after 4 days, verified fixed after 5, never reopened
    const A = await mk(100, { tower: 'MR 1', category: 'lift', location_text: 'Lift 2', lat: 25.1, lng: 55.1 });
    await db('incidents').where({ id: A.id }).update({ case_number_at: iso(A.t + 10 * HOUR), mgmt_first_reply_at: iso(A.t + 12 * HOUR), mgmt_closed_at: iso(A.t + 4 * DAY), mgmt_closed_count: 1, resolved_at: iso(A.t + 5 * DAY), resolution: 'ok', status: 'resolved_ok' });
    // B: the same lift area again 25 days after A was fixed
    const B = await mk(70, { tower: 'MR 1', category: 'lift', location_text: 'Lift 1', lat: 25.1, lng: 55.1, case_number_at: iso(now - 70 * DAY + 3 * HOUR) });
    // C: different tower and type, verified fixed but reopened once, nothing came back
    const C = await mk(40, { tower: 'MR 2', category: 'cleaning', location_text: 'Pool deck', mgmt_closed_at: iso(now - 40 * DAY + DAY), mgmt_closed_count: 1, resolved_at: iso(now - 40 * DAY + 2 * DAY), resolution: 'ok', status: 'resolved_ok', reopen_count: 1 });
    // D: open safety report in the lift area, case number within 2 hours
    const D = await mk(5, { tower: 'MR 1', category: 'lift', location_text: 'Lift lobby, bay 214', case_number_at: iso(now - 5 * DAY + 2 * HOUR) }, 'urgent');
    // E: private report in the lift area must not feed the hotspot list
    await mk(2, { tower: 'MR 1', category: 'lift', location_text: 'Lift 3', visibility: 'private' });
    for (const [id, inc] of [['p1', A.id], ['p2', B.id]] as const) {
      await db('uploads').insert({ id, user_id: 'u1', key: id, thumb_key: id, mime: 'image/jpeg', bytes: 1, kind: 'report', incident_id: inc, created_at: iso(now) });
    }

    const k = await communityKpis(db, cid, mergeSettings({}), {}, now);
    expect(k.counts.total).toBe(5);
    expect(k.resolution.verified_share).toBe(0.4);
    // first-time fix: A never reopened, C reopened once => 1 of 2
    expect(k.first_time_fix).toEqual({ verified_fixed: 2, never_reopened: 1, rate: 0.5 });
    // management closure took 4 days (A) and 1 day (C): median 2.5
    expect(k.closure_quality.median_days_to_management_close).toBe(2.5);
    // recurrence: A closed 95 days ago and B followed within 30 days; C (closed 38 days ago) has no repeat; its 60 and 90 day windows are not complete yet
    expect(k.recurrence).toEqual([
      { window_days: 30, eligible: 2, repeated: 1, rate: 0.5 },
      { window_days: 60, eligible: 1, repeated: 1, rate: 1 },
      { window_days: 90, eligible: 1, repeated: 1, rate: 1 },
    ]);
    // hotspots: A, B and D share MR 1 / Lift (B and D are still open); the private report and the single pool report are left out
    expect(k.hotspots).toEqual([{ tower: 'MR 1', area: 'Lift', total: 3, open: 2 }]);
    expect(JSON.stringify(k.hotspots)).not.toContain('214');
    // evidence: photo on A and B, case number on A, B, D, reply on A only, GPS on A and B
    expect(k.evidence).toEqual({ with_photo: 0.4, with_case_number: 0.6, with_management_reply: 0.2, with_gps: 0.4 });
    // safety-priority reply time
    expect(k.by_severity.find((x) => x.severity === 'urgent')!.median_ack_hours).toBe(2);
    expect(D.id).toBeTruthy();
    expect(C.id).toBeTruthy();

    // location text maps to general areas only
    expect(areaOf('Car park B2, near bay 214')).toBe('Car park');
    expect(areaOf('Waterfront walkway')).toBe('Waterfront / walkway');
    expect(areaOf('Inside my kitchen')).toBeNull();
    expect(areaOf(null)).toBeNull();
    await db.destroy();
  });
});

describe('version and system log', () => {
  it('serves the version publicly and keeps the watchtower endpoint locked', async () => {
    const { app, db, communityId } = await setup();
    const { buildInfo } = await import('../src/version');
    expect(buildInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
    const noSecret = await request(app).post('/api/inbound/watchtower').send({ title: 'x' });
    expect(noSecret.status).toBe(401);
    const { addSystemEvent, recordStart } = await import('../src/services/system');
    await recordStart(db);
    await addSystemEvent(db, { kind: 'watchtower', title: 'Found new image' });
    const staff = await makeStaff(db, communityId, 'admin', app);
    const res = await staff.agent.get('/api/admin/system');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['start', 'watchtower']));
    const r = await register(app);
    expect((await r.agent.get('/api/admin/system')).status).toBe(403);
  });
});

describe('no invite code', () => {
  it('holds every self sign-up for admin approval by default and ignores any invite code', async () => {
    const { mergeSettings } = await import('../src/domain');
    expect(mergeSettings('{}').require_approval).toBe(true);
    const c = await setup();
    await c.db('communities').where({ id: c.communityId }).update({ settings: JSON.stringify({ email_mode: 'platform' }) });
    const r = await request(c.app).post('/api/auth/register').set(H).send({ name: 'X Y', email: 'nocode@example.test', password: PASSWORD, tower: 'MR 1', unit: '5', consent: true, terms: true, invite_code: 'anything' });
    expect(r.status).toBe(202);
    expect(r.body.pending).toBe(true);
  });
});

describe('air tab (Home Assistant)', () => {
  const layout = JSON.stringify({
    outside: { temperature: 'sensor.outside_temp', humidity: 'sensor.outside_hum' },
    towers: [
      { name: 'MR 1', temperature: 'sensor.mr1_air_temp', humidity: 'sensor.mr1_air_hum' },
      { name: 'MR 2', temperature: 'sensor.mr2_air_temp', humidity: 'sensor.mr2_air_hum' },
    ],
  });
  const ha = config.homeAssistant;
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const states: Record<string, { state: string; last_updated: string; attributes?: object }> = {
    'sensor.outside_temp': { state: '104', last_updated: fresh, attributes: { unit_of_measurement: '°F' } },
    'sensor.outside_hum': { state: '65', last_updated: fresh, attributes: { unit_of_measurement: '%' } },
    'sensor.mr1_air_temp': { state: '24.46', last_updated: fresh, attributes: { unit_of_measurement: '°C' } },
    'sensor.mr1_air_hum': { state: '48', last_updated: fresh, attributes: { unit_of_measurement: '%' } },
    'sensor.mr2_air_temp': { state: 'unavailable', last_updated: fresh },
    'sensor.mr2_air_hum': { state: '51', last_updated: old, attributes: { unit_of_measurement: '%' } },
  };
  const seen: { url: string; auth: string }[] = [];
  const fake = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers.Authorization });
    const st = states[url.split('/api/states/')[1]];
    return st ? { ok: true, status: 200, json: async () => st } : { ok: false, status: 404, json: async () => ({}) };
  };
  const set = (url: string, token: string, sensors: string) => Object.assign(ha, { url, token, airSensors: sensors });
  const original = { ...ha };
  afterEach(() => {
    Object.assign(ha, original);
    clearAirCache();
    seen.length = 0;
  });

  it('is off unless URL, token and a valid layout are all set', async () => {
    expect((await getAir(fake)).enabled).toBe(false);
    set('http://ha.local:8123', 'tok', 'not json');
    expect((await getAir(fake)).enabled).toBe(false);
    set('http://ha.local:8123', '', layout);
    expect((await getAir(fake)).enabled).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('rejects entity ids that could change the request path', () => {
    expect(parseLayout(JSON.stringify({ towers: [{ name: 'A', temperature: '../config' }] }))).toBeNull();
    expect(parseLayout(JSON.stringify({ towers: [{ name: 'A', temperature: 'sensor.ok_1' }] }))).not.toBeNull();
  });

  it('reads each tower and the outside temperature, converting °F and flagging unavailable or old sensors', async () => {
    set('http://ha.local:8123/', 'secret-token', layout);
    clearAirCache();
    set('http://ha.local:8123', 'secret-token', layout);
    const a = await getAir(fake);
    expect(a.enabled).toBe(true);
    expect(a.outside!.temperature).toMatchObject({ value: 40, unit: '°C', stale: false });
    expect(a.outside!.humidity).toMatchObject({ value: 65, unit: '%', stale: false });
    expect(a.towers![0].temperature.updated_at).toBe(fresh);
    expect(a.towers![0].temperature).toMatchObject({ value: 24.5, unit: '°C', stale: false });
    expect(a.towers![0].humidity).toMatchObject({ value: 48, stale: false });
    expect(a.towers![1].temperature).toMatchObject({ value: null, stale: true });
    expect(a.towers![1].humidity).toMatchObject({ value: 51, stale: true });
    expect(seen.every((x) => x.auth === 'Bearer secret-token')).toBe(true);
    expect(seen).toHaveLength(6);
    await getAir(fake); // served from cache
    expect(seen).toHaveLength(6);
  });

  it('says so, and keeps old figures marked, when Home Assistant cannot be reached', async () => {
    set('http://ha.local:8123', 'tok', layout);
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    const first = await getAir(down);
    expect(first).toMatchObject({ enabled: true, unreachable: true });
    expect(first.towers![0].temperature.value).toBeNull();
  });


  /** Scripted stand-in for Home Assistant's WebSocket API (long-term statistics). */
  function fakeWs(opts: { token?: string; stats: Record<string, { start: number; end: number; mean?: number | null; state?: number | null }[]>; units?: Record<string, string> }) {
    const log: string[] = [];
    class FakeWs {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(public url: string) {
        log.push(url);
        setTimeout(() => this.emit({ type: 'auth_required' }), 0);
      }
      emit(m: object) {
        this.onmessage?.({ data: JSON.stringify(m) });
      }
      send(raw: string) {
        const m = JSON.parse(raw);
        log.push(m.type);
        if (m.type === 'auth') setTimeout(() => this.emit({ type: m.access_token === (opts.token ?? 'tok') ? 'auth_ok' : 'auth_invalid' }), 0);
        if (m.type === 'recorder/get_statistics_metadata') setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result: m.statistic_ids.map((id: string) => ({ statistic_id: id, unit_of_measurement: opts.units?.[id] ?? null })) }), 0);
        if (m.type === 'recorder/statistics_during_period') setTimeout(() => this.emit({ id: m.id, type: 'result', success: true, result: opts.stats }), 0);
      }
      close() {
        this.onclose = null;
      }
    }
    return { Ctor: FakeWs as unknown as WsCtor, log };
  }

  it('reads imported hourly statistics (tower1:name) over the WebSocket API and labels them hourly', async () => {
    const statLayout = JSON.stringify({ outside: { temperature: 'sensor.outside_temp' }, towers: [{ name: 'MR 1', temperature: 'tower1:fresh_air_temperature', humidity: 'tower1:fresh_air_humidity' }, { name: 'MR 3', temperature: 'sensor.mr1_air_temp', humidity: 'sensor.mr1_air_hum' }] });
    set('https://ha.local:8123', 'tok', statLayout);
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000; // last completed hour
    const { Ctor, log } = fakeWs({
      stats: {
        'tower1:fresh_air_temperature': [{ start: hour - 3_600_000, end: hour, mean: 24.0 }, { start: hour, end: hour + 3_600_000, mean: 25.46 }],
        'tower1:fresh_air_humidity': [{ start: hour, end: hour + 3_600_000, mean: 47.2 }, { start: hour + 3_600_000, end: hour + 7_200_000, mean: null }],
      },
      units: { 'tower1:fresh_air_temperature': '°C', 'tower1:fresh_air_humidity': '%' },
    });
    const a = await getAir(fake, Ctor);
    expect(a.towers![0].temperature).toMatchObject({ value: 25.5, unit: '°C', kind: 'hourly', stale: false, updated_at: new Date(hour).toISOString() });
    expect(a.towers![0].humidity).toMatchObject({ value: 47.2, unit: '%', kind: 'hourly' }); // empty last hour is skipped
    expect(a.towers![1].temperature).toMatchObject({ value: 24.5 }); // live sensors still read over REST
    expect(a.towers![1].temperature.kind).toBeUndefined();
    expect(log[0]).toBe('wss://ha.local:8123/api/websocket');
    expect(log).toContain('recorder/statistics_during_period');
    expect(seen.every((x) => !x.url.includes(':fresh_air'))).toBe(true); // statistics are never requested as REST entities
  });

  it('marks old imported statistics as old, and keeps live figures when the WebSocket fails', async () => {
    const statLayout = JSON.stringify({ towers: [{ name: 'MR 1', temperature: 'tower1:fresh_air_temperature', humidity: 'sensor.mr1_air_hum' }] });
    set('http://ha.local:8123', 'tok', statLayout);
    const oldHour = Date.now() - 10 * 3_600_000;
    const { Ctor } = fakeWs({ stats: { 'tower1:fresh_air_temperature': [{ start: oldHour, end: oldHour + 3_600_000, mean: 26 }] } });
    const a = await getAir(fake, Ctor);
    expect(a.towers![0].temperature).toMatchObject({ value: 26, stale: true, kind: 'hourly' });
    clearAirCache();
    const wrongToken = fakeWs({ token: 'other', stats: {} });
    const b = await getAir(fake, wrongToken.Ctor);
    expect(b.unreachable).toBe(true);
    expect(b.towers![0].temperature).toMatchObject({ value: null, stale: true });
    expect(b.towers![0].humidity).toMatchObject({ value: 48 }); // the live sensor is unaffected
  });

  it('can be switched off by an admin (nav flag false, endpoint reports switched off) and back on', async () => {
    set('http://ha.local:8123', 'secret-token', layout);
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const { agent } = await register(ctx.app);
    const patch = (v: boolean) => admin.agent.patch('/api/admin/settings').set(H).send({ settings: { aircon_enabled: v } });
    expect((await patch(false)).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.config.air_enabled).toBe(false);
    expect((await agent.get('/api/air')).body).toMatchObject({ enabled: false, switched_off: true });
    expect((await patch(true)).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.config.air_enabled).toBe(true);
    expect((await agent.get('/api/air')).body.enabled).toBe(true);
    expect((await admin.agent.get('/api/admin/settings')).body.aircon_available).toBe(true);
  });

  it('requires sign-in and never exposes the token, address or entity ids', async () => {
    set('http://ha.local:8123', 'secret-token', layout);
    expect((await request(ctx.app).get('/api/air')).status).toBe(401);
    const { agent } = await register(ctx.app);
    const me = await agent.get('/api/auth/me');
    expect(me.body.config.air_enabled).toBe(true);
    const res = await agent.get('/api/air');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/secret-token|ha\.local|sensor\./);
  });
});
