import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorNote, Spinner, copyText } from './ui';

interface Draft {
  kind: 'new' | 'affects' | 'followup';
  to: string;
  cc?: string | null;
  ref?: string;
  subject: string;
  body: string;
  confirmed_at: string | null;
}

export const mailtoHref = (d: Pick<Draft, 'to' | 'cc' | 'subject' | 'body'>) =>
  `mailto:${d.to}?${d.cc ? `cc=${encodeURIComponent(d.cc)}&` : ''}subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body.replace(/\n/g, '\r\n'))}`;

/**
 * The default way a report reaches management: the resident sends it from their own email app, so it comes
 * from them. The report is already saved on the platform; this panel opens the pre-written email and records
 * when they confirm it was sent.
 */
export function EmailPanel({ incidentId, autoOpen, onConfirmed }: { incidentId: string; autoOpen?: boolean; onConfirmed?: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const opened = useRef(false);

  useEffect(() => {
    api
      .get<Draft>(`/incidents/${incidentId}/email-draft`)
      .then((d) => {
        setDraft(d);
        setDone(!!d.confirmed_at);
        if (autoOpen && !d.confirmed_at && !opened.current) {
          opened.current = true;
          window.location.href = mailtoHref(d);
        }
      })
      .catch(setError);
  }, [incidentId, autoOpen]);

  if (error) return <ErrorNote error={error} />;
  if (!draft) return <Spinner />;
  if (done) return <p className="email-done">✓ You emailed the management company from your own email. The time is recorded.</p>;

  async function confirm() {
    setBusy(true);
    try {
      await api.post(`/incidents/${incidentId}/email-sent`);
      setDone(true);
      onConfirmed?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="email-panel">
      <h2>Send the email from your own account</h2>
      <p>
        Your report is saved. Send it to <strong>{draft.to}</strong> from your own email. It is already written for you, with your reference{draft.ref ? <> (<strong>{draft.ref}</strong>)</> : null} and photo links.
        {draft.cc ? <> Leave <strong>{draft.cc}</strong> on Cc: that is how replies and your sent email are matched to this report.</> : null}
      </p>
      <a className="btn primary block big" href={mailtoHref(draft)}>
        Open my email app
      </a>
      <p className="muted small">Press Send in your email app. If the Cc copy reaches the tracker, the sent time is recorded for you; otherwise come back and tap the button below.</p>
      <button className="btn block" onClick={confirm} disabled={busy}>
        {busy ? 'Saving...' : "I've sent it"}
      </button>
      <button
        className="btn ghost block"
        onClick={async () => {
          const ok = await copyText(`To: ${draft.to}\n${draft.cc ? `Cc: ${draft.cc}\n` : ''}Subject: ${draft.subject}\n\n${draft.body}`);
          setNote(ok ? 'Email text copied. Paste it into a new email.' : 'Could not copy automatically.');
        }}
      >
        No email app? Copy the email text
      </button>
      {note && <p className="share-note" role="status">{note}</p>}
    </div>
  );
}


/**
 * Follow-up for a ticket that was closed without saying the cause, the action taken or how it will be prevented.
 */
export function FollowUpPanel({ incidentId }: { incidentId: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    try {
      setDraft(await api.get<Draft>(`/incidents/${incidentId}/followup-draft`));
    } catch (e) {
      setError(e);
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!draft) {
    return (
      <button className="btn block" onClick={load}>
        Ask management for the closure details
      </button>
    );
  }
  return (
    <div className="email-panel">
      <p className="muted small">Asks politely for the cause, the work done and how it will be prevented. Send it from your own email.</p>
      <a className="btn primary block" href={mailtoHref(draft)}>
        Open my email app
      </a>
      <button
        className="btn ghost block"
        onClick={async () => {
          const ok = await copyText(`To: ${draft.to}\n${draft.cc ? `Cc: ${draft.cc}\n` : ''}Subject: ${draft.subject}\n\n${draft.body}`);
          setNote(ok ? 'Email text copied.' : 'Could not copy automatically.');
        }}
      >
        Copy the email text
      </button>
      {note && <p className="share-note" role="status">{note}</p>}
    </div>
  );
}
