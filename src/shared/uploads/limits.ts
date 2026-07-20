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

/** The plugin truncates silently at the limit, so this must be checked after reading. */
export function assertNotTruncated(truncated: boolean): void {
  if (truncated) {
    throw AppError.validation('File too large — limit is 25 MB');
  }
}
