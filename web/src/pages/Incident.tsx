import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CATEGORY_LABELS, OPEN_STATUSES, STATUS_LABELS, api, dateTime, duration, type IncidentDetail, type IncidentEvent, type Status } from '../api';
import { useAuth } from '../auth';
import { Banner, ErrorNote, Field, PhotoButton, Sheet, Spinner, Stamp, shrinkImage, useAsync } from '../ui';

export function eventText(e: IncidentEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'reported':
      return `${e.actor} reported this${p.photos ? ` with ${p.photos} photo${p.photos === 1 ? '' : 's'}` : ''}.`;
    case 'imported':
      return 'Added from the historic issues list.';
    case 'email_queued':
      return 'Email to management queued.';
    case 'email_sent':
      return p.kind === 'mgmt_affects' ? 'Additional resident report emailed to the management company.' : p.kind === 'mgmt_resend' ? 'Reminder emailed to the management company.' : 'Report emailed to the management company.';
    case 'email_failed':
      return 'Email to management failed - will be retried.';
    case 'case_number_added':
      return `${e.actor === 'System' ? 'Management' : e.actor} recorded case number ${p.case_number}${p.source === 'inbound_email' ? ' (from their email reply)' : ''}.`;
    case 'status_changed':
      return `Marked ${STATUS_LABELS[p.to as Status]?.toLowerCase() ?? p.to} by ${e.actor}.${p.note ? ` "${p.note}"` : ''}`;
    case 'mgmt_closed':
      return `Management marked this closed (recorded by ${e.actor}). Not yet verified by a resident.${p.note ? ` "${p.note}"` : ''}`;
    case 'resolved_ok':
      return `${e.actor} confirmed it is fixed${p.admin_override ? ' (moderator, no photo)' : ' with a photo'}.${p.note ? ` "${p.note}"` : ''}`;
    case 'resolved_poor':
      return `${e.actor} reports it was closed but poorly fixed${p.admin_override ? '' : ', with a photo'}.${p.note ? ` "${p.note}"` : ''}`;
    case 'reopened':
      return `${e.actor} reopened it - the problem is still there.${p.note ? ` "${p.note}"` : ''}`;
    case 'withdrawn':
      return 'Report withdrawn.';
    case 'note_added':
      return `${e.actor}${e.internal ? ' (internal note)' : ''}: "${p.text}"`;
    case 'affects_added':
      return `A neighbour confirmed they are also affected (${(p.affects_count ?? 0) + 1} residents now).`;
    case 'linked':
      return p.primary ? `Linked to ${p.primary} as the same problem.` : `${p.linked} related report${p.linked === 1 ? '' : 's'} linked here.`;
    case 'unlinked':
      return 'Unlinked from its group.';
    case 'edited':
      return `Details edited by ${e.actor}.`;
    case 'mgmt_reply_received':
      return `Management replied${p.case_number_found ? ` (case ${p.case_number_found})` : ''}${p.snippet ? `: "${String(p.snippet).slice(0, 220)}"` : '.'}`;
    case 'reminder_sent':
      return 'Reminder sent.';
    default:
      return e.type;
  }
}

export function Timeline({ events }: { events: IncidentEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.n} className={e.internal ? 'internal' : ''}>
          <time dateTime={e.at}>{dateTime(e.at)}</time>
          <span>{eventText(e)}</span>
        </li>
      ))}
    </ol>
  );
}

function slaTone(s: string) {
  return s === 'met' ? 'ok' : s === 'breached' || s === 'poor_fix' ? 'bad' : 'wait';
}

