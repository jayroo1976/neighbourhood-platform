import PDFDocument from 'pdfkit';
import type { Db } from '../db';
import {
  DUBAI_UTC_OFFSET_HOURS,
  FLATS_PER_LEVEL,
  FLAT_TYPES,
  ODOUR_FREQUENCIES,
  ODOUR_FREQUENCY_LABELS,
  ODOUR_STRENGTH_LABELS,
  ODOUR_TYPES,
  ODOUR_TYPE_LABELS,
  ODOUR_WHERE,
  ODOUR_WHERE_LABELS,
  PENTHOUSE_LEVEL,
  PENTHOUSE_UNITS,
  TOWER_LEVELS,
  mergeSettings,
} from '../domain';
import { HttpError } from './incidents';
import { adminOdourList, odourPatterns, type AdminOdourFilter, type OdourListItem } from './odour';

/**
 * PDF summary of smell reports for the management company: how many, which buildings, which flats, when.
 * Built for an admin to download and send; the app never sends it anywhere itself.
 *
 * What it leaves out on purpose: the free-text notes (they can contain names or other personal detail) and
 * anything that identifies the resident. It does show the exact level and flat, because the management company
 * needs to find the stack. Wording is factual and says the figures are resident reports, not measurements.
 */

const C = { teal: '#0f4c4c', teal2: '#176666', sand: '#f4ecdc', ink: '#1d2a2a', muted: '#667373', line: '#e0d6bf', paper: '#fffdf8', amber: '#c97a0a' };
const HEAT = ['#dcebe7', '#a6cdc5', '#4f9a93', '#0f4c4c'];
const PAGE = { w: 595.28, h: 841.89, m: 40 };
const BODY_W = PAGE.w - PAGE.m * 2;
const BOTTOM = PAGE.h - 56;
const MAX_LOG_ROWS = 500;
const MAX_WEEKS = 26;

