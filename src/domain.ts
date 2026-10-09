// Shared domain constants and per-community settings.

export const CATEGORIES = [
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
  require_approval: false,
  trust_resident_invites: false,
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
