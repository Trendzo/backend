import { z } from 'zod';

/**
 * Query for the public abandoned-carts surface. All params optional with sane defaults.
 *
 * A cart counts as "abandoned" when it holds >=1 item and hasn't been touched
 * (updatedAt) for at least `staleMinutes`.
 */
export const ListAbandonedCartsQuery = z.object({
  /** Minutes of inactivity before a non-empty cart is considered abandoned. */
  staleMinutes: z.coerce.number().int().min(1).max(60 * 24 * 90).default(30),
  /** Narrow to a single consumer's cart. */
  consumerId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListAbandonedCartsQuery = z.infer<typeof ListAbandonedCartsQuery>;
