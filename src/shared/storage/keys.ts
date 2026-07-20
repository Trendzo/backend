import { IdPrefix, newId } from '@/shared/ids.js';
import { AppError } from '@/shared/errors/app-error.js';

/**
 * Object-key construction.
 *
 * Keys look like `<folder>/<stem><ext>`, e.g. `reels/2026/07/med_a1b2….mp4`. The caller's
 * `folder` loses its `closetx/` stem (the bucket is already ClosetX-only, so re-encoding
 * the brand in every key is dead weight) and every segment is sanitised.
 */

/**
 * Collapse a string into a safe key segment. Replaces the three identical copies of
 * `sanitizePublicId` that lived in issuance.ts, commission-invoice.ts and pos-invoice.ts,
 * and adds the traversal guard those lacked.
 */
export function sanitizeKeySegment(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, '_');
  // A segment of only dots would traverse; the originals had no guard for this.
  if (/^\.+$/.test(cleaned)) {
    throw AppError.validation('Invalid storage key segment.');
  }
  return cleaned;
}

/**
 * Normalise a caller-supplied folder into a key prefix. Rejects traversal outright rather
 * than sanitising it away, so a malformed caller fails loudly instead of writing somewhere
 * surprising.
 */
export function normalizeFolder(folder: string | undefined): string {
  const raw = (folder ?? 'uploads').replace(/^\/+|\/+$/g, '');
  const withoutBrand = raw.replace(/^closetx\//, '');
  const segments = withoutBrand
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s === '.' || s === '..') {
        throw AppError.validation('Invalid storage folder.');
      }
      return sanitizeKeySegment(s);
    });
  return segments.length > 0 ? segments.join('/') : 'uploads';
}

/** Preferred file extension for a content type. Returns '' when nothing sensible applies. */
export function extensionFor(contentType: string | undefined): string {
  if (!contentType) return '';
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'text/csv': '.csv',
    'application/json': '.json',
  };
  return map[contentType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? '';
}

/**
 * Build the object key.
 *
 * With `publicId`, the key is fully deterministic so a re-upload overwrites in place —
 * invoice reissue depends on this. Without it, the stem is `yyyy/mm/<id>`: the date
 * segments keep prefixes browsable and make lifecycle rules easy to scope.
 *
 * The extension always comes from the resolved (sniffed) content type, never the client
 * filename. `webprotal`'s attachment-thumbs.tsx decides image-vs-chip rendering by testing
 * the URL for an image extension, so an always-correct extension is what keeps that working
 * without a Cloudinary-specific special case.
 */
export function buildObjectKey(opts: {
  folder?: string | undefined;
  publicId?: string | undefined;
  contentType?: string | undefined;
  now?: Date | undefined;
}): string {
  const folder = normalizeFolder(opts.folder);
  const ext = extensionFor(opts.contentType);

  if (opts.publicId !== undefined && opts.publicId !== '') {
    // Deterministic: honour any path structure the caller encoded, segment by segment.
    const stem = opts.publicId
      .split('/')
      .filter((s) => s.length > 0)
      .map(sanitizeKeySegment)
      .join('/');
    if (stem === '') throw AppError.validation('Invalid storage key.');
    // Don't double-suffix when the caller already ended with the right extension.
    const suffix = ext !== '' && !stem.toLowerCase().endsWith(ext) ? ext : '';
    return `${folder}/${stem}${suffix}`;
  }

  const now = opts.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${folder}/${yyyy}/${mm}/${newId(IdPrefix.Media)}${ext}`;
}

/** Prepend the environment namespace. Kept separate so `publicId` stays prefix-free. */
export function withKeyPrefix(key: string, prefix: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, '');
  return p === '' ? key : `${p}/${key}`;
}

/** Poster-frame key for a video object: `<dir>/thumbs/<name>.jpg`. */
export function thumbnailKeyFor(videoKey: string): string {
  const lastSlash = videoKey.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : videoKey.slice(0, lastSlash);
  const file = videoKey.slice(lastSlash + 1);
  const stem = file.replace(/\.[^.]+$/, '');
  return dir === '' ? `thumbs/${stem}.jpg` : `${dir}/thumbs/${stem}.jpg`;
}
