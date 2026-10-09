import crypto from 'node:crypto';
import { config } from '../config';
import { signFileLink } from '../security/crypto';

/** Relative signed URL, used by the app (short-lived). */
export function signedPath(key: string, ttlSeconds = 3600): string {
  const { exp, sig } = signFileLink(key, ttlSeconds);
  return `/api/files/${encodeURI(key)}?exp=${exp}&sig=${sig}`;
}

/** Absolute signed URL for emails to management (days-long, never an attachment). */
export function signedAbsolute(key: string, ttlDays = config.email.linkTtlDays): string {
  return `${config.appBaseUrl}${signedPath(key, ttlDays * 86400)}`;
}

/** Token that lets WhatsApp-style link previews show the title and photo of a report. Anyone holding the link sees the preview. */
export function shareToken(incidentId: string): string {
  return crypto.createHmac('sha256', config.fileSigningSecret).update(`share:${incidentId}`).digest('hex').slice(0, 24);
}
export function verifyShareToken(incidentId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 24) return false;
  const a = Buffer.from(shareToken(incidentId));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** The link residents pass to neighbours: opens the report straight into "This affects me too". */
export function shareUrl(incidentId: string): string {
  return `${config.appBaseUrl}/incident/${incidentId}?affects=1&s=${shareToken(incidentId)}`;
}