const dubaiParts = (iso: string) => {
  const t = Date.parse(iso);
  return new Date(t + DUBAI_UTC_OFFSET_HOURS * 3_600_000);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const dayLabel = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const stampLabel = (iso: string) => {
  const d = dubaiParts(iso);
  return `${dayLabel(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const countBy = <T>(rows: T[], key: (r: T) => string) => {
  const o = new Map<string, number>();
  for (const r of rows) o.set(key(r), (o.get(key(r)) ?? 0) + 1);
  return o;
};

export interface OdourPdfInput {
  communityName: string;
  mgmtName: string;
  towers: string[];
  townhouses: string[];
  townhouseMaxUnit: number;
  items: OdourListItem[];
  filter: AdminOdourFilter;
  now?: Date;
}

/** Loads what the PDF needs for one community, then renders it. */
export async function odourReportPdf(db: Db, communityId: string, filter: AdminOdourFilter = {}): Promise<Buffer> {
  const c = await db('communities').where({ id: communityId }).first();
  if (!c) throw new HttpError(404, 'Community not found.');
  let towers: string[] = [];
  try {
    towers = JSON.parse(c.towers);
  } catch {
    towers = [];
  }
  const s = mergeSettings(c.settings);
  const items = await adminOdourList(db, communityId, filter);
  return renderOdourPdf({
    communityName: c.name,
    mgmtName: c.mgmt_name,
    towers,
    townhouses: s.odour_townhouse_blocks.map((n: number) => `Townhouse ${n}`),
    townhouseMaxUnit: s.odour_townhouse_units,
    items,
    filter,
  });
}

export function renderOdourPdf(input: OdourPdfInput): Promise<Buffer> {
  const { items, towers, townhouses, filter } = input;
  const now = input.now ?? new Date();
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE.m, bottom: PAGE.m, left: PAGE.m, right: PAGE.m },
    bufferPages: true,
    info: { Title: `Smell reports - ${input.communityName}`, Author: input.communityName, Subject: 'Resident-reported smells by building, level and flat' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  let y = PAGE.m;
  const text = (s: string, x: number, yy: number, o: { size?: number; bold?: boolean; serif?: boolean; color?: string; width?: number; align?: 'left' | 'center' | 'right'; height?: number } = {}) => {
    doc
      .font(o.serif ? 'Times-Bold' : o.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(o.size ?? 9)
      .fillColor(o.color ?? C.ink)
      .text(s, x, yy, { width: o.width ?? BODY_W, align: o.align ?? 'left', lineBreak: false, height: o.height, ellipsis: o.height !== undefined });
  };
  const para = (s: string, x: number, yy: number, w: number, o: { size?: number; color?: string; bold?: boolean } = {}) => {
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? C.ink);
    const h = doc.heightOfString(s, { width: w, lineGap: 2 });
    doc.text(s, x, yy, { width: w, lineGap: 2 });
    return h;
  };
  const newPage = () => {
    doc.addPage();
    y = PAGE.m;
  };
  const ensure = (h: number) => {
    if (y + h > BOTTOM) newPage();
  };
  const heading = (s: string) => {
    ensure(40);
    text(s, PAGE.m, y, { size: 13, serif: true, color: C.teal });
    y += 18;
    doc.moveTo(PAGE.m, y).lineTo(PAGE.m + BODY_W, y).lineWidth(0.6).strokeColor(C.line).stroke();
    y += 8;
  };

  // ---------- page 1: title and summary ----------
  doc.rect(0, 0, PAGE.w, 92).fill(C.teal);
  text('Smell reports', PAGE.m, 26, { size: 24, serif: true, color: '#ffffff' });
  text(`${input.communityName}  |  Prepared for ${input.mgmtName}`, PAGE.m, 58, { size: 10.5, color: '#d6e8e4' });
  y = 106;

  const first = items.length ? items[items.length - 1].observed_at : null;
  const last = items.length ? items[0].observed_at : null;
  const period = filter.days ? `Last ${filter.days} days, to ${dayLabel(dubaiParts(now.toISOString()))}` : 'All reports to date';
  const filters = [filter.type ? `Smell type: ${ODOUR_TYPE_LABELS[filter.type as keyof typeof ODOUR_TYPE_LABELS] ?? filter.type}` : '', filter.where ? `Where noticed: ${ODOUR_WHERE_LABELS[filter.where as keyof typeof ODOUR_WHERE_LABELS] ?? filter.where}` : ''].filter(Boolean);
  text(`Period: ${period}${first && last ? `  (first report ${dayLabel(dubaiParts(first))}, latest ${dayLabel(dubaiParts(last))})` : ''}`, PAGE.m, y, { size: 9, color: C.muted });
  y += 13;
  if (filters.length) {
    text(`Filtered to: ${filters.join('; ')}`, PAGE.m, y, { size: 9, color: C.muted });
    y += 13;
  }
  text(`Generated ${stampLabel(now.toISOString())} Dubai time`, PAGE.m, y, { size: 9, color: C.muted });
  y += 22;

  const homeKey = (i: OdourListItem) => `${i.building}|${i.level}|${i.flat}`;
  const homes = new Set(items.map(homeKey)).size;
  const buildingsWith = new Set(items.map((i) => i.building)).size;
  const strong = items.filter((i) => i.strength >= 3).length;
  const tiles: [string, string][] = [
    ['Reports', String(items.length)],
    ['Homes reporting', String(homes)],
    ['Buildings with reports', String(buildingsWith)],
    ['Strong or unbearable', String(strong)],
  ];
  const tw = (BODY_W - 3 * 10) / 4;
  tiles.forEach(([label, value], k) => {
    const x = PAGE.m + k * (tw + 10);
    doc.roundedRect(x, y, tw, 52, 6).fill('#eef4f2');
    text(value, x + 10, y + 8, { size: 20, serif: true, color: C.teal, width: tw - 20 });
    text(label, x + 10, y + 35, { size: 8.5, color: C.muted, width: tw - 20 });
  });
  y += 66;

  y += para(
    'How to read this report. Each report is one resident’s account of a smell they noticed, with the level and flat it was noticed from. The figures count reports made. They are not a measurement of the smell, and they do not show its cause. One home can report more than once.',
    PAGE.m,
    y,
    BODY_W,
    { size: 8.5, color: C.muted },
  );
  y += 14;

  if (items.length === 0) {
    heading('No reports');
    para('There are no smell reports for this period and filter.', PAGE.m, y, BODY_W);
    y += 20;
  } else {
    // ---------- by building ----------
    heading('By building');
    const cols = [
      { h: 'Building', w: 120, a: 'left' as const },
      { h: 'Reports', w: 60, a: 'right' as const },
      { h: 'Homes', w: 60, a: 'right' as const },
      { h: 'Strong / unbearable', w: 110, a: 'right' as const },
      { h: 'Most reported smell', w: BODY_W - 350, a: 'right' as const },
    ];
    const tableHead = (xs: typeof cols, yy: number) => {
      doc.rect(PAGE.m, yy, BODY_W, 16).fill(C.sand);
      let x = PAGE.m;
      for (const c of xs) {
        text(c.h, x + 4, yy + 4, { size: 8, bold: true, color: C.teal, width: c.w - 8, align: c.a });
        x += c.w;
      }
    };
    tableHead(cols, y);
    y += 16;
    for (const name of [...towers, ...townhouses]) {
      const rs = items.filter((i) => i.building === name);
      if (!rs.length) continue;
      const top = [...countBy(rs, (r) => r.smell_type).entries()].sort((a, b) => b[1] - a[1])[0];
      const cells = [name, String(rs.length), String(new Set(rs.map(homeKey)).size), String(rs.filter((r) => r.strength >= 3).length), `${ODOUR_TYPE_LABELS[top[0] as keyof typeof ODOUR_TYPE_LABELS]} (${top[1]})`];
      let x = PAGE.m;
      cells.forEach((v, k) => {
        text(v, x + 4, y + 4, { size: 9, width: cols[k].w - 8, align: cols[k].a, height: 11, bold: k === 0 });
        x += cols[k].w;
      });
      y += 17;
      doc.moveTo(PAGE.m, y).lineTo(PAGE.m + BODY_W, y).lineWidth(0.4).strokeColor(C.line).stroke();
    }
    y += 12;

    // ---------- breakdown bars, two columns ----------
    heading('What was reported');
    const colW = (BODY_W - 24) / 2;
    const bars = (title: string, rows: [string, number][], x: number, yy: number) => {
      text(title, x, yy, { size: 9, bold: true, color: C.teal2, width: colW });
      yy += 15;
      const max = Math.max(1, ...rows.map((r) => r[1]));
      for (const [label, n] of rows) {
        text(label, x, yy + 1, { size: 8.5, width: 112, height: 11 });
        const bw = Math.max(n ? 2 : 0, ((colW - 150) * n) / max);
        if (bw) doc.rect(x + 116, yy, bw, 9).fill(C.teal2);
        text(String(n), x + 120 + bw, yy + 1, { size: 8.5, color: C.muted, width: 40 });
        yy += 14;
      }
      return yy + 6;
    };
    const typeRows = ODOUR_TYPES.map((t) => [ODOUR_TYPE_LABELS[t], items.filter((i) => i.smell_type === t).length] as [string, number]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const whereRows = ODOUR_WHERE.map((t) => [ODOUR_WHERE_LABELS[t], items.filter((i) => i.where_noticed === t).length] as [string, number]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const strengthRows = [1, 2, 3, 4].map((s) => [ODOUR_STRENGTH_LABELS[s], items.filter((i) => i.strength === s).length] as [string, number]);
    const freqRows = ODOUR_FREQUENCIES.map((f) => [ODOUR_FREQUENCY_LABELS[f], items.filter((i) => i.frequency === f).length] as [string, number]);
    const leftH = 15 + typeRows.length * 14 + 6 + 15 + strengthRows.length * 14 + 6;
    ensure(leftH + 4);
    const startY = y;
    let ly = bars('Smell type', typeRows, PAGE.m, startY);
    ly = bars('How strong (resident’s rating)', strengthRows, PAGE.m, ly);
    let ry = bars('Where it was noticed', whereRows, PAGE.m + colW + 24, startY);
    ry = bars('How often', freqRows, PAGE.m + colW + 24, ry);
    y = Math.max(ly, ry) + 6;

    // ---------- time of day ----------
    const byHour = new Array<number>(24).fill(0);
    for (const i of items) {
      const t = Date.parse(i.observed_at);
      if (Number.isFinite(t)) byHour[dubaiParts(i.observed_at).getUTCHours()]++;
    }
    const column = (title: string, vals: number[], labels: string[], every: number) => {
      ensure(122);
      text(title, PAGE.m, y, { size: 9, bold: true, color: C.teal2 });
      y += 16;
      const chartH = 70;
      const max = Math.max(1, ...vals);
      const slot = BODY_W / vals.length;
      doc.moveTo(PAGE.m, y + chartH).lineTo(PAGE.m + BODY_W, y + chartH).lineWidth(0.5).strokeColor(C.line).stroke();
      vals.forEach((v, k) => {
        const h = (chartH - 12) * (v / max);
        const x = PAGE.m + k * slot + slot * 0.18;
        if (v) {
          doc.rect(x, y + chartH - h, slot * 0.64, h).fill(C.teal2);
          text(String(v), PAGE.m + k * slot, y + chartH - h - 10, { size: 7, color: C.muted, width: slot, align: 'center' });
        }
        if (k % every === 0) text(labels[k], PAGE.m + k * slot - slot, y + chartH + 3, { size: 7, color: C.muted, width: slot * 3, align: 'center' });
      });
      y += chartH + 18;
    };
    column('Time of day noticed (Dubai time, hour of day)', byHour, byHour.map((_, h) => pad(h)), 3);

    // ---------- per week ----------
    const weekStart = (iso: string) => {
      const d = dubaiParts(iso);
      const day = (d.getUTCDay() + 6) % 7;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    };
    const weekCounts = countBy(items, (i) => String(weekStart(i.observed_at)));
    const keys = [...weekCounts.keys()].map(Number);
    let wMin = Math.min(...keys);
    const wMax = Math.max(...keys);
    if ((wMax - wMin) / (7 * 86_400_000) + 1 > MAX_WEEKS) wMin = wMax - (MAX_WEEKS - 1) * 7 * 86_400_000;
    const weeks: number[] = [];
    for (let w = wMin; w <= wMax; w += 7 * 86_400_000) weeks.push(w);
    column(
      `Reports per week (week starting Monday${weeks.length === MAX_WEEKS ? `, latest ${MAX_WEEKS} weeks` : ''})`,
      weeks.map((w) => weekCounts.get(String(w)) ?? 0),
      weeks.map((w) => `${new Date(w).getUTCDate()} ${MONTHS[new Date(w).getUTCMonth()]}`),
      Math.max(1, Math.ceil(weeks.length / 8)),
    );

    // ---------- patterns ----------
    const found = odourPatterns(items, towers);
    if (found.length) {
      heading('Patterns in the reports');
      for (const f of found) {
        ensure(26);
        y += para(`• ${f}`, PAGE.m + 4, y, BODY_W - 8, { size: 9 }) + 4;
      }
      ensure(30);
      y += para('Reports in the same position on several levels can point to a shared riser or duct. This report does not state a cause: it only shows where residents have reported.', PAGE.m, y + 2, BODY_W, { size: 8.5, color: C.muted });
    }

    // ---------- tower plans ----------
    for (const name of towers) {
      const rs = items.filter((i) => i.building === name && i.kind === 'tower');
      if (!rs.length) continue;
      newPage();
      text(name, PAGE.m, y, { size: 18, serif: true, color: C.teal });
      y += 26;
      text(`${rs.length} ${rs.length === 1 ? 'report' : 'reports'} from ${new Set(rs.map(homeKey)).size} ${new Set(rs.map(homeKey)).size === 1 ? 'home' : 'homes'}. Each square is one flat; the number is how many reports it has.`, PAGE.m, y, { size: 9, color: C.muted });
      y += 22;
      const counts = new Map<string, number>();
      for (const r of rs) counts.set(`${r.level}-${r.flat}`, (counts.get(`${r.level}-${r.flat}`) ?? 0) + 1);
      const max = Math.max(1, ...counts.values());
      const shade = (n: number) => HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.ceil((n / max) * HEAT.length) - 1))];
      const labelW = 34;
      const cw = Math.floor((BODY_W - labelW) / FLATS_PER_LEVEL);
      const ch = 25;
      // column heads: flat number and type
      for (let f = 1; f <= FLATS_PER_LEVEL; f++) {
        const x = PAGE.m + labelW + (f - 1) * cw;
        text(String(f), x, y, { size: 8, bold: true, color: C.teal, width: cw, align: 'center' });
        text(`Type ${FLAT_TYPES[f]}`, x, y + 10, { size: 6, color: C.muted, width: cw, align: 'center' });
      }
      y += 24;
      const levels = [PENTHOUSE_LEVEL, ...Array.from({ length: TOWER_LEVELS }, (_, k) => TOWER_LEVELS - k)];
      for (const l of levels) {
        const ph = l === PENTHOUSE_LEVEL;
        text(ph ? 'Penthouse' : `Level ${l}`, PAGE.m, y + 8, { size: ph ? 5.5 : 8, color: C.muted, width: labelW - 2, align: 'right' });
        const n = ph ? PENTHOUSE_UNITS.length : FLATS_PER_LEVEL;
        for (let f = 1; f <= FLATS_PER_LEVEL; f++) {
          const x = PAGE.m + labelW + (f - 1) * cw;
          if (f > n) continue;
          const c = counts.get(`${l}-${f}`) ?? 0;
          doc.rect(x + 1, y + 1, cw - 2, ch - 2).fill(c ? shade(c) : '#f5f1e6');
          if (c) text(String(c), x, y + 8, { size: 9, bold: true, color: HEAT.indexOf(shade(c)) >= 2 ? '#ffffff' : C.ink, width: cw, align: 'center' });
          else if (ph) text(PENTHOUSE_UNITS[f - 1], x, y + 9, { size: 6.5, color: C.muted, width: cw, align: 'center' });
        }
        y += ch;
      }
      y += 12;
      text('Fewer', PAGE.m + labelW, y, { size: 7.5, color: C.muted, width: 40 });
      HEAT.forEach((h, k) => doc.rect(PAGE.m + labelW + 34 + k * 16, y - 1, 14, 10).fill(h));
      text('More reports', PAGE.m + labelW + 34 + HEAT.length * 16 + 4, y, { size: 7.5, color: C.muted, width: 80 });
      y += 18;
      const pHomes = rs.filter((r) => r.level === PENTHOUSE_LEVEL);
      if (pHomes.length) text(`Penthouse units on the top row are, left to right: ${PENTHOUSE_UNITS.join(', ')}.`, PAGE.m, y, { size: 7.5, color: C.muted });
    }

    // ---------- townhouses ----------
    const thWith = townhouses.filter((n) => items.some((i) => i.building === n));
    if (thWith.length) {
      newPage();
      text('Townhouses', PAGE.m, y, { size: 18, serif: true, color: C.teal });
      y += 30;
      for (const name of thWith) {
        const rs = items.filter((i) => i.building === name);
        const counts = new Map<number, number>();
        for (const r of rs) counts.set(r.flat, (counts.get(r.flat) ?? 0) + 1);
        const max = Math.max(1, ...counts.values());
        const perRow = 10;
        const size = Math.floor(BODY_W / perRow);
        const rows = Math.ceil(input.townhouseMaxUnit / perRow);
        ensure(30 + rows * size + 20);
        text(`${name}: ${rs.length} ${rs.length === 1 ? 'report' : 'reports'} from ${counts.size} ${counts.size === 1 ? 'house' : 'houses'}`, PAGE.m, y, { size: 10, bold: true, color: C.teal2 });
        y += 18;
        for (let n = 1; n <= input.townhouseMaxUnit; n++) {
          const x = PAGE.m + ((n - 1) % perRow) * size;
          const yy = y + Math.floor((n - 1) / perRow) * size;
          const c = counts.get(n) ?? 0;
          const fill = c ? HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.ceil((c / max) * HEAT.length) - 1))] : '#f5f1e6';
          doc.rect(x + 1, yy + 1, size - 2, size - 2).fill(fill);
          text(String(n), x + 4, yy + 4, { size: 6.5, color: c && HEAT.indexOf(fill) >= 2 ? '#d6e8e4' : C.muted, width: size - 8 });
          if (c) text(String(c), x, yy + size / 2 - 3, { size: 10, bold: true, color: HEAT.indexOf(fill) >= 2 ? '#ffffff' : C.ink, width: size, align: 'center' });
        }
        y += rows * size + 18;
      }
    }

    // ---------- log ----------
    newPage();
    text('Report log', PAGE.m, y, { size: 18, serif: true, color: C.teal });
    y += 24;
    const shown = items.slice(0, MAX_LOG_ROWS);
    text(
      items.length > shown.length ? `Latest ${shown.length} of ${items.length} reports, newest first. The full list is available as a spreadsheet.` : `${items.length} ${items.length === 1 ? 'report' : 'reports'}, newest first. Residents’ free-text notes are not included.`,
      PAGE.m,
      y,
      { size: 8.5, color: C.muted },
    );
    y += 16;
    const lc = [
      { h: 'When noticed (Dubai)', w: 80, a: 'left' as const },
      { h: 'Building', w: 54, a: 'left' as const },
      { h: 'Home', w: 74, a: 'left' as const },
      { h: 'Smell', w: 104, a: 'left' as const },
      { h: 'Strength', w: 50, a: 'left' as const },
      { h: 'Where', w: 88, a: 'left' as const },
      { h: 'How often', w: BODY_W - 450, a: 'left' as const },
    ];
    const head = () => {
      doc.rect(PAGE.m, y, BODY_W, 16).fill(C.sand);
      let x = PAGE.m;
      for (const c of lc) {
        text(c.h, x + 3, y + 4, { size: 7.5, bold: true, color: C.teal, width: c.w - 6 });
        x += c.w;
      }
      y += 16;
    };
    head();
    shown.forEach((i, k) => {
      if (y + 15 > BOTTOM) {
        newPage();
        head();
      }
      if (k % 2) doc.rect(PAGE.m, y, BODY_W, 15).fill('#faf6ec');
      const cells = [stampLabel(i.observed_at), i.building, i.home, ODOUR_TYPE_LABELS[i.smell_type], ODOUR_STRENGTH_LABELS[i.strength] ?? String(i.strength), ODOUR_WHERE_LABELS[i.where_noticed], ODOUR_FREQUENCY_LABELS[i.frequency]];
      let x = PAGE.m;
      cells.forEach((v, j) => {
        text(v, x + 3, y + 4, { size: 7.5, width: lc[j].w - 6, height: 9 });
        x += lc[j].w;
      });
      y += 15;
    });
  }

  // ---------- footer on every page ----------
  const range = doc.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0; // otherwise drawing in the footer area adds a blank page
    doc.moveTo(PAGE.m, PAGE.h - 40).lineTo(PAGE.m + BODY_W, PAGE.h - 40).lineWidth(0.5).strokeColor(C.line).stroke();
    text('Resident-reported. Not a measurement, and not a finding about any home or person.', PAGE.m, PAGE.h - 32, { size: 7.5, color: C.muted, width: BODY_W - 80 });
    text(`Page ${p + 1} of ${range.count}`, PAGE.w - PAGE.m - 80, PAGE.h - 32, { size: 7.5, color: C.muted, width: 80, align: 'right' });
  }
  doc.end();
  return done;
}
