import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const InboxQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
