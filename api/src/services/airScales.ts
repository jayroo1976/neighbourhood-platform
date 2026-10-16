/**
 * Reference bands for the AirCon gauges. These are plain ranges taken from published guidance (uHoo's stated ideal ranges,
 * WHO 2021 air quality guidelines, US EPA standards) with the margins we chose; they are NOT a health finding, a legal
 * standard for the building, or a certified measurement. The same definitions are sent to the page and shown to residents.
 * Metrics with no agreed indoor reference (VOC, pressure) are shown without a rating.
 */

export type Level = 'good' | 'fair' | 'poor';

export interface Segment {
  from: number;
  to: number;
  level: Level;
}
export interface Scale {
  label: string;
  unit: string;
  min: number;
  max: number;
  segments: Segment[];
  /** where the bands come from, shown on the page */
  basis: string;
}

/** Extra sensors a tower can have, beyond temperature and humidity. */
export const EXTRA_KEYS = ['pressure', 'co2', 'pm25', 'voc', 'co', 'no2', 'o3', 'virus', 'influenza', 'mold'] as const;
export type ExtraKey = (typeof EXTRA_KEYS)[number];
export type MetricKey = 'temperature' | 'humidity' | ExtraKey;

/** Entity-id endings used by the uHoo integration; `prefix` in HA_AIR_SENSORS expands to prefix + ending. */
export const SUFFIX: Record<MetricKey, string> = {
  temperature: 'temperature',
  humidity: 'humidity',
  pressure: 'pressure',
  co2: 'carbon_dioxide',
  pm25: 'pm2_5',
  voc: 'volatile_organic_compounds',
  co: 'carbon_monoxide',
  no2: 'nitrogen_dioxide',
  o3: 'ozone',
  virus: 'virus_index',
  influenza: 'influenza_index',
  mold: 'mold_index',
};

const seg = (...s: [number, number, Level][]): Segment[] => s.map(([from, to, level]) => ({ from, to, level }));
const INDEX_BASIS = 'uHoo index from 1 to 10: 1-3 good, 4-6 moderate, 7-10 bad (uHoo Virus Index white paper). The same scale is assumed for the mould and influenza indices.';

export const SCALES: Partial<Record<MetricKey, Scale>> = {
  temperature: {
    label: 'Temperature', unit: '°C', min: 10, max: 35,
    segments: seg([10, 16, 'poor'], [16, 19, 'fair'], [19, 24, 'good'], [24, 28, 'fair'], [28, 35, 'poor']),
    basis: 'Good is 19 to 24 °C (uHoo ideal range). Fair is within 3 °C below or 4 °C above that range (our margin). Anything further out is poor.',
  },
  humidity: {
    label: 'Humidity', unit: '%', min: 0, max: 100,
    segments: seg([0, 30, 'poor'], [30, 40, 'fair'], [40, 60, 'good'], [60, 70, 'fair'], [70, 100, 'poor']),
    basis: 'Good is 40 to 60 % (uHoo ideal range). Fair is within 10 points either side (our margin). Anything further out is poor.',
  },
  co2: {
    label: 'Carbon dioxide', unit: 'ppm', min: 400, max: 2000,
    segments: seg([400, 800, 'good'], [800, 1000, 'fair'], [1000, 2000, 'poor']),
    basis: 'Good is below 800 ppm (uHoo ideal range). Fair is 800 to 1,000 ppm, the level commonly used as a ventilation guide. Above that is poor.',
  },
  pm25: {
    label: 'PM2.5 (fine dust)', unit: 'µg/m³', min: 0, max: 60,
    segments: seg([0, 15, 'good'], [15, 35, 'fair'], [35, 60, 'poor']),
    basis: 'Good is below 15 µg/m³ (WHO 2021 24-hour guideline, also uHoo ideal range). Fair is up to 35 µg/m³ (US EPA 24-hour standard). Above that is poor.',
  },
  co: {
    label: 'Carbon monoxide', unit: 'ppm', min: 0, max: 15,
    segments: seg([0, 3.5, 'good'], [3.5, 9, 'fair'], [9, 15, 'poor']),
    basis: 'Good is below about 3.5 ppm (WHO 2021 24-hour guideline, 4 mg/m³). Fair is up to about 9 ppm (WHO 8-hour guideline, 10 mg/m³). Above that is poor.',
  },
  no2: {
    label: 'Nitrogen dioxide', unit: 'ppb', min: 0, max: 200,
    segments: seg([0, 53, 'good'], [53, 100, 'fair'], [100, 200, 'poor']),
    basis: 'Good is below 53 ppb (uHoo ideal range, US EPA annual standard). Fair is up to 100 ppb (US EPA 1-hour standard). Above that is poor.',
  },
  o3: {
    label: 'Ozone', unit: 'ppb', min: 0, max: 120,
    segments: seg([0, 50, 'good'], [50, 70, 'fair'], [70, 120, 'poor']),
    basis: 'Good is below about 50 ppb (WHO 2021 8-hour guideline, 100 µg/m³). Fair is up to 70 ppb (US EPA 8-hour standard). Above that is poor.',
  },
  virus: { label: 'Virus index', unit: '', min: 0, max: 10, segments: seg([0, 3.5, 'good'], [3.5, 6.5, 'fair'], [6.5, 10, 'poor']), basis: INDEX_BASIS },
  influenza: { label: 'Influenza index', unit: '', min: 0, max: 10, segments: seg([0, 3.5, 'good'], [3.5, 6.5, 'fair'], [6.5, 10, 'poor']), basis: INDEX_BASIS },
  mold: { label: 'Mould index', unit: '', min: 0, max: 10, segments: seg([0, 3.5, 'good'], [3.5, 6.5, 'fair'], [6.5, 10, 'poor']), basis: INDEX_BASIS },
};

/** Labels for metrics that are shown but not rated. */
export const UNRATED: Partial<Record<MetricKey, { label: string; unit: string; basis: string }>> = {
  voc: { label: 'Volatile organic compounds', unit: 'ppb', basis: 'Not rated: there is no single agreed indoor reference for this sensor. Shown as recorded.' },
  pressure: { label: 'Air pressure', unit: 'hPa', basis: 'Not rated: pressure is shown for information only.' },
};

/** Band for a value. A value exactly on a boundary counts in the higher band; values beyond either end use the end band. */
export function levelFor(key: MetricKey, value: number | null): Level | null {
  const s = SCALES[key];
  if (!s || value == null || !Number.isFinite(value)) return null;
  if (value < s.min) return s.segments[0].level;
  for (const g of s.segments) if (value >= g.from && value < g.to) return g.level;
  return s.segments[s.segments.length - 1].level;
}
