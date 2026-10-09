import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, STATUS_LABELS, type Status } from './api';

export function Stamp({ status }: { status: Status }) {
  return <span className={`stamp stamp-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function Banner({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: string; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="dot" /> {label}...
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong';
  return <Banner tone="danger">{msg}</Banner>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      <span>
        <strong>{label}</strong>
        {hint && <span className="hint block">{hint}</span>}
      </span>
    </label>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Camera / gallery picker that shrinks the photo on the device before upload (saves mobile data). */
export async function shrinkImage(file: File, maxEdge = 1600, quality = 0.82): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob ?? file;
  } catch {
    return file; // e.g. HEIC the browser cannot decode: server will try
  }
}

export function PhotoButton({ onFile, label = 'Take or choose photo', capture = true, busy }: { onFile: (f: File) => void; label?: string; capture?: boolean; busy?: boolean }) {
  return (
    <label className={`btn photo-btn ${busy ? 'disabled' : ''}`}>
      <span aria-hidden>📷</span> {busy ? 'Uploading...' : label}
      <input
        type="file"
        accept="image/*"
        {...(capture ? { capture: 'environment' as const } : {})}
        hidden
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

/** Copy text to the clipboard. Falls back to the old select-and-copy method, which still works on plain http (e.g. a home server). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Share a link that opens the report straight into "This affects me too". WhatsApp-first. */
export function ShareButton({ shareUrl, refLabel, title, groupUrl }: { shareUrl: string; refLabel?: string; title: string; groupUrl?: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const message = `Same problem in our building? "${title}"${refLabel ? ` (${refLabel})` : ''}. Tap to add yourself in two taps:\n${shareUrl}`;
  const flash = (t: string) => {
    setNote(t);
    setTimeout(() => setNote(null), 3500);
  };
  async function copy(text: string, done: string) {
    flash((await copyText(text)) ? done : 'Could not copy automatically. Press and hold the text above to copy it.');
  }
  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;
  return (
    <>
      <button type="button" className="btn block share-btn" onClick={() => setOpen(true)}>
        Share with neighbours
      </button>
      {open && (
        <Sheet title="Share with neighbours" onClose={() => setOpen(false)}>
          <div className="stack">
            <p className="muted small">Neighbours who open this sign in, then add themselves to your report with a photo. The preview shows your report's photo and title.</p>
            <a className="btn block whatsapp-btn" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
              Send on WhatsApp
            </a>
            {groupUrl && (
              <button
                type="button"
                className="btn block"
                onClick={async () => {
                  const ok = await copyText(message);
                  flash(ok ? 'Message copied. Paste it into the group.' : 'Open the group and paste the link from "Copy link".');
                  window.open(groupUrl, '_blank', 'noopener');
                }}
              >
                Post in our WhatsApp group
              </button>
            )}
            <button type="button" className="btn block" onClick={() => copy(message, 'Message and link copied.')}>
              Copy message and link
            </button>
            <button type="button" className="btn block" onClick={() => copy(shareUrl, 'Link copied.')}>
              Copy link only
            </button>
            {canNativeShare && (
              <button type="button" className="btn block" onClick={() => navigator.share({ title: 'Neighbourhood report', text: message, url: shareUrl }).catch(() => undefined)}>
                More apps...
              </button>
            )}
            <textarea className="share-text" readOnly rows={4} value={message} onFocus={(e) => e.currentTarget.select()} aria-label="Message to share" />
            {note && <p className="share-note" role="status">{note}</p>}
          </div>
        </Sheet>
      )}
    </>
  );
}
