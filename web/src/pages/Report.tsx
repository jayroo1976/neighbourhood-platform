import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CATEGORY_LABELS, api, dateTime, qs } from '../api';
import { useAuth } from '../auth';
import { EmailPanel } from '../EmailPanel';
import { Banner, ErrorNote, Field, PhotoButton, Toggle, ShareButton, shrinkImage } from '../ui';
import { draftWithOwnAi, loadOwnAi } from '../ownAi';

interface Photo {
  id: string;
  url: string;
}
interface Suggestion {
  title: string;
  description: string;
  category: string;
  severity: string;
  ai_used: boolean;
}
interface Similar {
  id: string;
  ref: string;
  title: string;
  status: string;
  tower: string | null;
  affects_count: number;
  reasons: string[];
  own: boolean;
}

const LOCATION_HINTS = ['Lobby', 'Lift', 'Car park B1', 'Car park B2', 'Corridor', 'Stairwell', 'Pool', 'Gym', 'Garden', 'Bin room', 'Entrance gate'];

export function Report() {
  const { me } = useAuth();
  const nav = useNavigate();
  const user = me!.user!;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('normal');
  const [locationText, setLocationText] = useState('');
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [gpsState, setGpsState] = useState<'idle' | 'asking' | 'denied'>('idle');
  const [priv, setPriv] = useState(false);
  const [suggested, setSuggested] = useState<null | { ai: boolean }>(null);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; ref: string; share_url: string | null; email_mode?: 'resident' | 'platform' } | null>(null);
  const touched = useRef({ title: false, description: false, category: false, severity: false });
  const openedAt = useRef(new Date());

  const profileMissing = !user.tower || !user.unit;

  const askGps = useCallback(() => {
    if (!('geolocation' in navigator)) return setGpsState('denied');
    setGpsState('asking');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGps({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
        setGpsState('idle');
      },
      () => setGpsState('denied'),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  async function runSuggest(uploadId: string | undefined, text: string, photo?: Blob) {
    try {
      const own = loadOwnAi();
      let s: Suggestion;
      if (own && photo) {
        try {
          s = { ...(await draftWithOwnAi(own, photo, text)), ai_used: true };
        } catch {
          s = await api.post<Suggestion>('/ai/suggest', { note: text }); // own AI failed: fall back to plain drafting
        }
      } else s = await api.post<Suggestion>('/ai/suggest', { upload_id: uploadId, note: text });
      const t = touched.current;
      if (!t.title && s.title) setTitle(s.title);
      if (!t.description && s.description) setDescription(s.description);
      if (!t.category && s.category && s.category !== 'other') setCategory(s.category);
      if (!t.severity && s.severity) setSeverity(s.severity);
      setSuggested({ ai: s.ai_used });
    } catch {
      /* suggestions are a convenience only */
    }
  }

  async function addPhoto(file: File) {
    setUploading(true);
    setError(null);
    try {
      const blob = await shrinkImage(file);
      const form = new FormData();
      form.append('file', blob, 'photo.jpg');
      form.append('kind', 'report');
      const r = await api.upload<{ id: string; thumb_url: string }>('/uploads', form);
      setPhotos((p) => [...p, { id: r.id, url: r.thumb_url }]);
      if (photos.length === 0) {
        if (!gps && gpsState === 'idle') askGps();
        void runSuggest(r.id, note, blob);
      }
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }

  // duplicate hints
  useEffect(() => {
    if (title.trim().length < 4) return setSimilar([]);
    const t = setTimeout(() => {
      api
        .get<{ items: Similar[] }>(`/incidents/similar${qs({ category, tower: user.tower, lat: gps?.lat, lng: gps?.lng, text: `${title} ${description}` })}`)
        .then((r) => setSimilar(r.items))
        .catch(() => setSimilar([]));
    }, 500);
    return () => clearTimeout(t);
  }, [title, description, category, gps, user.tower]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string; ref: string; share_url: string | null; email_mode?: 'resident' | 'platform' }>('/incidents', {
        title,
        description,
        category: category || 'other',
        severity,
        location_text: locationText || null,
        lat: gps?.lat ?? null,
        lng: gps?.lng ?? null,
        gps_accuracy: gps?.acc ?? null,
        device_reported_at: openedAt.current.toISOString(),
        visibility: priv ? 'private' : 'community',
        upload_ids: photos.map((p) => p.id),
      });
      setDone(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="page">
        <div className="success">
          {done.email_mode === 'resident' ? (
            <>
              <div className="stamp-big">Saved</div>
              <h1>{done.ref} saved</h1>
              <EmailPanel incidentId={done.id} autoOpen />
            </>
          ) : (
            <>
              <div className="stamp-big">Sent</div>
              <h1>{done.ref} reported</h1>
              <p>
                We're emailing the management company now, with your photo, location and apartment number. The time and date are recorded: <strong>{dateTime(new Date().toISOString())}</strong>.
              </p>
              <Banner tone="info" title="Next step">
                When they reply with a case number, add it on the report. We'll remind you if nothing arrives within {me?.config.sla_case_hours ?? 24} hours.
              </Banner>
            </>
          )}
          {done.share_url && (
            <div className="share-box">
              <p>
                <strong>Neighbours have the same problem?</strong> Send them this link. They sign in, tap once, and are counted on your report.
              </p>
              <ShareButton shareUrl={done.share_url} refLabel={done.ref} title={title} groupUrl={me?.config.whatsapp_group_url || undefined} />
            </div>
          )}
          <div className="stack">
            <Link className="btn primary block" to={`/incident/${done.id}`}>
              View report
            </Link>
            <Link className="btn block" to="/">
              Back to community
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const ready = photos.length > 0 && title.trim().length >= 3 && !!category && !profileMissing;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Report an issue</h1>
        <p className="muted">
          {user.tower}, apartment {user.unit} will be added automatically. <Link to="/profile">Change</Link>
        </p>
      </header>

      {profileMissing && (
        <Banner tone="danger" title="Add your tower and apartment first">
          <Link to="/profile">Open your profile</Link> - you only need to do this once.
        </Banner>
      )}

      <Banner tone="warn" title="Before you submit">
        <ul className="plain tight">
          <li>Reports are visible to your community (never your name or apartment number). Don't want neighbours to see it? Switch on "Keep private" below.</li>
          <li>Please don't photograph people, faces or car number plates.</li>
          <li>Danger to life? Call 999 first. This app is not monitored for emergencies.</li>
        </ul>
      </Banner>

      <section className="stack">
        <div className="photo-row">
          {photos.map((p, i) => (
            <div key={p.id} className="photo-tile">
              <img src={p.url} alt={`Photo ${i + 1}`} />
              <button className="x" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos(photos.filter((x) => x.id !== p.id))}>
                ×
              </button>
            </div>
          ))}
          {photos.length < 4 && <PhotoButton onFile={addPhoto} busy={uploading} label={photos.length ? 'Add another' : 'Take or choose photo'} />}
        </div>

        <Field label="What's wrong?" hint="A few words is enough. Tap the microphone on your keyboard to dictate.">
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => (note.trim() || photos.length) && !touched.current.title && runSuggest(photos[0]?.id, note)}
            placeholder="e.g. Water dripping from the ceiling near bay 214"
          />
        </Field>

        <Field label="Title" hint={suggested ? (suggested.ai ? 'Drafted by your own AI connection from your photo - edit if it is wrong.' : 'Drafted from your note - edit if needed.') : undefined}>
          <input value={title} maxLength={120} onChange={(e) => ((touched.current.title = true), setTitle(e.target.value))} placeholder="Short summary" />
        </Field>
        <Field label="Details (optional)">
          <textarea rows={3} value={description} maxLength={2000} onChange={(e) => ((touched.current.description = true), setDescription(e.target.value))} />
        </Field>

        <div>
          <span className="field-label">Type</span>
          <div className="chips wrap" role="radiogroup" aria-label="Type of issue">
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <button key={k} type="button" role="radio" aria-checked={category === k} className={`chip ${category === k ? 'on' : ''}`} onClick={() => ((touched.current.category = true), setCategory(k))}>
                {v}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="field-label">How urgent?</span>
          <div className="chips" role="radiogroup" aria-label="Urgency">
            {[
              ['low', 'Low'],
              ['normal', 'Normal'],
              ['high', 'High'],
              ['urgent', 'Safety risk'],
            ].map(([k, v]) => (
              <button key={k} type="button" role="radio" aria-checked={severity === k} className={`chip ${severity === k ? 'on' : ''}`} onClick={() => ((touched.current.severity = true), setSeverity(k))}>
                {v}
              </button>
            ))}
          </div>
        </div>

        <Field label="Where exactly?" hint={gps ? `📍 GPS captured (±${Math.round(gps.acc)} m). Neighbours only see an approximate area.` : gpsState === 'denied' ? 'Location is off - just describe where it is.' : undefined}>
          <input list="loc-hints" value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="e.g. Car park B2, near bay 214" />
          <datalist id="loc-hints">
            {LOCATION_HINTS.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </Field>
        <div className="row">
          {gps ? (
            <button type="button" className="btn small" onClick={() => setGps(null)}>
              Remove GPS
            </button>
          ) : (
            <button type="button" className="btn small" onClick={askGps} disabled={gpsState === 'asking'}>
              {gpsState === 'asking' ? 'Finding you...' : '📍 Use my location'}
            </button>
          )}
        </div>

        <Toggle checked={priv} onChange={setPriv} label="Keep private" hint="Sent to the management company and counted in the scorecard, but not shown to neighbours. Use for issues inside your own apartment." />

        {similar.length > 0 && (
          <Banner tone="info" title="Already reported?">
            <p>Tapping "Affects me" on an existing report adds your voice without cluttering the list.</p>
            <ul className="plain">
              {similar.map((s) => (
                <li key={s.id}>
                  <Link to={`/incident/${s.id}`}>
                    {s.ref} {s.title}
                  </Link>{' '}
                  <span className="muted small">
                    ({s.affects_count + 1} affected{s.own ? ', yours' : ''})
                  </span>
                </li>
              ))}
            </ul>
            <p className="small muted">If yours is genuinely different, carry on below.</p>
          </Banner>
        )}

        <p className="muted small">Reported {dateTime(openedAt.current.toISOString())} (recorded automatically)</p>
        <ErrorNote error={error} />
        <button className="btn primary block big" disabled={!ready || busy} onClick={submit}>
          {busy ? 'Sending...' : 'Send report'}
        </button>
        {!ready && (
          <p className="muted small center">
            {photos.length === 0 ? 'Add a photo' : title.trim().length < 3 ? 'Add a short title' : !category ? 'Pick a type' : ''} to continue.
          </p>
        )}
        <p className="center">
          <button className="btn ghost small" onClick={() => nav(-1)}>
            Cancel
          </button>
        </p>
      </section>
    </div>
  );
}
