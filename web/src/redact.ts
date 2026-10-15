/**
 * On-device photo redaction.
 *
 * Every photo is decoded, checked for faces and covered by the resident BEFORE anything is uploaded.
 * The original file never leaves the phone: only the re-drawn canvas is exported. Re-drawing also drops
 * all embedded metadata (EXIF, GPS, device identifiers, embedded thumbnails).
 *
 * Face detection uses Google's MediaPipe BlazeFace models (Apache-2.0), served from our own origin
 * (see web/scripts/copy-face-model.mjs). No photo and no request goes to a third party.
 * Number plates are NOT detected automatically yet: the resident covers them by hand in the review step.
 *
 * Fail closed: if the photo cannot be decoded or drawn, nothing is returned and nothing is uploaded.
 */

/** A rectangle in normalised image coordinates (0..1). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  auto: boolean;
}

export const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;
/** Extra margin around every covered area so partly detected faces are fully hidden. */
const MARGIN = 0.3;
/** The covered area is reduced to about this many blocks along its longer side (coarse enough to be irreversible). */
const BLOCKS = 6;

export class RedactError extends Error {
  constructor(public code: 'unsupported' | 'failed', message: string) {
    super(message);
  }
}

export interface LoadedPhoto {
  /** The decoded, orientation-corrected, resized original. Never uploaded. */
  source: HTMLCanvasElement;
}

/** Decode a photo file into a canvas, honouring EXIF orientation, scaled to at most MAX_EDGE. */
export async function loadPhoto(file: Blob): Promise<LoadedPhoto> {
  let bmp: ImageBitmap | HTMLImageElement | null = null;
  let url: string | null = null;
  try {
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      bmp = img;
    }
    const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
    const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
    if (!w || !h) throw new Error('empty image');
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const source = document.createElement('canvas');
    source.width = Math.max(1, Math.round(w * scale));
    source.height = Math.max(1, Math.round(h * scale));
    const ctx = source.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bmp, 0, 0, source.width, source.height);
    return { source };
  } catch {
    throw new RedactError('unsupported', 'This photo could not be read on your device.');
  } finally {
    if (bmp && 'close' in bmp) bmp.close();
    if (url) URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- face detection (MediaPipe BlazeFace)
// The detector runs in an isolated same-origin page (/face/face-worker.html) with its own Content-Security-Policy,
// because its WebAssembly glue needs 'unsafe-eval', which the main app must never allow.

const FRAME_URL = '/face/face-worker.html';
let frame: Promise<HTMLIFrameElement> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>();
let listening = false;

function onMessage(ev: MessageEvent) {
  if (ev.origin !== window.location.origin) return;
  const m = ev.data as { type?: string; id?: number; message?: string };
  if (m?.id == null) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message ?? 'Face check failed'));
  else p.resolve(m as Record<string, unknown>);
}

function resetFrame() {
  frame?.then((f) => f.remove()).catch(() => undefined);
  frame = null;
  for (const [, p] of pending) p.reject(new Error('Face check stopped'));
  pending.clear();
}

function getFrame(): Promise<HTMLIFrameElement> {
  if (!listening) {
    window.addEventListener('message', onMessage);
    listening = true;
  }
  if (!frame) {
    frame = new Promise<HTMLIFrameElement>((resolve, reject) => {
      const f = document.createElement('iframe');
      f.src = FRAME_URL;
      f.title = 'Face check (hidden)';
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
      const timer = setTimeout(() => reject(new Error('Face check did not start')), 20_000);
      const onLoaded = (ev: MessageEvent) => {
        if (ev.source !== f.contentWindow || ev.origin !== window.location.origin || (ev.data as { type?: string })?.type !== 'loaded') return;
        clearTimeout(timer);
        window.removeEventListener('message', onLoaded);
        resolve(f);
      };
      window.addEventListener('message', onLoaded);
      document.body.appendChild(f);
    }).catch((e) => {
      resetFrame(); // allow a retry on the next photo
      throw e;
    });
  }
  return frame;
}

