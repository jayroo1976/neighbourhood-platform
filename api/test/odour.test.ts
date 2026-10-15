import { beforeAll, describe, expect, it } from 'vitest';
import { createOdourReport, homeLabel, unitType } from '../src/services/odour';
import { H, makeStaff, register, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});

const body = (over: Record<string, unknown> = {}) => ({
  building: 'MR 1',
  level: 7,
  flat: 4,
  smell_type: 'sewage',
  strength: 3,
  frequency: 'daily',
  where_noticed: 'inside',
  notes: '',
  ...over,
});

async function setSettings(patch: Record<string, unknown>) {
  const row = await ctx.db('communities').where({ id: ctx.communityId }).first();
  await ctx.db('communities').where({ id: ctx.communityId }).update({ settings: JSON.stringify({ ...JSON.parse(row.settings), ...patch }) });
}

describe('smell reports: flat plan', () => {
  it('maps flat numbers to the types on the floor plan', () => {
    const t = (flat: number, level = 5) => unitType({ kind: 'tower', level, flat });
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((f) => t(f))).toEqual(['D', 'C', 'C', 'C', 'B', 'A', 'B', 'C', 'C', 'C', 'D']);
    expect(t(3, 14)).toBe('G1');
    expect(unitType({ kind: 'townhouse', level: 0, flat: 4 })).toBe('TH');
    expect(homeLabel({ kind: 'tower', level: 7, flat: 4 })).toBe('Level 7, flat 4');
    expect(homeLabel({ kind: 'tower', level: 14, flat: 5 })).toBe('Penthouse H');
    expect(homeLabel({ kind: 'townhouse', level: 0, flat: 4 })).toBe('No. 4');
  });
});

describe('smell reports: logging', () => {
  it('requires sign-in and the request header, and lists the buildings from the community settings', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '701' });
    const anon = (await import('supertest')).default(ctx.app);
    expect((await anon.post('/api/odour').set(H).send(body())).status).toBe(401);
    expect((await a.agent.post('/api/odour').send(body())).status).toBe(403);
    const opts = (await a.agent.get('/api/odour/options')).body;
    expect(opts.enabled).toBe(true);
    expect(opts.towers).toEqual(['MR 1', 'MR 2', 'MR 3']);
    expect(opts.townhouses).toEqual(['Townhouse 1', 'Townhouse 2', 'Townhouse 3']);
    expect(opts.flat_types['6']).toBe('A');
  });

  it('accepts a tower flat, a penthouse and a townhouse, and rejects impossible homes', async () => {
    const a = await register(ctx.app, { tower: 'MR 2', unit: '702' });
    const ok = await a.agent.post('/api/odour').set(H).send(body({ building: 'MR 2', level: 13, flat: 11 }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ building: 'MR 2', level: 13, flat: 11, unit_type: 'D', home: 'Level 13, flat 11' });
    expect((await a.agent.post('/api/odour').set(H).send(body({ level: 14, flat: 5 }))).body).toMatchObject({ unit_type: 'H', home: 'Penthouse H' });
    expect((await a.agent.post('/api/odour').set(H).send(body({ building: 'Townhouse 2', level: 0, flat: 4 }))).body).toMatchObject({ kind: 'townhouse', unit_type: 'TH' });

    const bad = async (over: Record<string, unknown>) => (await a.agent.post('/api/odour').set(H).send(body(over))).status;
    expect(await bad({ building: 'MR 9' })).toBe(400); // not a tower of this community
    expect(await bad({ building: 'Townhouse 4' })).toBe(400); // block not switched on
    expect(await bad({ level: 0 })).toBe(400);
    expect(await bad({ level: 15 })).toBe(400);
    expect(await bad({ flat: 12 })).toBe(400); // only 11 flats a level
    expect(await bad({ level: 14, flat: 6 })).toBe(400); // only 5 penthouses
    expect(await bad({ building: 'Townhouse 1', level: 0, flat: 41 })).toBe(400);
    expect(await bad({ smell_type: 'perfume' })).toBe(400);
    expect(await bad({ strength: 5 })).toBe(400);
    expect(await bad({ observed_at: new Date(Date.now() + 3_600_000).toISOString() })).toBe(400); // future
    expect(await bad({ observed_at: new Date(Date.now() - 400 * 86_400_000).toISOString() })).toBe(400); // too old
    expect(await bad({ notes: 'x'.repeat(281) })).toBe(400);
  });

  it('enforces a daily limit that deleting a report does not reset', async () => {
    await setSettings({ odour_max_per_day: 2 });
    const a = await register(ctx.app, { tower: 'MR 3', unit: '703' });
    const first = await a.agent.post('/api/odour').set(H).send(body({ building: 'MR 3' }));
    expect(first.status).toBe(201);
    expect((await a.agent.post('/api/odour').set(H).send(body({ building: 'MR 3', flat: 5 }))).status).toBe(201);
    expect((await a.agent.delete(`/api/odour/${first.body.id}`).set(H)).status).toBe(200);
    const third = await a.agent.post('/api/odour').set(H).send(body({ building: 'MR 3', flat: 6 }));
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('rate_limited');
    await setSettings({ odour_max_per_day: 10 });
  });

  it('lets a resident see and remove only their own reports', async () => {
    const a = await register(ctx.app, { tower: 'MR 1', unit: '704' });
    const b = await register(ctx.app, { tower: 'MR 1', unit: '705' });
    const mine = await a.agent.post('/api/odour').set(H).send(body({ level: 9, flat: 2, notes: 'a-only-note' }));
    expect((await b.agent.delete(`/api/odour/${mine.body.id}`).set(H)).status).toBe(404);
    const listA = (await a.agent.get('/api/odour/mine')).body.items;
    expect(listA.some((i: { id: string; home: string }) => i.id === mine.body.id && i.home === 'Level 9, flat 2')).toBe(true);
    const listB = (await b.agent.get('/api/odour/mine')).body.items;
    expect(listB.some((i: { id: string }) => i.id === mine.body.id)).toBe(false);
    expect((await a.agent.delete(`/api/odour/${mine.body.id}`).set(H)).status).toBe(200);
    expect((await ctx.db('odour_reports').where({ id: mine.body.id }).first()).notes).toBe(''); // note erased, row kept for the daily limit
    expect((await a.agent.get('/api/odour/mine')).body.items.some((i: { id: string }) => i.id === mine.body.id)).toBe(false);
  });
});

