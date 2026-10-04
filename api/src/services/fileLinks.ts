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
