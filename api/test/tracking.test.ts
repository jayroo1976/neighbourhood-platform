import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authVerdict, forwardedBlockDate, parseEmailDate, parseRfc822, resolveEventTime } from '../src/services/inboundMail';
import { findTrackingRefs, isValidTrackingRef, luhnMod36Check, makeTrackingRef } from '../src/services/trackingRef';
import { H, createReport, makeStaff, register, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
  const c = await ctx.db('communities').where({ id: ctx.communityId }).first();
  const st = JSON.parse(c.settings);
  await ctx.db('communities').where({ id: ctx.communityId }).update({
    settings: JSON.stringify({ ...st, tracking_mailbox: 'mrw@track.test', management_domains: ['mgmt.test'], include_other_reports_line: true }),
  });
});

const secret = { 'x-inbound-secret': 'test-inbound-secret' };
const track = (body: object) => request(ctx.app).post('/api/inbound/tracking').set(secret).send(body);
const pass = { spf: 'pass', dkim: 'pass', dmarc: 'pass' };

describe('tracking reference', () => {
  it('builds the documented example with check character K and catches typing errors', () => {
    expect(luhnMod36Check('MRW26100042')).toBe('K');
    expect(makeTrackingRef('MRW', '2026-10-12T08:00:00Z', 42)).toBe('MRW-2610-0042-K');
    expect(isValidTrackingRef('MRW-2610-0042-K')).toBe(true);
    expect(isValidTrackingRef('MRW-2610-0043-K')).toBe(false); // changed digit
    expect(isValidTrackingRef('MRW-2610-0024-K')).toBe(false); // swapped neighbours
    expect(findTrackingRefs('Re: Ref mrw-2610-0042-k and MRW-2610-0042-Z')).toEqual(['MRW-2610-0042-K']);
  });
});

describe('email dates', () => {
  it('keeps the sender offset and reads zone-less dates as Dubai time', () => {
    expect(parseEmailDate('Mon, 12 Oct 2026 09:15:00 +0400')).toEqual({ iso: '2026-10-12T05:15:00.000Z', offset: '+04:00' });
    expect(parseEmailDate('12 October 2026 09:15')?.iso).toBe('2026-10-12T05:15:00.000Z');
    expect(forwardedBlockDate('Hi\n\nFrom: Support <s@mgmt.test>\nSent: Sunday, 11 October 2026 14:30\nSubject: Ticket 123456 closed\n')?.iso).toBe('2026-10-11T10:30:00.000Z');
  });
  it('uses the best source and flags a date later than the receipt', () => {
    const received = '2026-10-12T10:00:00.000Z';
    expect(resolveEventTime({ originalHeaderDate: 'Mon, 12 Oct 2026 09:15:00 +0400', forwardHeaderDate: 'Mon, 12 Oct 2026 13:00:00 +0400', receivedAt: received }).source).toBe('original_header');
    expect(resolveEventTime({ forwardHeaderDate: 'Mon, 12 Oct 2026 13:00:00 +0400', receivedAt: received }).source).toBe('forward_header');
    expect(resolveEventTime({ receivedAt: received })).toMatchObject({ at: received, source: 'system' });
    expect(resolveEventTime({ originalHeaderDate: 'Wed, 14 Oct 2026 09:00:00 +0400', receivedAt: received }).skew).toBe(true);
  });
  it('reads authentication results and nested forwarded messages', () => {
    expect(authVerdict({ spf: 'pass', dkim: 'pass' })).toBe('pass');
    expect(authVerdict({ spf: 'fail', dkim: 'pass' })).toBe('fail');
    expect(authVerdict(undefined)).toBe('unknown');
    const raw = ['From: a@x.test', 'Subject: Fwd: x', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'See attached', '--B', 'Content-Type: message/rfc822', '', 'From: s@mgmt.test', 'Date: Sun, 11 Oct 2026 14:30:00 +0400', 'Subject: Closed', '', 'Ticket closed', '--B--', ''].join('\r\n');
    const m = parseRfc822(raw);
    expect(m.text).toBe('See attached');
    expect(m.attached[0].headers['date']).toContain('11 Oct 2026');
    expect(m.attached[0].text).toBe('Ticket closed');
  });
});