describe('smell reports: what neighbours can see', () => {
  it('shows building and level-band counts only, hides small counts, and never exposes a flat or a note', async () => {
    await setSettings({ odour_max_per_day: 50 });
    const reporter = await register(ctx.app, { tower: 'MR 2', unit: '8801' });
    const neighbour = await register(ctx.app, { tower: 'MR 2', unit: '8802' });
    // two reports on levels 5-8 (below the group minimum of 3), three on levels 9-13
    await reporter.agent.post('/api/odour').set(H).send(body({ building: 'MR 2', level: 6, flat: 8, notes: 'secret-note-8801' }));
    await reporter.agent.post('/api/odour').set(H).send(body({ building: 'MR 2', level: 7, flat: 8 }));
    for (const lvl of [9, 10, 11]) await reporter.agent.post('/api/odour').set(H).send(body({ building: 'MR 2', level: lvl, flat: 3, smell_type: 'cooking' }));

    const res = await neighbour.agent.get('/api/odour/summary?days=30');
    expect(res.status).toBe(200);
    const mr2 = res.body.buildings.find((b: { name: string }) => b.name === 'MR 2');
    const band = (id: string) => mr2.bands.find((x: { id: string }) => x.id === id);
    expect(band('5-8')).toMatchObject({ count: null, few: true });
    expect(band('9-13').few).toBe(false);
    expect(band('9-13').count).toBeGreaterThanOrEqual(3); // earlier tests in this file also log on level 13
    expect(band('1-4')).toMatchObject({ count: 0, few: false });
    expect(mr2.reports).toBeGreaterThanOrEqual(5);
    expect(res.body.buildings.find((b: { name: string }) => b.name === 'MR 3')).toMatchObject({ few: true, reports: null, homes: null, by_type: {} }); // one report in MR 3 so far: withheld
    expect(mr2.by_type.cooking).toBeGreaterThanOrEqual(3);
    expect(res.body.by_hour).toHaveLength(24);

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('secret-note-8801');
    expect(text).not.toContain('8801');
    expect(text).not.toMatch(/"level"|"flat"|"notes"|"unit"|"home"/);
    expect(res.body.mine).toBe(0);
    expect((await reporter.agent.get('/api/odour/summary?days=30')).body.mine).toBeGreaterThanOrEqual(5);
  });
});

