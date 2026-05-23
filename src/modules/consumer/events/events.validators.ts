import { z } from 'zod';

export const ListingViewBody = z.object({
  listingId: z.string().min(1),
  variantId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().max(64).optional(),
});

export const CartAddBody = z.object({
  variantId: z.string().min(1),
  qty: z.coerce.number().int().min(1).max(1000).default(1),
});
