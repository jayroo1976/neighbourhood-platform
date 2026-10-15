import { useCallback, useEffect, useRef, useState } from 'react';
import { RedactError, clampBox, detectFaces, exportRedacted, loadPhoto, paintRedacted, type Box } from './redact';

/**
 * Review screen shown for EVERY photo before upload (report, "affects me", resolution photos).
 * Faces are found and covered automatically; the resident checks the result and can drag a box over anything else
 * (number plates, papers, children, screens) or tap a box to remove it. Only the covered image is ever returned.
 */

export class RedactCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Req {
  file: File;
  resolve: (b: Blob) => void;
  reject: (e: unknown) => void;
}
let openSheet: ((r: Req) => void) | null = null;

/** Opens the review screen and resolves with the covered JPEG. Rejects with RedactCancelled if the resident backs out. */
export function redactPhoto(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!openSheet) return reject(new RedactError('failed', 'Photo checking is not ready. Please reload the page.'));
    openSheet({ file, resolve, reject });
  });
}

/** Mount once near the top of the app. */
export function RedactionHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => {
    openSheet = (r) => setReq(r);
    return () => {
      openSheet = null;
    };
  }, []);
  if (!req) return null;
  return (
    <RedactSheet
      file={req.file}
      onDone={(b) => {
        req.resolve(b);
        setReq(null);
      }}
      onFail={(e) => {
        req.reject(e);
        setReq(null);
      }}
    />
  );
}

type Status = 'reading' | 'looking' | 'found' | 'unavailable' | 'unreadable';

const MIN_DRAG = 0.02;

function RedactSheet({ file, onDone, onFail }: { file: File; onDone: (b: Blob) => void; onFail: (e: unknown) => void }) {
  const [status, setStatus] = useState<Status>('reading');
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [autoCount, setAutoCount] = useState(0);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const source = useRef<HTMLCanvasElement | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { source: src } = await loadPhoto(file);
        if (dead) return;
        source.current = src;
        setReady(true);
        setStatus('looking');
        try {
          const found = await detectFaces(src);
          if (dead) return;
          setBoxes((b) => [...found, ...b.filter((x) => !x.auto)]);
          setAutoCount(found.length);
          setStatus('found');
        } catch (e) {
          console.warn('Automatic face check unavailable', e);
          if (!dead) setStatus('unavailable'); // fail closed: the resident must cover faces by hand
        }
      } catch {
        if (!dead) setStatus('unreadable');
      }
    })();
    return () => {
      dead = true;
    };
  }, [file]);

  // live preview = exactly what will be uploaded
  useEffect(() => {
    if (ready && source.current && preview.current) paintRedacted(preview.current, source.current, boxes);
  }, [ready, boxes]);

  const cancel = useCallback(() => onFail(new RedactCancelled()), [onFail]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const point = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: React.PointerEvent) => {
    if (!ready) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = point(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const up = () => {
    if (!drag) return;
    const { x0, y0, x1, y1 } = drag;
    setDrag(null);
    if (Math.abs(x1 - x0) < MIN_DRAG && Math.abs(y1 - y0) < MIN_DRAG) {
      // a tap: remove the newest box under the finger
      const hit = [...boxes].reverse().find((b) => x0 >= b.x && x0 <= b.x + b.w && y0 >= b.y && y0 <= b.y + b.h);
      if (hit) setBoxes(boxes.filter((b) => b !== hit));
      return;
    }
    setBoxes([...boxes, clampBox({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), auto: false })]);
  };

  async function use() {
    if (!source.current) return;
    setBusy(true);
    try {
      onDone(await exportRedacted(source.current, boxes));
    } catch (e) {
      onFail(e);
    }
  }

  const message: Record<Status, string> = {
    reading: 'Opening your photo...',
    looking: 'Looking for faces...',
    found: autoCount > 0 ? `${autoCount} ${autoCount === 1 ? 'face' : 'faces'} covered automatically.` : 'No faces found automatically.',
    unavailable: 'Automatic face check is not available on this device. Please cover any faces yourself.',
    unreadable: 'This photo cannot be read on your device (for example some HEIC files). Please take a new photo, or choose a JPEG or PNG.',
  };

  return (
    <div className="redact" role="dialog" aria-modal="true" aria-label="Check your photo">
      <div className="redact-head">
        <h2>Check your photo</h2>
        <button className="btn ghost small" onClick={cancel}>
          Cancel
        </button>
      </div>
      <p className={`redact-status ${status === 'unavailable' || status === 'unreadable' ? 'warn' : ''}`} role="status">
        {message[status]}
      </p>
      {status !== 'unreadable' && (
        <>
          <div className="redact-area" ref={area} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}>
            <canvas ref={preview} className="redact-canvas" aria-label="Preview of the photo as it will be sent" />
            {boxes.map((b, i) => (
              <span key={i} className={`redact-box ${b.auto ? 'auto' : ''}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />
            ))}
            {drag && (
              <span
                className="redact-box drawing"
                style={{ left: `${Math.min(drag.x0, drag.x1) * 100}%`, top: `${Math.min(drag.y0, drag.y1) * 100}%`, width: `${Math.abs(drag.x1 - drag.x0) * 100}%`, height: `${Math.abs(drag.y1 - drag.y0) * 100}%` }}
              />
            )}
            {!ready && <div className="spinner" />}
          </div>
          <p className="muted small">
            <b>Drag</b> a box over anything else to hide: other faces, children, <b>number plates</b>, papers or screens. <b>Tap</b> a box to remove it. Number plates are not found automatically yet.
          </p>
        </>
      )}
      <div className="redact-actions">
        <button className="btn" onClick={() => setBoxes(boxes.slice(0, -1))} disabled={!boxes.length || busy}>
          Undo last box
        </button>
        <button className="btn primary big" onClick={use} disabled={!ready || status === 'reading' || status === 'looking' || busy || status === 'unreadable'}>
          {busy ? 'Preparing...' : 'Use this photo'}
        </button>
      </div>
      {status === 'unreadable' && (
        <button className="btn block" onClick={cancel}>
          Back
        </button>
      )}
    </div>
  );
}
