import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorNote, Spinner, copyText } from './ui';

interface Draft {
  kind: 'new' | 'affects';
  to: string;
  subject: string;
  body: string;
  confirmed_at: string | null;
}

export const mailtoHref = (d: Pick<Draft, 'to' | 'subject' | 'body'>) =>
  `mailto:${d.to}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body.replace(/\n/g, '\r\n'))}`;

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
        Your report is saved. To make sure management takes it seriously, send it to <strong>{draft.to}</strong> from your own email. It is already written for you, with your photo links.
      </p>
      <a className="btn primary block big" href={mailtoHref(draft)}>
        Open my email app
      </a>
      <p className="muted small">Press Send in your email app, then come back and tap the button below.</p>
      <button className="btn block" onClick={confirm} disabled={busy}>
        {busy ? 'Saving...' : "I've sent it"}
      </button>
      <button
        className="btn ghost block"
        onClick={async () => {
          const ok = await copyText(`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`);
          setNote(ok ? 'Email text copied. Paste it into a new email.' : 'Could not copy automatically.');
        }}
      >
        No email app? Copy the email text
      </button>
      {note && <p className="share-note" role="status">{note}</p>}
    </div>
  );
}
