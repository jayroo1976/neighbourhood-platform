import type { Db } from '../db';
import { OPEN_STATUSES } from '../domain';

const STOP = new Set(['the', 'and', 'for', 'with', 'has', 'have', 'not', 'are', 'was', 'this', 'that', 'there', 'from', 'been', 'its', 'but', 'again', 'still', 'near', 'on', 'in', 'at', 'of', 'a', 'is', 'to', 'it']);

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface SimilarQuery {
  communityId: string;
  userId: string;
  tower?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  text: string;
}

/**
 * Suggests open reports the resident may be duplicating, so they can tap "Affects me"
 * instead of creating another entry. Linked clusters are the admins' job; this is the nudge.
 */
export async function findSimilar(db: Db, q: SimilarQuery) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const rows = await db('incidents')
    .where({ community_id: q.communityId, visibility: 'community' })
    .whereIn('status', [...OPEN_STATUSES, 'mgmt_closed'])
    .andWhere('reported_at', '>', since)
    .whereNull('cluster_id')
    .limit(400);
  const mine = tokens(q.text);
  const out: { id: string; ref: string; title: string; status: string; tower: string | null; score: number; reasons: string[]; own: boolean }[] = [];
  for (const r of rows) {
    let score = 0;
    const reasons: string[] = [];
    if (q.lat != null && q.lng != null && r.lat != null && r.lng != null) {
      const d = distanceMeters(q.lat, q.lng, r.lat, r.lng);
      if (d <= 75) {
        score += 3;
        reasons.push('same spot');
      } else if (d <= 250) {
        score += 1;
      }
    }
    if (q.tower && r.tower === q.tower) {
      score += 1.5;
      reasons.push('same tower');
    }
    if (q.category && r.category === q.category) {
      score += 1.5;
      reasons.push('same type');
    }
    const sim = jaccard(mine, tokens(`${r.title} ${r.description}`));
    if (sim > 0.15) {
      score += sim * 5;
      reasons.push('similar wording');
    }
    if (score >= 3.5) out.push({ id: r.id, ref: r.ref, title: r.title, status: r.status, tower: r.tower, score: Math.round(score * 10) / 10, reasons, own: r.reporter_id === q.userId });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
