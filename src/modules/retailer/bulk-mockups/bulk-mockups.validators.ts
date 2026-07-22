import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

/**
 * Enqueue a bulk-mockup job. Same image/config shape as an ai-catalog-beta
 * submission (pre-uploaded URLs), but this is queued and generated async by the
 * worker — the request returns immediately with a `queued` job.
 */
export const EnqueueBody = z.object({
  mode: z.enum(['without_model', 'with_model']),
  prompt: z.string().trim().max(800).optional(),
  apparelImageUrls: z.array(z.string().url()).min(1).max(5),
  apparelBackImageUrl: z.string().url().optional(),
  designImageUrl: z.string().url().optional(),
  patternCloseupUrl: z.string().url().optional(),
  logoCloseupUrl: z.string().url().optional(),
  tagLabelUrl: z.string().url().optional(),
  modelGender: z.enum(['her', 'him']).optional(),
  only: z.array(z.string()).optional(),
});

export const ListQuery = z.object({
  status: z
    .enum(['queued', 'processing', 'ready', 'failed', 'cancelled', 'dismissed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
