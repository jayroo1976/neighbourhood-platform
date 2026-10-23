import ExcelJS from 'exceljs';
import type { Db } from '../db';
import { CATEGORY_LABELS, DUBAI_UTC_OFFSET_HOURS, OPEN_STATUSES, STATUSES, type Category } from '../domain';
import { affectsCounts } from './serializers';

/**
 * Incident export for admins: the same rows as a CSV (raw values, for re-importing or scripts) and as a formatted
 * Excel workbook (readable labels, real dates in Dubai time, filters, colour-coded status, a summary sheet).
 * No resident name or email is exported, and no report text beyond the title.
 */

export const EXPORT_HEAD = ['ref', 'reported_at', 'category', 'severity', 'status', 'tower', 'unit', 'title', 'mgmt_case_number', 'emailed_at', 'case_number_at', 'mgmt_closed_at', 'resolved_at', 'resolution', 'reopen_count', 'management_closures', 'affects', 'linked_to', 'source'];

export interface ExportRow {
  ref: string;
  reported_at: string;
  category: string;
  severity: string;
  status: string;
  tower: string | null;
  unit: string | null;
  title: string;
  mgmt_case_number: string | null;
  emailed_at: string | null;
  case_number_at: string | null;
  mgmt_closed_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  reopen_count: number;
  management_closures: number;
  affects: number;
  linked_to: string;
  source: string;
}

export async function incidentExportRows(db: Db, communityId: string): Promise<ExportRow[]> {
  const rows = await db('incidents').where({ community_id: communityId }).orderBy('seq');
  const counts = await affectsCounts(db, rows.map((x) => x.id));
  const byId = new Map<string, string>(rows.map((x) => [x.id, x.ref]));
  return rows.map((x) => ({
    ref: x.ref,
    reported_at: x.reported_at,
    category: x.category,
    severity: x.severity,
    status: x.status,
    tower: x.tower,
    unit: x.unit,
    title: x.title,
    mgmt_case_number: x.mgmt_case_number,
    emailed_at: x.emailed_at,
    case_number_at: x.case_number_at,
    mgmt_closed_at: x.mgmt_closed_at,
    resolved_at: x.resolved_at,
    resolution: x.resolution,
    reopen_count: x.reopen_count,
    management_closures: x.mgmt_closed_count,
    affects: counts.get(x.id) ?? 0,
    linked_to: x.cluster_id ? byId.get(x.cluster_id) ?? '' : '',
    source: x.source,
  }));
}

/** CSV cell that cannot be read as a spreadsheet formula. */
const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function incidentsCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_HEAD.join(',')];
  for (const r of rows) lines.push(EXPORT_HEAD.map((k) => cell((r as unknown as Record<string, unknown>)[k])).join(','));
  return lines.join('\n');
}

const STATUS_LABELS: Record<string, string> = {
  reported: 'Reported',
  case_number_received: 'Case no. received',
  in_progress: 'In progress',
  mgmt_closed: 'Closed by mgmt - unverified',
  resolved_ok: 'Fixed',
  resolved_poor: 'Closed - poorly fixed',
  reopened: 'Reopened',
  withdrawn: 'Withdrawn',
};
const STATUS_FILL: Record<string, string> = {
  reported: 'FFDCEAF3',
  case_number_received: 'FFD6E8E4',
  in_progress: 'FFD6E8E4',
  mgmt_closed: 'FFFBE7BD',
  resolved_ok: 'FFDDEFE3',
  resolved_poor: 'FFF6D6D1',
  reopened: 'FFF6D6D1',
  withdrawn: 'FFE8E4DA',
};
const SEVERITY_LABELS: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const SEVERITY_FILL: Record<string, string> = { high: 'FFFBE7BD', urgent: 'FFF6D6D1' };
const SOURCE_LABELS: Record<string, string> = { app: 'App', import: 'Imported', demo: 'Demo', email: 'Email' };

const TEAL = 'FF0F4C4C';
const SAND = 'FFF4ECDC';
const thin = { style: 'thin' as const, color: { argb: 'FFE0D6BF' } };

