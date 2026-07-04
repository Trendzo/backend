import { z } from 'zod';

export const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend']);
export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const SlugParam = z.object({ slug: z.string() });
export const IdParam = z.object({ id: z.string() });

/** Public reviews for a listing's detail page. */
export const ProductReviewsQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

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

/** Consumer product browse. Public; only active listings/variants are returned. */
export const ProductsQuery = z.object({
  gender: GenderEnum.optional(),
  categoryId: z.string().optional(),
  storeId: z.string().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * Faceted-count query for browse. Every param is an optional scope; the endpoint
 * returns product counts per gender and per category. A facet's own dimension is
 * excluded from its own counts (e.g. passing `categoryId` still returns every
 * gender's count within that category), which is what lets the UI drive nav in
 * both directions: gender→category and category→gender.
 */
export const FacetsQuery = z.object({
  gender: GenderEnum.optional(),
  categoryId: z.string().optional(),
  storeId: z.string().optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

export const CollectionsQuery = z.object({
  kind: CollectionKindEnum.optional(),
  gender: GenderEnum.optional(),
  featured: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});
