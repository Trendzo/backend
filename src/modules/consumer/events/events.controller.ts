import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  cartEvents,
  listingViews,
  productListings,
  variants,
} from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { CartAddBody, ListingViewBody } from './events.validators.js';

type Auth = AccessTokenPayload;

export async function recordListingView(input: {
  auth: Auth;
  body: z.infer<typeof ListingViewBody>;
}) {
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.body.listingId),
    columns: { id: true, storeId: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

  if (input.body.variantId) {
    const v = await db.query.variants.findFirst({
      where: eq(variants.id, input.body.variantId),
      columns: { id: true, listingId: true },
    });
    if (!v || v.listingId !== listing.id) {
      throw new AppError(404, ErrorCode.NotFound, 'Variant not found on this listing');
    }
  }

  const id = newId(IdPrefix.ListingView);
  await db.insert(listingViews).values({
    id,
    listingId: listing.id,
    variantId: input.body.variantId ?? null,
    storeId: listing.storeId,
    consumerId: input.auth.sub,
    sessionId: input.body.sessionId ?? null,
    source: input.body.source ?? null,
  });
  return ok({ id });
}

export async function recordCartAdd(input: { auth: Auth; body: z.infer<typeof CartAddBody> }) {
  const v = await db.query.variants.findFirst({
    where: eq(variants.id, input.body.variantId),
    columns: { id: true, listingId: true },
  });
  if (!v) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, v.listingId),
    columns: { storeId: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

  const id = newId(IdPrefix.CartEvent);
  await db.insert(cartEvents).values({
    id,
    listingId: v.listingId,
    variantId: v.id,
    storeId: listing.storeId,
    consumerId: input.auth.sub,
    qty: input.body.qty,
  });
  return ok({ id });
}
