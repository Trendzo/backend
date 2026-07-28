import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

/** Cursor-paged newest-first; `before` is the createdAt of the last row seen. */
export const ListNotificationsQuery = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
