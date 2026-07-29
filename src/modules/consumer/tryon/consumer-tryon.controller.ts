import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { productListings, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { uploadObject } from '@/shared/storage/index.js';
import { virtualTryOn } from '@/shared/vertex-tryon.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ConsumerTryOnBody } from './consumer-tryon.validators.js';

type Auth = AccessTokenPayload;

const TRYON_FOLDER = 'closetx/ai-tryon-consumer';

/**
 * Resolve the garment image URL from the client's reference, using ONLY the
 * server's own catalog data (never a client URL). Handles every product shape:
 *   - variantId with an image        → that variant's first image
 *   - variantId without an image     → falls back to the listing default
 *   - no variantId                   → the listing default (gallery) image
 *   - product with no images at all  → 422 (can't be tried on)
 */
async function resolveGarment(listingId: string, variantId?: string): Promise<string> {
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, listingId),
    columns: { galleryUrls: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Product not found');

  if (variantId) {
    const variant = await db.query.variants.findFirst({
      where: and(eq(variants.id, variantId), eq(variants.listingId, listingId)),
      columns: { imageUrls: true },
    });
    if (!variant) throw new AppError(404, ErrorCode.NotFound, 'Variant not found for this product');
    const variantUrl = variant.imageUrls?.[0];
    if (variantUrl) return variantUrl;
    // Variant has no image of its own — fall back to the listing default below.
  }

  const defaultUrl = listing.galleryUrls?.[0];
  if (defaultUrl) return defaultUrl;

  throw new AppError(422, ErrorCode.InvalidState, 'This product has no image to try on');
}

/**
 * Consumer virtual try-on: a person photo + one garment image (referenced by
 * variant, or the product default) → the person wearing it. Reuses the shared
 * Vertex `virtual-try-on-001` service. No store, no retailer permission — gated
 * only by consumer auth at the route.
 */
export async function tryOn(input: { auth: Auth; body: z.infer<typeof ConsumerTryOnBody> }) {
  const garmentUrl = await resolveGarment(input.body.listingId, input.body.variantId);

  const out = await virtualTryOn(input.body.personImageUrl, garmentUrl);
  const buffer = Buffer.from(out.base64, 'base64');
  // Result must be publicly reachable — both the app and (for any future
  // layering) Vertex fetch it server-side. uploadObject yields a public URL.
  const uploaded = await uploadObject(buffer, {
    folder: TRYON_FOLDER,
    resourceType: 'image',
    contentType: 'image/png',
  });
  return ok({ result: uploaded.url, steps: [uploaded.url] });
}
