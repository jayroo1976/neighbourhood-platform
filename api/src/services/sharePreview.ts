import type { Db } from '../db';
import { config } from '../config';

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
 * Link previews are always generic. Every screen of the platform requires sign-in, so a shared link must not
 * reveal anything about a report (no title, category, building, count or photo) to people who are not signed in.
 */
export async function withPreview(_db: Db, html: string, path: string, _incidentId: string | null, _token: unknown): Promise<string> {
  const tags = {
    title: 'Neighbourhood Reports',
    description: 'Private community tracking for residents. Sign in to view.',
    image: `${config.appBaseUrl}/icons/any/app-512.png`,
    url: `${config.appBaseUrl}${path.split('?')[0]}`,
  };
  return html.replace('</head>', `    ${metaTags(tags)}\n  </head>`);
}
