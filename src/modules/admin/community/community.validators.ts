import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const CommentParam = z.object({ id: z.string(), commentId: z.string() });

export const ListQuery = z.object({
  status: z.enum(['active', 'taken_down', 'hidden_pending_review']).optional(),
  consumerId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const TakedownBody = z.object({
  reason: z.string().trim().min(3).max(1000),
});
