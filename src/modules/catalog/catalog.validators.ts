import { z } from 'zod';

export const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend']);
export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const SlugParam = z.object({ slug: z.string() });

export const CategoriesQuery = z.object({
  gender: GenderEnum.optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const BrandsQuery = z.object({
  activeOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const SizeScalesQuery = z.object({
  categoryId: z.string().optional(),
});

export const CollectionsQuery = z.object({
  kind: CollectionKindEnum.optional(),
  gender: GenderEnum.optional(),
  featured: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});
