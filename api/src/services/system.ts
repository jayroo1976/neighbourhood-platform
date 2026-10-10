import crypto from 'node:crypto';
import type { Db } from '../db';
import { buildInfo } from '../version';

export interface SystemEvent {
  id: string;
  at: string;
  kind: 'start' | 'update' | 'watchtower';
  title: string;
  message: string;
  version: string | null;
  build: string | null;
}

export async function addSystemEvent(db: Db, e: Pick<SystemEvent, 'kind' | 'title'> & Partial<SystemEvent>): Promise<void> {
  await db('system_events').insert({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind: e.kind,
    title: e.title.slice(0, 200),
    message: (e.message ?? '').slice(0, 8000),
    version: e.version ?? null,
    build: e.build ?? null,
  });
  // keep the table small: newest 500 only
  const old = await db('system_events').orderBy('at', 'desc').offset(500).select('id');
  if (old.length) await db('system_events').whereIn('id', old.map((r: { id: string }) => r.id)).del();
}

/** Called once per process start: records that the app (re)started, and whether the build changed since last time. */
export async function recordStart(db: Db): Promise<void> {
  const label = `v${buildInfo.version} build ${buildInfo.build} (${buildInfo.sha})`;
  const last = await db('system_events').whereIn('kind', ['start', 'update']).orderBy('at', 'desc').first<SystemEvent | undefined>();
  const changed = last && (last.version !== buildInfo.version || last.build !== buildInfo.build);
  await addSystemEvent(db, {
    kind: changed ? 'update' : 'start',
    title: changed ? `Updated to ${label}` : `Started ${label}`,
    message: changed ? `Previously ${last!.version ? `v${last!.version} build ${last!.build}` : 'unknown'}.` : '',
    version: buildInfo.version,
    build: buildInfo.build,
  });
}

/** Watchtower can post plain text or a JSON report; keep it readable either way. */
export function summariseWatchtower(body: unknown): { title: string; message: string } {
  if (typeof body === 'string') {
    const t = body.trim();
    return { title: t.split('\n')[0].slice(0, 120) || 'Watchtower notice', message: t };
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const title = typeof b.title === 'string' ? b.title : 'Watchtower notice';
    let message = typeof b.message === 'string' ? b.message : '';
    const entries = Array.isArray(b.entries) ? (b.entries as { message?: unknown; level?: unknown; time?: unknown }[]) : [];
    if (entries.length) message = (message ? message + '\n' : '') + entries.map((x) => `${x.time ?? ''} ${x.level ?? ''} ${x.message ?? ''}`.trim()).join('\n');
    if (!message) message = JSON.stringify(body, null, 2);
    return { title: title.slice(0, 200), message };
  }
  return { title: 'Watchtower notice', message: '' };
}
