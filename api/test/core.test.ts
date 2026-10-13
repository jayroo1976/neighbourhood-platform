import { withPreview } from '../src/services/sharePreview';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/services/events';
import { deliverOutbox } from '../src/services/scheduler';
import { signFileLink, verifyFileLink, canonicalJson, passwordProblem } from '../src/security/crypto';
import { totpAt, verifyTotp } from '../src/security/totp';
import { extractCaseNumber } from '../src/services/incidents';
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