/** Excel has no time zones, so a date is stored as the Dubai wall-clock time and the header says so. */
const dubai = (iso: string | null): Date | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + DUBAI_UTC_OFFSET_HOURS * 3_600_000) : null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

export async function incidentsXlsx(communityName: string, rows: ExportRow[], now = new Date()): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = communityName;
  wb.created = now;
  wb.title = `Incident reports - ${communityName}`;

  // ---------------- Summary ----------------
  const sum = wb.addWorksheet('Summary', { views: [{ showGridLines: false }], properties: { tabColor: { argb: TEAL } } });
  sum.columns = [{ width: 62 }, { width: 12 }];
  sum.mergeCells('A1:B1');
  const t = sum.getCell('A1');
  t.value = `Incident reports - ${communityName}`;
  t.font = { name: 'Georgia', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
  t.alignment = { vertical: 'middle', indent: 1 };
  sum.getRow(1).height = 34;
  sum.getCell('A2').value = `Generated ${stamp(dubai(now.toISOString())!)} Dubai time. ${rows.length} ${rows.length === 1 ? 'report' : 'reports'} in total.`;
  sum.getCell('A2').font = { size: 9, color: { argb: 'FF667373' } };

  let r = 4;
  const block = (title: string, entries: [string, number][]) => {
    const h = sum.getRow(r);
    h.getCell(1).value = title;
    h.getCell(2).value = 'Reports';
    for (const c of [1, 2]) {
      h.getCell(c).font = { bold: true, color: { argb: TEAL } };
      h.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    }
    h.getCell(2).alignment = { horizontal: 'right' };
    r++;
    for (const [label, n] of entries) {
      sum.getCell(r, 1).value = label;
      sum.getCell(r, 2).value = n;
      sum.getCell(r, 2).alignment = { horizontal: 'right' };
      for (const c of [1, 2]) sum.getCell(r, c).border = { bottom: thin };
      r++;
    }
    r++;
  };
  const tally = (key: (x: ExportRow) => string) => {
    const m = new Map<string, number>();
    for (const x of rows) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
  };
  const open = rows.filter((x) => (OPEN_STATUSES as string[]).includes(x.status)).length;
  block('Overview', [
    ['All reports', rows.length],
    ['Open (reported, case no. received, in progress, reopened)', open],
    ['Closed by management, not yet verified by a resident', rows.filter((x) => x.status === 'mgmt_closed').length],
    ['Fixed (resident-verified)', rows.filter((x) => x.status === 'resolved_ok').length],
    ['Closed but poorly fixed', rows.filter((x) => x.status === 'resolved_poor').length],
    ['Reports reopened at least once', rows.filter((x) => x.reopen_count > 0).length],
  ]);
  const byStatus = tally((x) => x.status);
  block('By status', STATUSES.map((s) => [STATUS_LABELS[s], byStatus.get(s) ?? 0] as [string, number]).filter((e) => e[1] > 0));
  const byCat = tally((x) => x.category);
  block('By category', [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [CATEGORY_LABELS[k as Category] ?? k, n] as [string, number]));
  const byTower = tally((x) => x.tower || 'Not stated');
  block('By tower', [...byTower.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  const notes = [
    'About these figures',
    'A report is Fixed only when a resident has confirmed it with photo evidence (or an admin has overridden it with a note). A report that management has closed is shown separately until then.',
    'Dates and times on the Reports sheet are Dubai time (UTC+4). "Age" is the number of days from the report to its resolution, or to the time of this export if it is not resolved.',
    'Each resident’s report is counted separately, even when several residents report the same fault. "Also affected" counts residents who added "this affects me too".',
  ];
  notes.forEach((n, k) => {
    sum.mergeCells(r, 1, r, 2);
    const c = sum.getCell(r, 1);
    c.value = n;
    c.alignment = { wrapText: true, vertical: 'top' };
    c.font = k === 0 ? { bold: true, color: { argb: TEAL } } : { size: 9, color: { argb: 'FF667373' } };
    if (k > 0) sum.getRow(r).height = 40;
    r++;
  });

  sum.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  // ---------------- Reports ----------------
  const ws = wb.addWorksheet('Reports', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }], properties: { tabColor: { argb: 'FF176666' } } });
  const cols: { header: string; key: string; width: number; fmt?: string; wrap?: boolean; align?: 'left' | 'center' | 'right' }[] = [
    { header: 'Ref', key: 'ref', width: 16 },
    { header: 'Reported (Dubai time)', key: 'reported', width: 19, fmt: 'dd mmm yyyy hh:mm' },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Severity', key: 'severity', width: 10, align: 'center' },
    { header: 'Status', key: 'status', width: 26 },
    { header: 'Tower', key: 'tower', width: 9 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Title', key: 'title', width: 48, wrap: true },
    { header: 'Mgmt case no.', key: 'case', width: 15 },
    { header: 'Emailed to mgmt', key: 'emailed', width: 19, fmt: 'dd mmm yyyy hh:mm' },
    { header: 'Case no. received', key: 'caseAt', width: 19, fmt: 'dd mmm yyyy hh:mm' },
    { header: 'Closed by mgmt', key: 'closed', width: 19, fmt: 'dd mmm yyyy hh:mm' },
    { header: 'Resolved', key: 'resolved', width: 19, fmt: 'dd mmm yyyy hh:mm' },
    { header: 'Outcome', key: 'outcome', width: 14 },
    { header: 'Age (days)', key: 'age', width: 10, fmt: '0', align: 'right' },
    { header: 'Reopened (times)', key: 'reopen', width: 11, fmt: '0', align: 'right' },
    { header: 'Mgmt closures', key: 'closures', width: 11, fmt: '0', align: 'right' },
    { header: 'Also affected', key: 'affects', width: 10, fmt: '0', align: 'right' },
    { header: 'Linked to', key: 'linked', width: 16 },
    { header: 'Source', key: 'source', width: 10 },
  ];
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 32;
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    c.border = { bottom: { style: 'medium', color: { argb: 'FF0A3535' } } };
  });

  for (const x of rows) {
    const endMs = Date.parse(x.resolved_at ?? now.toISOString());
    const startMs = Date.parse(x.reported_at);
    const age = Number.isFinite(endMs) && Number.isFinite(startMs) ? Math.max(0, Math.floor((endMs - startMs) / 86_400_000)) : null;
    const row = ws.addRow({
      ref: x.ref,
      reported: dubai(x.reported_at),
      category: CATEGORY_LABELS[x.category as Category] ?? x.category,
      severity: SEVERITY_LABELS[x.severity] ?? x.severity,
      status: STATUS_LABELS[x.status] ?? x.status,
      tower: x.tower ?? '',
      unit: x.unit ?? '',
      title: x.title,
      case: x.mgmt_case_number ?? '',
      emailed: dubai(x.emailed_at),
      caseAt: dubai(x.case_number_at),
      closed: dubai(x.mgmt_closed_at),
      resolved: dubai(x.resolved_at),
      outcome: x.resolution === 'ok' ? 'Fixed' : x.resolution === 'poor' ? 'Poorly fixed' : '',
      age,
      reopen: x.reopen_count,
      closures: x.management_closures,
      affects: x.affects,
      linked: x.linked_to,
      source: SOURCE_LABELS[x.source] ?? x.source,
    });
    row.alignment = { vertical: 'top' };
    cols.forEach((c, k) => {
      const cl = row.getCell(k + 1);
      if (c.fmt) cl.numFmt = c.fmt;
      cl.alignment = { vertical: 'top', horizontal: c.align ?? 'left', wrapText: !!c.wrap };
      cl.border = { bottom: thin };
    });
    const st = STATUS_FILL[x.status];
    if (st) row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st } };
    const sv = SEVERITY_FILL[x.severity];
    if (sv) row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sv } };
    if (x.severity === 'urgent') row.getCell(4).font = { bold: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1', margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  ws.headerFooter = { oddFooter: '&L&8Resident-reported incidents&R&8Page &P of &N' };

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
