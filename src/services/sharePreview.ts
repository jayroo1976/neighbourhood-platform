import type { Db } from '../db';
import { config } from '../config';
import { signedAbsolute, verifyShareToken } from './fileLinks';
import { CATEGORY_LABELS, type Category } from '../domain';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function metaTags(o: { title: string; description: string; image: string; url: string }): string {
  return [
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Neighbourhood Reports" />',
    `<meta property="og:title" content="${esc(o.title)}" />`,
    `<meta property="og:description" content="${esc(o.description)}" />`,
    `<meta property="og:image" content="${esc(o.image)}" />`,
    `<meta property="og:url" content="${esc(o.url)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(o.title)}" />`,
    `<meta name="twitter:image" content="${esc(o.image)}" />`,
  ].join('\n    ');
}

/**
 * Adds Open Graph tags so WhatsApp (and similar) show a title and photo card for a shared link.
 * Details only appear when the link carries a valid share token; otherwise the card is generic.
 * Never includes names, apartment numbers or location text.
 */
export async function withPreview(db: Db, html: string, path: string, incidentId: string | null, token: unknown): Promise<string> {
  const generic = {
    title: 'Neighbourhood Reports',
    description: 'Report community issues in seconds and track how they get fixed.',
    image: `${config.appBaseUrl}/icons/any/app-512.png`,
    url: `${config.appBaseUrl}${path}`,
  };
  let tags = generic;
  if (incidentId && verifyShareToken(incidentId, token)) {
    const inc = await db('incidents').where({ id: incidentId }).first();
    if (inc && inc.visibility === 'community' && inc.status !== 'withdrawn') {
      const n = Number((await db('affects').where({ incident_id: inc.id }).count({ c: '*' }).first())?.c ?? 0) + 1;
      const photo = await db('uploads').where({ incident_id: inc.id, kind: 'report' }).whereNull('deleted_at').orderBy('created_at').first();
      tags = {
        title: `${inc.ref}: ${inc.title}`,
        description: `${CATEGORY_LABELS[inc.category as Category] ?? 'Issue'} · ${inc.tower ?? ''} · ${n} resident${n === 1 ? '' : 's'} reported. Same problem? Tap to add yourself.`,
        image: photo ? signedAbsolute(photo.key, 30) : generic.image,
        url: `${config.appBaseUrl}/incident/${inc.id}?affects=1&s=${token}`,
      };
    }
  }
  return html.replace('</head>', `    ${metaTags(tags)}\n  </head>`);
}
