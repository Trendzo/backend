import { z } from 'zod';

/**
 * Consumer virtual try-on request. The client picks WHICH garment image to use
 * by reference, never by URL:
 *   - omit `variantId`         → the listing's default (gallery) image
 *   - `variantId` of a variant → that variant's image (falls back to the default
 *                                 if the variant has no image of its own)
 * The server resolves the actual hosted URL from its own catalog data, so no
 * client-supplied URL is ever fetched server-side (SSRF guard) and no fragile
 * URL string-matching is needed.
 */
export const ConsumerTryOnBody = z.object({
  personImageUrl: z.string().url(),
  listingId: z.string().min(1),
  variantId: z.string().min(1).optional(),
});
