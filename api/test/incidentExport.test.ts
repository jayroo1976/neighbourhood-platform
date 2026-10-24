import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { incidentsXlsx, type ExportRow } from '../src/services/incidentExport';
import { createReport, makeStaff, register, setup } from './helpers';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});

const binary = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('incident export: Excel and CSV', () => {
  it('is admin only, audited, and gives a formatted workbook alongside the CSV', async () => {
    const admin = await makeStaff(ctx.db, ctx.communityId, 'admin', ctx.app);
    const resident = await register(ctx.app, { tower: 'MR 1', unit: '1204' });
    const made = await createReport(resident.agent, { title: '=HYPERLINK("http://x","click")', category: 'lift', severity: 'urgent' });

    expect((await resident.agent.get('/api/admin/export.xlsx')).status).toBe(403);
    expect((await resident.agent.get('/api/admin/export.csv')).status).toBe(403);
    const committee = await makeStaff(ctx.db, ctx.communityId, 'committee', ctx.app);
    expect((await committee.agent.get('/api/admin/export.xlsx')).status).toBe(403);
    expect((await committee.agent.get('/api/admin/export.csv')).status).toBe(403);

    const res = await admin.agent.get('/api/admin/export.xlsx').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="incidents-\d{4}-\d{2}-\d{2}\.xlsx"/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Reports']);
    const ws = wb.getWorksheet('Reports')!;
    expect(ws.getRow(1).values).toEqual(expect.arrayContaining(['Ref', 'Reported (Dubai time)', 'Status', 'Title']));
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();

    let found: ExcelJS.Row | undefined;
    ws.eachRow((row) => {
      if (row.getCell(1).value === made.ref) found = row;
    });
    expect(found).toBeTruthy();
    expect(found!.getCell(2).value).toBeInstanceOf(Date); // a real date, not text
    expect(found!.getCell(3).value).toBe('Lift'); // readable label, not the code
    expect(found!.getCell(4).value).toBe('Urgent');
    expect(found!.getCell(5).value).toBe('Reported');
    expect(found!.getCell(8).value).toBe('=HYPERLINK("http://x","click")'); // kept as text, never a formula
    expect(typeof found!.getCell(8).value).toBe('string');

    const csv = await admin.agent.get('/api/admin/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('ref,reported_at,category,severity,status,tower,unit,title,mgmt_case_number,emailed_at,case_number_at,mgmt_closed_at,resolved_at,resolution,reopen_count,management_closures,affects,linked_to,source');
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);

    const logged = (await ctx.db('audit_log').select('action')).map((a: { action: string }) => a.action);
    expect(logged).toContain('export_xlsx');
    expect(logged).toContain('export_csv');
  });

  it('builds a valid workbook with no reports, and counts the summary correctly', async () => {
    const empty = new ExcelJS.Workbook();
    await empty.xlsx.load((await incidentsXlsx('Test', [])) as never);
    expect(empty.getWorksheet('Reports')!.rowCount).toBe(1);

    const mk = (over: Partial<ExportRow>): ExportRow => ({
      ref: 'T-1', reported_at: '2026-10-01T06:00:00.000Z', category: 'lift', severity: 'normal', status: 'reported', tower: 'MR 1', unit: '1', title: 't', mgmt_case_number: null,
      emailed_at: null, case_number_at: null, mgmt_closed_at: null, resolved_at: null, resolution: null, reopen_count: 0, management_closures: 0, affects: 0, linked_to: '', source: 'app', ...over,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await incidentsXlsx('Test', [mk({}), mk({ ref: 'T-2', status: 'mgmt_closed', mgmt_closed_at: '2026-10-03T06:00:00.000Z' }), mk({ ref: 'T-3', status: 'resolved_ok', resolution: 'ok', resolved_at: '2026-10-11T06:00:00.000Z', reopen_count: 1 })], new Date('2026-10-20T06:00:00.000Z'))) as never);
    const sum = wb.getWorksheet('Summary')!;
    const text: Record<string, unknown> = {};
    sum.eachRow((r) => {
      if (typeof r.getCell(1).value === 'string') text[r.getCell(1).value as string] = r.getCell(2).value;
    });
    expect(text['All reports']).toBe(3);
    expect(text['Closed by management, not yet verified by a resident']).toBe(1);
    expect(text['Fixed (resident-verified)']).toBe(1);
    expect(text['Reports reopened at least once']).toBe(1);
    const rep = wb.getWorksheet('Reports')!;
    expect(rep.getRow(4).getCell(15).value).toBe(10); // T-3: 1 Oct to 11 Oct
    expect(rep.getRow(2).getCell(15).value).toBe(19); // T-1 still open: 1 Oct to 20 Oct
  });
});