describe('smell reports: admin view', () => {
  it('is admin only, shows the exact flat, exports a safe CSV and records deletions in the audit log', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const committee = await makeStaff(ctx.db, ctx.communityId, 'committee', ctx.app);
    const resident = await register(ctx.app, { tower: 'MR 1', unit: '9901' });
    const made = await resident.agent.post('/api/odour').set(H).send(body({ building: 'MR 1', level: 12, flat: 10, notes: '=HYPERLINK("http://x")' }));

    expect((await resident.agent.get('/api/admin/odour')).status).toBe(403);
    expect((await committee.agent.get('/api/admin/odour')).status).toBe(403);
    expect((await resident.agent.get('/api/admin/odour/export.csv')).status).toBe(403);

    const list = await admin.agent.get('/api/admin/odour');
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: string }) => i.id === made.body.id);
    expect(item).toMatchObject({ building: 'MR 1', level: 12, flat: 10, home: 'Level 12, flat 10', unit_type: 'C' });
    expect(list.body.options.towers).toContain('MR 1');
    expect(JSON.stringify(list.body)).not.toContain('9901'); // no profile data, no names

    const csv = await admin.agent.get('/api/admin/odour/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('observed_at,building,level,flat,unit_type,smell_type,strength,where_noticed,frequency,notes,reported_at');
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);

    const filtered = await admin.agent.get('/api/admin/odour?type=cooking&days=1');
    expect(filtered.body.items.every((i: { smell_type: string }) => i.smell_type === 'cooking')).toBe(true);

    expect((await admin.agent.delete(`/api/admin/odour/${made.body.id}`).set(H)).status).toBe(200);
    expect((await admin.agent.get('/api/admin/odour')).body.items.some((i: { id: string }) => i.id === made.body.id)).toBe(false);
    expect((await admin.agent.delete(`/api/admin/odour/${made.body.id}`).set(H)).status).toBe(404);
    const audit = await ctx.db('audit_log').where({ action: 'odour_delete', target_id: made.body.id }).first();
    expect(audit).toBeTruthy();
  });

  it('lets an admin change the townhouse blocks and the daily limit in settings', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const resident = await register(ctx.app, { tower: 'MR 1', unit: '9902' });
    const r = await admin.agent.patch('/api/admin/settings').set(H).send({ settings: { odour_townhouse_blocks: [1, 2, 3, 4], odour_townhouse_units: 9, odour_max_per_day: 12 } });
    expect(r.status).toBe(200);
    expect((await resident.agent.post('/api/odour').set(H).send(body({ building: 'Townhouse 4', level: 0, flat: 2 }))).status).toBe(201);
    expect((await resident.agent.get('/api/odour/options')).body.max_per_day).toBe(12);
    expect((await resident.agent.get('/api/odour/options')).body.townhouse_max_unit).toBe(9);
    expect((await resident.agent.post('/api/odour').set(H).send(body({ building: 'Townhouse 4', level: 0, flat: 10 }))).status).toBe(400); // beyond the 9 units set for a block
    expect((await admin.agent.patch('/api/admin/settings').set(H).send({ settings: { odour_townhouse_units: 99 } })).status).toBe(400);
    await admin.agent.patch('/api/admin/settings').set(H).send({ settings: { odour_townhouse_blocks: [1, 2, 3], odour_townhouse_units: 7, odour_max_per_day: 10 } });
  });
});

describe('smell reports: switch off, export, erasure, demo wipe', () => {
  it('can be switched off: residents are told, nav flag goes false, admins still see the data', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const resident = await register(ctx.app, { tower: 'MR 3', unit: '9903' });
    await resident.agent.post('/api/odour').set(H).send(body({ building: 'MR 3' }));
    await setSettings({ odour_enabled: false });
    expect((await resident.agent.post('/api/odour').set(H).send(body({ building: 'MR 3' }))).status).toBe(404);
    expect((await resident.agent.get('/api/odour/summary')).status).toBe(404);
    expect((await resident.agent.get('/api/odour/options')).body.enabled).toBe(false);
    expect((await resident.agent.get('/api/auth/me')).body.config.odour_enabled).toBe(false);
    expect((await admin.agent.get('/api/admin/odour')).status).toBe(200);
    await setSettings({ odour_enabled: true });
    expect((await resident.agent.get('/api/auth/me')).body.config.odour_enabled).toBe(true);
  });

  it('includes smell reports in a resident data export and removes them when the account is erased', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const resident = await register(ctx.app, { tower: 'MR 1', unit: '9904' });
    const made = await resident.agent.post('/api/odour').set(H).send(body({ level: 3, flat: 1 }));
    const exp = (await resident.agent.get('/api/me/export')).body;
    expect(exp.smell_reports).toHaveLength(1);
    expect(exp.smell_reports[0]).toMatchObject({ building: 'MR 1', level: 3, flat: 1 });
    expect((await resident.agent.post('/api/me/delete').set(H).send({ password: 'Correct-Horse-Battery-9', withdraw_reports: false })).status).toBe(200);
    expect((await admin.agent.get('/api/admin/odour')).body.items.some((i: { id: string }) => i.id === made.body.id)).toBe(false);
    expect(await ctx.db('odour_reports').where({ id: made.body.id }).first()).toBeUndefined();
  });

  it('removes demo smell reports with the demo data', async () => {
    const sa = await makeStaff(ctx.db, ctx.communityId, 'super_admin', ctx.app);
    const demoId = crypto.randomUUID();
    await ctx.db('users').insert({ id: demoId, community_id: ctx.communityId, email: 'demo-odour@pilot.test', password_hash: 'x', name: 'Demo', role: 'resident', tower: 'MR 1', unit: '1', is_demo: 1, created_at: new Date().toISOString() });
    const row = await createOdourReport(ctx.db, { id: demoId, community_id: ctx.communityId }, { building: 'MR 1', level: 2, flat: 2, smell_type: 'damp', strength: 2, frequency: 'once', where_noticed: 'inside' }, { source: 'demo' });
    expect((await sa.agent.get('/api/admin/odour')).body.items.some((i: { id: string }) => i.id === row.id)).toBe(true);
    expect((await sa.agent.post('/api/admin/demo/wipe').set(H)).status).toBe(200);
    expect(await ctx.db('odour_reports').where({ id: row.id }).first()).toBeUndefined();
  });
});
