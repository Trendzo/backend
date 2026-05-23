import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListMineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const CreatePostBody = z.object({
  body: z.string().trim().min(1).max(5000),
  media: z.array(z.string().url()).max(10).default([]),
});

export const CreateReviewBody = z.object({
  listingId: z.string().min(1),
  orderId: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5),
  body: z.string().trim().max(5000).optional(),
  media: z.array(z.string().url()).max(10).default([]),
});

export const CreateReportBody = z.object({
  targetType: z.enum(['community_post', 'product_review']),
  targetId: z.string().min(1),
  reason: z.string().trim().min(3).max(1000),
});
