import { AppError } from '@/shared/errors/app-error.js';

/**
 * Shared upload guards. These rules were duplicated byte-for-byte in
 * `modules/uploads/uploads.controller.ts` and `modules/retailer/media/media.controller.ts`;
 * both now call in here so the cap and the format list can only drift on purpose.
 */

/** App-level `@fastify/multipart` ceiling (see app.ts). Quoted in the error message. */
export const MULTIPART_MAX_BYTES = 25 * 1024 * 1024;

/** Listing media (gallery + rich-description images) carry a tighter cap per US-5.2.4. */
export const LISTING_GALLERY_MAX_BYTES = 5 * 1024 * 1024;
export const LISTING_GALLERY_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** The upload purposes that opt into the tighter listing rules. */
export type UploadPurpose = string | undefined;

export function isListingPurpose(purpose: UploadPurpose): boolean {
  return purpose === 'listing-gallery' || purpose === 'listing-description';
}

/**
 * Enforce the listing cap and format allowlist. No-op for other purposes.
 *
 * `mimetype` is the client-declared type today. Once the storage layer sniffs bytes, pass
 * the sniffed type instead — the driver-app sends `image/jpeg` for every photo regardless
 * of what the camera produced, so the declared value is known-unreliable.
 */
export function assertListingMedia(
  purpose: UploadPurpose,
  bytes: number,
  mimetype: string,
): void {
  if (!isListingPurpose(purpose)) return;
  if (bytes > LISTING_GALLERY_MAX_BYTES) {
    throw AppError.validation('File too large — listing images are capped at 5 MB');
  }
  if (!LISTING_GALLERY_MIMES.has(mimetype)) {
    throw AppError.validation(
      `Unsupported format '${mimetype}' — listing images must be JPEG, PNG, or WebP`,
    );
  }
}

/**
 * Festival-theme assets carry per-purpose caps: this art ships to every phone on every
 * launch, so a 9 MB overlay is a bug, not a choice. Lottie files are additionally sanity
 * checked as Lottie (a `v` string, a `layers` array, a numeric `op`) so an arbitrary JSON
 * blob cannot masquerade as an animation.
 */
export const THEME_UPLOAD_RULES: Readonly<
  Record<string, { maxBytes: number; label: string; mimes: ReadonlySet<string> }>
> = {
  'theme-wordmark': {
    maxBytes: 1 * 1024 * 1024,
    label: '1 MB',
    mimes: new Set(['image/png', 'image/webp']),
  },
  'theme-overlay': {
    maxBytes: 2 * 1024 * 1024,
    label: '2 MB',
    mimes: new Set(['image/png', 'image/webp']),
  },
  'theme-lottie': {
    maxBytes: 512 * 1024,
    label: '512 KB',
    mimes: new Set(['application/json']),
  },
};

export function isThemePurpose(purpose: UploadPurpose): boolean {
  return purpose !== undefined && purpose in THEME_UPLOAD_RULES;
}

export function assertLottieJson(buffer: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw AppError.validation('File is not valid JSON');
  }
  const p = parsed as { v?: unknown; layers?: unknown; op?: unknown } | null;
  if (
    typeof p !== 'object' ||
    p === null ||
    typeof p.v !== 'string' ||
    !Array.isArray(p.layers) ||
    typeof p.op !== 'number' ||
    !Number.isFinite(p.op)
  ) {
    throw AppError.validation(
      'File is not a Lottie animation - expected JSON with "v", "layers" and a numeric "op"',
    );
  }
}

/** Enforce the theme caps and formats. No-op for other purposes. */
export function assertThemeMedia(
  purpose: UploadPurpose,
  bytes: number,
  mimetype: string,
  buffer: Buffer,
): void {
  if (purpose === undefined) return;
  const rule = THEME_UPLOAD_RULES[purpose];
  if (!rule) return;
  if (bytes > rule.maxBytes) {
    throw AppError.validation(`File too large - ${purpose} uploads are capped at ${rule.label}`);
  }
  if (!rule.mimes.has(mimetype)) {
    throw AppError.validation(
      `Unsupported format '${mimetype}' for ${purpose} - allowed: ${[...rule.mimes].join(', ')}`,
    );
  }
  if (purpose === 'theme-lottie') assertLottieJson(buffer);
}

/** The plugin truncates silently at the limit, so this must be checked after reading. */
export function assertNotTruncated(truncated: boolean): void {
  if (truncated) {
    throw AppError.validation('File too large — limit is 25 MB');
  }
}