export function KpiStrip({ d, slaHours }: { d: IncidentDetail; slaHours?: number }) {
  const k = d.kpis;
  const open = OPEN_STATUSES.includes(d.status) || d.status === 'mgmt_closed';
  return (
    <div className="kpi-strip">
      <div className="kpi">
        <b>{k.age_days < 1 ? '<1' : Math.round(k.age_days)}d</b>
        <span>{open ? 'open for' : 'time open'}</span>
      </div>
      <div className={`kpi ${slaTone(k.acknowledgement_sla)}`}>
        <b>{k.hours_to_acknowledgement != null ? duration(k.hours_to_acknowledgement) : k.acknowledgement_sla === 'breached' ? 'No reply' : 'Waiting'}</b>
        <span>to case no.{slaHours ? ` (target ${slaHours}h)` : ''}</span>
      </div>
      <div className="kpi">
        <b>{d.affects_count + 1}</b>
        <span>residents affected</span>
      </div>
      <div className={`kpi ${k.disputed_closure ? 'bad' : ''}`}>
        <b>{k.management_closures}</b>
        <span>mgmt closures{k.reopen_count ? `, ${k.reopen_count} reopened` : ''}</span>
      </div>
    </div>
  );
}

export function PhotoStrip({ photos }: { photos: IncidentDetail['photos'] }) {
  const kinds: Record<string, string> = { report: 'Reported', resolution: 'Resolution evidence', affects: 'Also affected' };
  if (!photos.length) return null;
  return (
    <div className="photo-strip">
      {photos.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="strip-item">
          <img src={p.thumb_url} alt={`${kinds[p.kind] ?? 'Photo'} photo`} loading="lazy" />
          <span>{kinds[p.kind] ?? p.kind}</span>
        </a>
      ))}
    </div>
  );
}

