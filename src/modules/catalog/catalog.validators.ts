import { z } from 'zod';

export const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend']);
export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const SlugParam = z.object({ slug: z.string() });
export const IdParam = z.object({ id: z.string() });

/**
 * Stores near a point. Consumers get a whitelisted projection — see
 * catalog.controller.ts shapeStore. `radiusKm` is capped so this can never be
 * used to enumerate the whole store table.
 */
export const NearbyStoresQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(50).default(15),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

/**
 * Upcoming pickup windows for a store. `store_pickup_slots` rows are RECURRING
 * (dayOfWeek + HH:MM), so the endpoint expands them into concrete dated windows
 * the consumer app can show and hand straight back at placement.
 */
export const PickupSlotsQuery = z.object({
  days: z.coerce.number().int().positive().max(14).default(7),
});

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
  /**
   * Attach a descendant-inclusive `listingCount` to every row so the browse rail can hide
   * sub-categories with nothing in them, in one request instead of a second /facets call.
   * Off by default — the retailer/admin pick-lists don't need the extra aggregate.
   */
  withCounts: z
    .enum(['true', 'false'])
    .default('false')
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

/** Browse sort. `newest` keeps the historical createdAt-desc ordering. */
export const ProductSortEnum = z.enum(['newest', 'price_asc', 'price_desc', 'rating']);

/**
 * Consumer product browse. Public; only active listings/variants are returned.
 *
 * `categoryId`/`categorySlug` are DESCENDANT-INCLUSIVE: addressing a parent (`tops`)
 * returns everything under it, since listings live on leaves. Pass either — the app
 * navigates by slug, admin filters by id.
 */
export const ProductsQuery = z.object({
  gender: GenderEnum.optional(),
  categoryId: z.string().optional(),
  categorySlug: z.string().optional(),
  storeId: z.string().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  sort: ProductSortEnum.default('newest'),
  /**
   * Response shape. 'card' returns only what a grid tile draws (~9 fields);
   * 'full' returns the detail shape with every variant and group. Defaults to
   * 'full' so existing callers are unaffected — the consumer grid opts in.
   */
  view: z.enum(['full', 'card']).default('full'),
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
  categorySlug: z.string().optional(),
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
