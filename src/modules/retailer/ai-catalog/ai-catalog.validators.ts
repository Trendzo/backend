import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  listingId: z.string().optional(),
  status: z
    .enum([
      'submitted',
      'processing',
      'ready_for_review',
      'accepted',
      'rejected',
      'regenerating',
      'failed',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const QuotaQuery = z.object({ listingId: z.string() });

export const GenerateBody = z.object({
  listingId: z.string(),
  targetVariantId: z.string().optional(),
  mode: z.enum(['without_model', 'with_model']),
  prompt: z.string().trim().min(8).max(800),
  referenceImageUrls: z.array(z.string().url()).min(1).max(5),
  posePreferences: z.array(z.string()).optional(),
});

export const RegenerateBody = z.object({
  revisionNotes: z.string().trim().min(4).max(400),
});

export const AcceptBody = z.object({ targetVariantId: z.string().optional() });