/** Photo-evidence sheet used for "fixed", "poorly fixed" and "affects me". */
export function EvidenceSheet({
  title,
  intro,
  kind,
  required,
  confirmLabel,
  onClose,
  onSubmit,
  withNote,
  withCase,
}: {
  title: string;
  intro: React.ReactNode;
  kind: 'resolution' | 'affects';
  required: boolean;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (uploadId: string | null, note: string, caseNo: string) => Promise<void>;
  withNote?: boolean;
  withCase?: boolean;
}) {
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [caseNo, setCaseNo] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function pick(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', await shrinkImage(file), 'photo.jpg');
      form.append('kind', kind);
      const r = await api.upload<{ id: string; thumb_url: string }>('/uploads', form);
      setPhoto({ id: r.id, url: r.thumb_url });
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(photo?.id ?? null, note, caseNo);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        <div>{intro}</div>
        {photo ? (
          <div className="photo-tile wide">
            <img src={photo.url} alt="Your evidence" />
            <button className="x" aria-label="Remove photo" onClick={() => setPhoto(null)}>
              ×
            </button>
          </div>
        ) : (
          <PhotoButton onFile={pick} busy={uploading} label={required ? 'Take a photo (required)' : 'Add a photo (optional)'} />
        )}
        {withNote && (
          <Field label="Note (optional)">
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        )}
        {withCase && (
          <Field label="Your own incident ID from the management company (optional)" hint="Report it to them too and enter the reference you get back. You can add it later.">
            <input value={caseNo} onChange={(e) => setCaseNo(e.target.value)} maxLength={40} placeholder="e.g. SR-10234" />
          </Field>
        )}
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy || (required && !photo)} onClick={go}>
          {busy ? 'Saving...' : confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

export function IncidentPage() {
  const { id } = useParams();
  const { me, refreshUnread } = useAuth();
  const nav = useNavigate();
  const q = useAsync(() => api.get<IncidentDetail>(`/incidents/${id}`), [id]);
  const [search] = useSearchParams();
  const [sheet, setSheet] = useState<null | 'ok' | 'poor' | 'affects'>(search.get('affects') === '1' ? 'affects' : null);
  const [myCase, setMyCase] = useState('');
  const [caseNo, setCaseNo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      q.reload();
      void refreshUnread();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (q.loading && !d) return <div className="page"><Spinner /></div>;
  if (!d) return <div className="page"><ErrorNote error={q.error} /><Link to="/">Back</Link></div>;

  const p = d.permissions;
  const open = OPEN_STATUSES.includes(d.status);
  const awaiting = d.status === 'mgmt_closed';
  const setStatus = (to: string, uploadId?: string | null, note?: string) => api.post(`/incidents/${d.id}/status`, { to, upload_id: uploadId ?? undefined, note: note || undefined });

  return (
    <div className="page">
      <button className="btn ghost small back" onClick={() => nav(-1)}>
        ← Back
      </button>
      <header className="page-head">
        <div className="card-top">
          <span className="ref">{d.ref}</span>
          <Stamp status={d.status} />
        </div>
        <h1>{d.title}</h1>
        <div className="meta">
          <span>{CATEGORY_LABELS[d.category] ?? d.category}</span>
          <span>{d.tower}{d.unit ? `, apt ${d.unit}` : ''}</span>
          {d.severity !== 'normal' && <span className="pill">{d.severity === 'urgent' ? 'Safety risk' : d.severity}</span>}
          {d.visibility === 'private' && <span className="pill">Private</span>}
        </div>
        <p className="muted small">Reported {dateTime(d.reported_at)}{d.emailed_at ? ` · emailed to management ${dateTime(d.emailed_at)}` : ' · email pending'}</p>
      </header>

      <PhotoStrip photos={d.photos} />
      {d.description && <p className="desc">{d.description}</p>}
      {d.location_text && <p className="muted">📍 {d.location_text}{d.gps_blurred ? ' (approximate area shared)' : ''}</p>}

      <KpiStrip d={d} slaHours={me?.config.sla_case_hours} />

      {awaiting && p.can_act && (
        <Banner tone="warn" title="Management says this is closed">
          Is it really fixed? Your photo is the evidence that counts on the scorecard.
        </Banner>
      )}
      {d.status === 'resolved_poor' && <Banner tone="danger">Residents report this was closed but not fixed properly.</Banner>}

      <section className="panel">
        <h2>Management case number</h2>
        {d.mgmt_case_number ? (
          <p className="case-no">
            {d.mgmt_case_number} <span className="muted small">received {dateTime(d.case_number_at)}</span>
          </p>
        ) : (
          <p className="muted">The management company hasn't given a case number yet.</p>
        )}
        {p.can_act && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post(`/incidents/${d.id}/case-number`, { case_number: caseNo });
                setCaseNo('');
              });
            }}
          >
            <input value={caseNo} onChange={(e) => setCaseNo(e.target.value)} placeholder={d.mgmt_case_number ? 'Update case number' : 'Enter case number from their reply'} aria-label="Case number" />
            <button className="btn" disabled={busy || caseNo.trim().length < 3}>
              Save
            </button>
          </form>
        )}
      </section>

      {p.i_affect && (
        <section className="panel">
          <h2>Your own incident ID</h2>
          <p className="muted small">Report this to the management company yourself too, then enter the reference they give you. It is recorded against your apartment.</p>
          {p.my_case_number && <p className="case-no">{p.my_case_number}</p>}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post(`/incidents/${d.id}/my-case-number`, { case_number: myCase });
                setMyCase('');
              });
            }}
          >
            <input value={myCase} onChange={(e) => setMyCase(e.target.value)} placeholder={p.my_case_number ? 'Update your incident ID' : 'Enter your incident ID'} aria-label="Your incident ID" maxLength={40} />
            <button className="btn" disabled={busy || myCase.trim().length < 3}>
              Save
            </button>
          </form>
        </section>
      )}

      <ErrorNote error={error} />

      {(p.can_act || p.can_affect) && d.status !== 'withdrawn' && (
        <section className="panel actions">
          <h2>What's happening?</h2>
          {p.can_affect && (
            <div className="stack">
              <button className="btn primary block" onClick={() => setSheet('affects')}>
                This affects me too
              </button>
              <p className="muted small">Counts you in and emails the management company under your apartment. Only use it if you're really affected.</p>
            </div>
          )}
          {p.can_act && open && (
            <div className="stack">
              <button className="btn block" disabled={busy} onClick={() => run(() => setStatus('mgmt_closed'))}>
                Management says it's closed
              </button>
              <div className="row">
                <button className="btn good block" onClick={() => setSheet('ok')}>
                  ✓ It's fixed
                </button>
                <button className="btn bad block" onClick={() => setSheet('poor')}>
                  ✗ Closed, but badly fixed
                </button>
              </div>
            </div>
          )}
          {p.can_act && awaiting && (
            <div className="stack">
              <div className="row">
                <button className="btn good block" onClick={() => setSheet('ok')}>
                  ✓ Yes, fixed
                </button>
                <button className="btn bad block" onClick={() => setSheet('poor')}>
                  ✗ Not fixed properly
                </button>
              </div>
              <button className="btn block" disabled={busy} onClick={() => run(() => setStatus('reopened'))}>
                Reopen: problem is still there
              </button>
            </div>
          )}
          {p.can_act && (d.status === 'resolved_ok' || d.status === 'resolved_poor') && (
            <button className="btn block" disabled={busy} onClick={() => run(() => setStatus('reopened'))}>
              Problem is back - reopen
            </button>
          )}
          {p.is_mine && open && d.affects_count === 0 && (
            <button className="btn ghost small" disabled={busy} onClick={() => confirm('Withdraw this report?') && run(() => setStatus('withdrawn').then(() => nav('/')))}>
              Withdraw my report
            </button>
          )}
        </section>
      )}

      {d.linked.length > 0 && (
        <section className="panel">
          <h2>Same problem, linked reports</h2>
          <ul className="plain">
            {d.linked.map((l) => (
              <li key={l.id}>
                <Link to={`/incident/${l.id}`}>
                  {l.ref} {l.title}
                </Link>{' '}
                <Stamp status={l.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>History</h2>
        <Timeline events={d.events} />
        {p.can_act && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post(`/incidents/${d.id}/note`, { text: note });
                setNote('');
              });
            }}
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an update (visible to neighbours)" aria-label="Add an update" maxLength={1500} />
            <button className="btn" disabled={busy || !note.trim()}>
              Post
            </button>
          </form>
        )}
      </section>

      {sheet === 'affects' && (
        <EvidenceSheet
          title="This affects me too"
          kind="affects"
          withCase
          required={p.affect_needs_photo}
          confirmLabel="Add me and email the management company"
          intro={
            <>
              <p>
                Your tower and apartment ({me?.user?.tower}, {me?.user?.unit}) will be emailed to the management company as an additional resident affected.
              </p>
              {p.affect_needs_photo && <p>Please take a new photo showing how it affects you, so each addition is real evidence.</p>}
              <p className="muted small">Not the same problem, or you don't want neighbours to see it? Log a separate report instead.</p>
            </>
          }
          onClose={() => setSheet(null)}
          onSubmit={async (upload, _note, caseNo) => {
            await api.post(`/incidents/${d.id}/affects`, { upload_id: upload, case_number: caseNo.trim() || undefined });
            setSheet(null);
            q.reload();
          }}
        />
      )}
      {(sheet === 'ok' || sheet === 'poor') && (
        <EvidenceSheet
          title={sheet === 'ok' ? 'Confirm it is fixed' : 'Closed, but not fixed properly'}
          kind="resolution"
          required
          withNote
          confirmLabel={sheet === 'ok' ? 'Confirm fixed' : 'Report poor repair'}
          intro={<p>{sheet === 'ok' ? 'Take a photo of the area as it is now.' : 'Take a photo showing the problem as it is now. This is recorded as evidence on the scorecard.'}</p>}
          onClose={() => setSheet(null)}
          onSubmit={async (upload, n) => {
            await setStatus(sheet === 'ok' ? 'resolved_ok' : 'resolved_poor', upload, n);
            setSheet(null);
            q.reload();
          }}
        />
      )}
    </div>
  );
}