describe('tracking mailbox', () => {
  it('puts the tracking mailbox on Cc, uses the standard wording and gives each resident their own reference', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '301', name: 'Amira Test' });
    const b = await register(ctx.app, { tower: 'MR 2', unit: '402', name: 'Ben Test' });
    const created = await createReport(a.agent, { title: 'Corridor light out on level 3' });
    await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ ...JSON.parse((await ctx.db('communities').where({ id: ctx.communityId }).first()).settings), email_mode: 'resident', require_photo_for_affects: false }) });
    const d1 = (await a.agent.get(`/api/incidents/${created.id}/email-draft`)).body;
    expect(d1.cc).toBe('mrw@track.test');
    expect(d1.subject).toContain(`Ref ${d1.ref}`);
    expect(d1.body).toContain('This report is being tracked. Please quote the reference above in any reply so it can be matched to this report.');
    expect(d1.body).not.toMatch(/neighbourhood|platform|formal notice/i);
    await b.agent.post(`/api/incidents/${created.id}/affects`).set(H).send({});
    const d2 = (await b.agent.get(`/api/incidents/${created.id}/email-draft`)).body;
    expect(d2.ref).not.toBe(d1.ref);
    expect(isValidTrackingRef(d2.ref)).toBe(true);
    expect(d2.body).toContain('Other residents have also reported this issue: 1.');
  });

  it('links the Cc copy by reference, takes the time from the email and records when it was received', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '311', email: 'amira.cc@example.test' });
    const created = await createReport(a.agent, { title: 'Broken bench by the pool' });
    const ref = created.ref;
    const res = await track({ from: 'Amira <amira.cc@example.test>', subject: `Community – Cleaning – Pool – Ref ${ref}`, date: 'Mon, 12 Oct 2026 08:05:00 +0400', message_id: '<cc-1@mail.test>', text: `Reference: ${ref}`, auth: pass });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('linked');
    expect(res.body.event_at).toBe('2026-10-12T04:05:00.000Z');
    expect(res.body.event_at_source).toBe('original_header');
    const detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.emailed_at).toBe('2026-10-12T04:05:00.000Z');
    const ev = detail.events.find((e: { type: string }) => e.type === 'email_linked');
    expect(ev.at).toBe('2026-10-12T04:05:00.000Z');
    expect(ev.payload.received_at).toBeTruthy();
    expect(ev.payload.snippet).toBeUndefined(); // a resident's own text is not shown on the timeline
    // same message again is ignored
    expect((await track({ from: 'amira.cc@example.test', subject: ref, message_id: '<cc-1@mail.test>', text: ref, auth: pass })).body.status).toBe('duplicate');
  });

  it('accepts a management reply only from a management domain, with passing authentication, matching a case', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '321' });
    const created = await createReport(a.agent, { title: 'Gym treadmill not working' });
    const body = { from: 'Support <noreply@mgmt.test>', subject: `Re: Ref ${created.ref}`, date: 'Tue, 13 Oct 2026 10:00:00 +0400', text: 'Ticket No. 00867684 has been created.', auth: pass };
    const bad = await track({ ...body, message_id: '<m-1@mgmt.test>', auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } });
    expect(bad.body.status).toBe('review');
    expect(bad.body.reason).toBe('sender_not_verified');
    const ok = await track({ ...body, message_id: '<m-2@mgmt.test>' });
    expect(ok.body.status).toBe('linked');
    const detail = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(detail.mgmt_case_number).toBe('00867684');
    expect(detail.status).toBe('case_number_received');
    const ev = detail.events.find((e: { type: string; payload: any }) => e.type === 'email_linked' && e.payload.direction === 'management_message');
    expect(ev.payload.snippet).toContain('Ticket No. 00867684');
    // a stranger domain claiming the same reference is not trusted
    const spoof = await track({ ...body, from: 'x@evil.test', message_id: '<m-3@evil.test>' });
    expect(spoof.body.status).toBe('review');
    expect(spoof.body.reason).toBe('sender_not_a_member');
  });

  it('matches a resident forward by management ticket number and takes the date from the forwarded text', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '331', email: 'fwd.res@example.test' });
    const created = await createReport(a.agent, { title: 'Leak in the bin room' });
    await request(ctx.app).post('/api/inbound/tracking').set(secret).send({ from: 'mgmt@mgmt.test', subject: `Ref ${created.ref}`, text: 'Ticket No. 77001122 created', message_id: '<seed@mgmt.test>', auth: pass });
    const text = 'FYI\n\nFrom: Support <noreply@mgmt.test>\nSent: Monday, 12 October 2026 16:45\nSubject: Ticket 77001122 closed\n\nTicket No. 77001122 is now closed.';
    const res = await track({ from: 'fwd.res@example.test', subject: 'Fwd: Ticket 77001122 closed', date: 'Tue, 13 Oct 2026 09:00:00 +0400', message_id: '<f-1@mail.test>', text, auth: pass });
    expect(res.body.status).toBe('linked');
    expect(res.body.event_at_source).toBe('forwarded_text');
    expect(res.body.event_at).toBe('2026-10-12T12:45:00.000Z');
  });

  it('holds unmatched mail and two-reference mail for review and lets an admin assign it', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '341' });
    const c1 = await createReport(a.agent, { title: 'First thing broken' });
    const c2 = await createReport(a.agent, { title: 'Second thing broken' });
    const two = await track({ from: 'x@example.test', subject: `${c1.ref} ${c2.ref}`, text: 'both', message_id: '<two@x.test>', auth: pass });
    expect(two.body.reason).toBe('more_than_one_reference');
    const none = await track({ from: 'x@example.test', subject: 'hello', text: 'nothing here', message_id: '<none@x.test>', auth: pass });
    expect(none.body.status).toBe('review');
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const list = (await admin.agent.get('/api/admin/inbound')).body.items;
    expect(list.length).toBeGreaterThanOrEqual(2);
    const target = list.find((i: { reason: string }) => i.reason === 'no_match');
    const assign = await admin.agent.post(`/api/admin/inbound/${target.id}/assign`).set(H).send({ incident_id: c1.id });
    expect(assign.status).toBe(200);
    const after = (await admin.agent.get('/api/admin/inbound')).body.items;
    expect(after.find((i: { id: string }) => i.id === target.id)).toBeUndefined();
    const detail = (await admin.agent.get(`/api/admin/incidents/${c1.id}`)).body;
    expect(detail.events.some((e: { type: string }) => e.type === 'email_linked')).toBe(true);
  });

  it('requires the shared secret', async () => {
    expect((await request(ctx.app).post('/api/inbound/tracking').send({ text: 'x' })).status).toBe(401);
  });
});

describe('closure details', () => {
  it('flags a closure with no details, accepts details later and drafts the follow-up', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '351', name: 'Cara Test' });
    const created = await createReport(a.agent, { title: 'Water pressure low' });
    const closed = await a.agent.post(`/api/incidents/${created.id}/status`).set(H).send({ to: 'mgmt_closed' });
    expect(closed.status).toBe(200);
    let d = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(d.closure_details_missing).toBe(true);
    const fu = (await a.agent.get(`/api/incidents/${created.id}/followup-draft`)).body;
    expect(fu.body).toContain('1. the cause of the issue,');
    expect(fu.body).toContain('This report is being tracked.');
    expect(fu.cc).toBe('mrw@track.test');
    expect(fu.subject).toContain(`Ref ${created.ref}`);
    await a.agent.post(`/api/incidents/${created.id}/closure-details`).set(H).send({ text: 'Pump replaced' });
    d = (await a.agent.get(`/api/incidents/${created.id}`)).body;
    expect(d.closure_details_missing).toBe(false);
  });
});
