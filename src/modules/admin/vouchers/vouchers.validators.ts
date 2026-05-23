import { z } from 'zod';

export const PromotionIdParam = z.object({ promotionId: z.string() });

export const FormatQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

export const BulkGenerateBody = z.object({
  count: z.number().int().positive().max(10_000),
  /** How many redemptions each generated code allows (default 1 = single-use). */
  usesAllowed: z.number().int().positive().nullable().default(1),
  /** Optional uppercase alphanumeric prefix (e.g. "DROP24"). */
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .max(8)
    .regex(/^[A-Z0-9]*$/, 'A–Z and 0–9 only')
    .default(''),
});

export const DistributeBody = z.object({
  codeIds: z.array(z.string()).min(1),
  consumerIds: z.array(z.string()).min(1),
});