async function callFrame(msg: Record<string, unknown>, transfer: Transferable[] = [], timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const f = await getFrame();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resetFrame();
      reject(new Error('Face check timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => (clearTimeout(timer), resolve(m)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    f.contentWindow!.postMessage({ ...msg, id }, window.location.origin, transfer);
  });
}

const iou = (a: Box, b: Box) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
};
const containedShare = (a: Box, b: Box) => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return a.w * a.h > 0 ? inter / (a.w * a.h) : 0;
};

/** Merge boxes found by overlapping passes: keep the larger of any pair that mostly overlaps. */
export function mergeBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  const kept: Box[] = [];
  for (const b of sorted) {
    if (!kept.some((k) => iou(k, b) > 0.3 || containedShare(b, k) > 0.7)) kept.push(b);
  }
  return kept;
}

/**
 * Looks for faces on the whole photo and on overlapping tiles (done inside the isolated page).
 * Returns merged boxes in normalised coordinates. Throws if the detector cannot run: the caller must then fail closed.
 */
export async function detectFaces(source: HTMLCanvasElement): Promise<Box[]> {
  await callFrame({ type: 'init' }, [], 60_000); // first use downloads the ~7 MB runtime
  const bitmap = await createImageBitmap(source);
  const res = (await callFrame({ type: 'detect', bitmap }, [bitmap])) as { boxes?: Omit<Box, 'auto'>[] };
  const found = (res.boxes ?? []).map((b) => ({ ...b, auto: true }));
  return mergeBoxes(found.map(clampBox).filter((b) => b.w > 0.004 && b.h > 0.004));
}

export function clampBox(b: Box): Box {
  const x = Math.min(1, Math.max(0, b.x));
  const y = Math.min(1, Math.max(0, b.y));
  return { ...b, x, y, w: Math.min(1 - x, Math.max(0, b.x + b.w - x)), h: Math.min(1 - y, Math.max(0, b.y + b.h - y)) };
}

// ---------------------------------------------------------------- irreversible covering

/** Pixelate a rectangle (in canvas pixels) so coarsely that the content cannot be recovered. */
function pixelate(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, px: number, py: number, pw: number, ph: number) {
  const block = Math.max(8, Math.ceil(Math.max(pw, ph) / BLOCKS));
  const sw = Math.max(1, Math.ceil(pw / block));
  const sh = Math.max(1, Math.ceil(ph / block));
  const tiny = document.createElement('canvas');
  tiny.width = sw;
  tiny.height = sh;
  const tctx = tiny.getContext('2d')!;
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(source, px, py, pw, ph, 0, 0, sw, sh); // averages each block
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, sw, sh, px, py, pw, ph);
  ctx.restore();
}

/** Draws the photo with every box covered. Used for the live preview and for the final export. */
export function paintRedacted(target: HTMLCanvasElement, source: HTMLCanvasElement, boxes: Box[]) {
  target.width = source.width;
  target.height = source.height;
  const ctx = target.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  for (const b of boxes) {
    const mx = b.w * MARGIN;
    const my = b.h * MARGIN;
    const x0 = Math.max(0, Math.floor((b.x - mx) * source.width));
    const y0 = Math.max(0, Math.floor((b.y - my) * source.height));
    const x1 = Math.min(source.width, Math.ceil((b.x + b.w + mx) * source.width));
    const y1 = Math.min(source.height, Math.ceil((b.y + b.h + my) * source.height));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    pixelate(ctx, source, x0, y0, x1 - x0, y1 - y0);
  }
}

/** Exports the covered photo as a fresh JPEG (no metadata of any kind). */
export function exportRedacted(source: HTMLCanvasElement, boxes: Box[]): Promise<Blob> {
  const out = document.createElement('canvas');
  paintRedacted(out, source, boxes);
  return new Promise((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new RedactError('failed', 'Could not prepare the photo.'))), 'image/jpeg', JPEG_QUALITY);
  });
}
