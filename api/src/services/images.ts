import sharp from 'sharp';

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Re-encodes every upload as a fresh JPEG. Re-encoding drops ALL embedded metadata
 * (EXIF, GPS coordinates, device identifiers, thumbnails) – location is only ever taken
 * from what the resident explicitly shares in the report form.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const base = () => sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate();
  const { data: full, info } = await base()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await base()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
  return { full, thumb, width: info.width, height: info.height };
}

export async function resizeForAi(full: Buffer): Promise<Buffer> {
  return sharp(full).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
}
