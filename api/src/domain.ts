// Shared domain constants and per-community settings.

export const CATEGORIES = [
  'maintenance',
  'plumbing_leak',
  'electrical',
  'lift',
  'hvac_ac',
  'cleaning',
  'pests',
  'security',
  'parking',
  'common_area',
  'pool_gym',
  'noise',
  'waste',
  'landscaping',
  'structural',
  'fire_safety',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STATUSES = [
  'reported', // sent to management, nothing back yet
  'case_number_received', // management gave a case / ticket number
  'in_progress', // management acknowledged work is underway
  'mgmt_closed', // management says closed – NOT yet verified by a resident
  'resolved_ok', // resident verified fixed (with photo)
  'resolved_poor', // resident says closed but poorly fixed (with photo)
  'reopened', // resident says still not fixed
  'withdrawn', // reporter withdrew it
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: Status[] = ['reported', 'case_number_received', 'in_progress', 'reopened'];
export const AWAITING_VERIFICATION: Status[] = ['mgmt_closed'];
export const FINAL_STATUSES: Status[] = ['resolved_ok', 'resolved_poor', 'withdrawn'];

export const ROLES = ['resident', 'committee', 'admin', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];
export const ADMIN_ROLES: Role[] = ['admin', 'super_admin'];

export interface CommunitySettings {
  /** Residents must attach a fresh photo to press "Affects me" */
  require_photo_for_affects: boolean;
  affects_max_per_day: number;
  reports_max_per_day: number;
  /** Hours after the email to management before we nudge the reporter to add a case number */
  case_reminder_hours: number;
  /** Days after "management closed" before we nudge residents to verify */
  verify_reminder_days: number;
  /** KPI target: hours from email sent to a case number being received */
  sla_case_hours: number;
  /** KPI target: days from report to verified resolution, by severity */
  sla_resolve_days: Record<Severity, number>;
  cc_reporter: boolean;
  ai_suggest_enabled: boolean;
  registration_open: boolean;
  /** Optional WhatsApp group invite link (https://chat.whatsapp.com/...) for the "post in our group" share button */
  whatsapp_group_url: string;
  /** resident = the resident sends the email from their own email app (default); platform = the server emails management */
  email_mode: 'resident' | 'platform';
  /** New sign-ups wait for a moderator to approve them (a valid invite code skips the wait) */
  require_approval: boolean;
  /** People who join through a resident's personal invite link are approved automatically */
  trust_resident_invites: boolean;
  /** AirCon tab (fresh-air temperature and humidity from Home Assistant) is shown to residents. Needs the HA_* settings too. */
  aircon_enabled: boolean;
  /** Smell reports (odour map) are switched on for residents */
  odour_enabled: boolean;
  /** Smell reports one resident can log per day */
  odour_max_per_day: number;
  /** Townhouse block numbers offered on the smell form and drawn on the admin map */
  odour_townhouse_blocks: number[];
  /** Townhouses drawn per block on the admin map (grows automatically if a higher number is reported) */
  odour_townhouse_units: number;
}

export const DEFAULT_SETTINGS: CommunitySettings = {
  require_photo_for_affects: false,
  affects_max_per_day: 10,
  reports_max_per_day: 15,
  case_reminder_hours: 24,
  verify_reminder_days: 3,
  sla_case_hours: 24,
  sla_resolve_days: { urgent: 2, high: 7, normal: 14, low: 30 },
  cc_reporter: false,
  ai_suggest_enabled: false,
  registration_open: true,
  whatsapp_group_url: '',
  email_mode: 'resident',
  require_approval: true,
  trust_resident_invites: false,
  aircon_enabled: true,
  odour_enabled: true,
  odour_max_per_day: 10,
  odour_townhouse_blocks: [1, 2, 3],
  odour_townhouse_units: 7,
};

export function mergeSettings(raw: unknown): CommunitySettings {
  let parsed: Partial<CommunitySettings> = {};
  if (typeof raw === 'string' && raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw as Partial<CommunitySettings>;
  }
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    sla_resolve_days: { ...DEFAULT_SETTINGS.sla_resolve_days, ...(parsed.sla_resolve_days ?? {}) },
  };
}

export const CATEGORY_LABELS: Record<Category, string> = {
  maintenance: 'Maintenance',
  plumbing_leak: 'Plumbing / leak',
  electrical: 'Electrical',
  lift: 'Lift',
  hvac_ac: 'AC / HVAC',
  cleaning: 'Cleaning',
  pests: 'Pests',
  security: 'Security',
  parking: 'Parking',
  common_area: 'Common area',
  pool_gym: 'Pool / gym',
  noise: 'Noise',
  waste: 'Waste',
  landscaping: 'Landscaping',
  structural: 'Structural',
  fire_safety: 'Fire / life safety',
  other: 'Other',
};

export const EVENT_TYPES = [
  'reported',
  'imported',
  'email_queued',
  'email_sent',
  'email_failed',
  'case_number_added',
  'status_changed',
  'mgmt_closed',
  'resolved_ok',
  'resolved_poor',
  'reopened',
  'withdrawn',
  'note_added',
  'photo_added',
  'affects_added',
  'linked',
  'unlinked',
  'edited',
  'reminder_sent',
  'mgmt_reply_received',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];


// ---------------- Smell reports (odour map) ----------------

export const ODOUR_TYPES = ['sewage', 'cooking', 'smoke', 'chemical', 'rubbish', 'damp', 'gas', 'burning', 'other'] as const;
export type OdourType = (typeof ODOUR_TYPES)[number];
export const ODOUR_TYPE_LABELS: Record<OdourType, string> = {
  sewage: 'Sewage / drain',
  cooking: 'Cooking / food',
  smoke: 'Cigarette / shisha smoke',
  chemical: 'Chemical / paint / cleaning',
  rubbish: 'Rubbish / bin chute',
  damp: 'Mould / damp',
  gas: 'Gas',
  burning: 'Burning / electrical',
  other: 'Other',
};

export const ODOUR_WHERE = ['inside', 'corridor', 'lift', 'balcony', 'lobby', 'parking'] as const;
export type OdourWhere = (typeof ODOUR_WHERE)[number];
export const ODOUR_WHERE_LABELS: Record<OdourWhere, string> = {
  inside: 'Inside my home',
  corridor: 'Corridor',
  lift: 'Lift',
  balcony: 'Balcony / terrace',
  lobby: 'Lobby / common area',
  parking: 'Car park',
};

export const ODOUR_FREQUENCIES = ['once', 'sometimes', 'daily'] as const;
export type OdourFrequency = (typeof ODOUR_FREQUENCIES)[number];
export const ODOUR_FREQUENCY_LABELS: Record<OdourFrequency, string> = { once: 'First time', sometimes: 'Now and then', daily: 'Daily' };

export const ODOUR_STRENGTH_LABELS: Record<number, string> = { 1: 'Faint', 2: 'Noticeable', 3: 'Strong', 4: 'Unbearable' };

/**
 * Tower floor plan used by the smell map. Every tower has apartment levels 1-13 with 11 flats a level:
 * flats 1-5 along one side, 6 at the end, 7-11 back along the other side. Flats 1 and 11 are Type D, 2-4 and
 * 8-10 are Type C, 5 and 7 are Type B and 6 is Type A. Penthouses sit above level 13 and are stored as level 14.
 */
export const TOWER_LEVELS = 13;
export const PENTHOUSE_LEVEL = 14;
export const FLATS_PER_LEVEL = 11;
export const FLAT_TYPES: Record<number, string> = { 1: 'D', 2: 'C', 3: 'C', 4: 'C', 5: 'B', 6: 'A', 7: 'B', 8: 'C', 9: 'C', 10: 'C', 11: 'D' };
export const PENTHOUSE_UNITS = ['F1', 'F2', 'G1', 'G2', 'H'] as const;
export const MAX_TOWNHOUSE_UNIT = 40;

/** What neighbours see: levels are grouped so a count never points at one flat. */
export const LEVEL_BANDS = [
  { id: '1-4', label: 'Levels 1 to 4', from: 1, to: 4 },
  { id: '5-8', label: 'Levels 5 to 8', from: 5, to: 8 },
  { id: '9-13', label: 'Levels 9 to 13', from: 9, to: 13 },
  { id: 'ph', label: 'Penthouses', from: PENTHOUSE_LEVEL, to: PENTHOUSE_LEVEL },
] as const;
/** A group with fewer reports than this is shown as "fewer than 3" to residents. */
export const ODOUR_MIN_GROUP = 3;
/** Dubai has no daylight saving: UTC+4 all year. Used for the time-of-day chart. */
export const DUBAI_UTC_OFFSET_HOURS = 4;
