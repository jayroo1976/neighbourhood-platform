import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './auth';

export interface VersionInfo {
  version: string;
  build: string;
  sha: string;
  built_at: string | null;
  started_at: string;
}

/** A thin strip at the very top of every page showing exactly which build you are looking at. */
export function VersionBar() {
  const { me } = useAuth();
  const [v, setV] = useState<VersionInfo | null>(null);
  const [fresh, setFresh] = useState(false);
  const first = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch('/api/system/version', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as VersionInfo;
        if (stop) return;
        const id = `${j.version}-${j.build}-${j.sha}`;
        if (first.current === null) first.current = id;
        else if (first.current !== id) setFresh(true);
        setV(j);
      } catch {
        /* offline or asleep: keep what we have */
      }
    };
    void load();
    const t = setInterval(load, 5 * 60_000);
    const onVis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!v) return null;
  const staff = me?.user?.role === 'admin' || me?.user?.role === 'super_admin';
  const label = `v${v.version} · build ${v.build}${v.sha !== 'local' ? ` · ${v.sha}` : ''}`;
  return (
    <div className="versionbar" role="note">
      {staff ? <Link to="/admin/system" title="See update history">{label}</Link> : <span>{label}</span>}
      {fresh && (
        <button className="versionbar-new" onClick={() => window.location.reload()}>
          New version available. Tap to reload
        </button>
      )}
    </div>
  );
}
