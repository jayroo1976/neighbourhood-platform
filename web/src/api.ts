export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'neighbourhood' };
  let payload: BodyInit | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // not JSON (e.g. a proxy error page)
    if (!res.ok) throw new ApiError(res.status, res.status === 413 ? 'That photo is too large for the server.' : `The server returned an error (${res.status}). Please try again.`);
    throw new ApiError(res.status, 'Unexpected response from the server.');
  }
  if (res.status === 503 && data.code === 'asleep') {
    location.reload(); // the service went to sleep: the reload shows the start page
    await new Promise(() => undefined);
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong', data.code);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  delete: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, f: FormData) => request<T>('POST', p, undefined, f),
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- shared types ----------
export type Status = 'reported' | 'case_number_received' | 'in_progress' | 'mgmt_closed' | 'resolved_ok' | 'resolved_poor' | 'reopened' | 'withdrawn';
export type Role = 'resident' | 'committee' | 'admin' | 'super_admin';

export interface Me {
  user: null | {
    id: string;
    name: string;
    email: string;
    role: Role;
    tower: string | null;
    unit: string | null;
    notify_email: boolean;
    mfa_enabled: boolean;
    mfa_enrol_required: boolean;
    consent_current: boolean;
  };
  community?: { name: string; towers: string[] };
  config: { privacy_notice_version: string; require_photo_for_affects?: boolean; ai_suggest?: boolean; air_enabled?: boolean; odour_enabled?: boolean; sla_case_hours?: number; whatsapp_group_url?: string; approval_required?: boolean; registration_open?: boolean };
}

export interface ListItem {
  id: string;
  ref: string;
  title: string;
  category: string;
  severity: string;
  status: Status;
  tower: string | null;
  reported_at: string;
  last_activity_at: string;
  mgmt_case_number: string | null;
  affects_count: number;
  linked_reports: number;
  is_linked_child: boolean;
  thumb_url: string | null;
  is_mine: boolean;
  i_affect: boolean;
  can_affect: boolean;
  private: boolean;
}

export interface IncidentEvent {
  n: number;
  type: string;
  at: string;
  actor: string;
  internal: boolean;
  payload: Record<string, any>;
}

export interface Kpis {
  age_days: number;
  hours_to_acknowledgement: number | null;
  acknowledgement_sla: 'met' | 'breached' | 'pending';
  resolve_due_at: string;
  resolution_sla: 'met' | 'breached' | 'pending' | 'poor_fix';
  days_since_update: number;
  closure_to_verification_hours: number | null;
  reopen_count: number;
  management_closures: number;
  disputed_closure: boolean;
}

export interface IncidentDetail {
  id: string;
  ref: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: Status;
  visibility: 'community' | 'private';
  tower: string | null;
  unit?: string | null;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  gps_blurred: boolean;
  reported_at: string;
  emailed_at: string | null;
  mgmt_case_number: string | null;
  case_number_at: string | null;
  mgmt_closed_at: string | null;
  resolved_at: string | null;
  resolution: 'ok' | 'poor' | null;
  reopen_count: number;
  source: string;
  cluster_id: string | null;
  affects_count: number;
  linked: { id: string; ref: string; title: string; status: Status; tower: string | null }[];
  photos: { id: string; kind: string; url: string; thumb_url: string; created_at: string; mine: boolean }[];
  events: IncidentEvent[];
  kpis: Kpis;
  share_url?: string | null;
  permissions: { is_mine: boolean; i_affect: boolean; can_act: boolean; can_affect: boolean; affect_needs_photo: boolean; my_case_number?: string | null; needs_my_email?: boolean; email_mode?: 'resident' | 'platform' };
  reporter?: { name: string; email: string; phone: string | null } | null;
  affects?: { tower: string; unit: string; at: string; mgmt_case_number?: string | null }[];
  mgmt_first_reply_at?: string | null;
}

// ---------- display helpers ----------
export const CATEGORY_LABELS: Record<string, string> = {
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

export const STATUS_LABELS: Record<Status, string> = {
  reported: 'Reported',
  case_number_received: 'Case no. received',
  in_progress: 'In progress',
  mgmt_closed: 'Closed by mgmt - unverified',
  resolved_ok: 'Fixed',
  resolved_poor: 'Closed - poorly fixed',
  reopened: 'Reopened',
  withdrawn: 'Withdrawn',
};

export const OPEN_STATUSES: Status[] = ['reported', 'case_number_received', 'in_progress', 'reopened'];

const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false });
export const dateTime = (iso: string | null | undefined) => (iso ? `${fmtDate.format(new Date(iso))}, ${fmtTime.format(new Date(iso))}` : '-');
export const dateOnly = (iso: string | null | undefined) => (iso ? fmtDate.format(new Date(iso)) : '-');

export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d < 60 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

export function duration(hours: number | null | undefined): string {
  if (hours == null) return '-';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

export const pct = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v * 100)}%`);
