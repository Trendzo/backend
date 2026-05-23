import { z } from 'zod';

export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  brandId: z.string().optional(),
  categoryId: z.string().optional(),
  gender: GenderEnum.optional(),
  status: z.enum(['draft', 'active', 'retired', 'taken_down']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
