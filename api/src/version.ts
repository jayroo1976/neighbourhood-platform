import fs from 'node:fs';
import path from 'node:path';

function pkgVersion(): string {
  // dist/ is api/dist, so the root package.json is two levels up (also true when run from src/ in dev)
  for (const rel of ['../../package.json', '../package.json', './package.json']) {
    try {
      const p = JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf8')) as { name?: string; version?: string };
      if (p.version && (p.name === 'neighbourhood-platform' || rel === '../../package.json')) return p.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

const env = process.env;
const startedAt = new Date().toISOString();

/** Identifies exactly which build is running. Build number / sha / date are stamped in by the image build. */
export const buildInfo = {
  version: env.APP_VERSION || pkgVersion(),
  build: env.BUILD_NUMBER || 'dev',
  sha: (env.BUILD_SHA || '').slice(0, 7) || 'local',
  built_at: env.BUILD_DATE || null,
  started_at: startedAt,
};

export function publicVersion() {
  return { ...buildInfo, uptime_s: Math.round(process.uptime()) };
}
