import { and, asc, eq, lte, gte, or, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  collectionListings,
  collections,
  productListings,
  sizeScales,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type {
  BrandsQuery,
  CategoriesQuery,
  CollectionsQuery,
  SizeScalesQuery,
} from './catalog.validators.js';

/**
 * Public read-only catalog metadata. Retailer UIs read these to populate brand/category
 * dropdowns; consumer-facing browse uses richer endpoints (later phase).
 */

export async function listCategories(input: { query: z.infer<typeof CategoriesQuery> }) {
  const { query } = input;
  const filters = [];
  if (query.gender) filters.push(eq(categories.gender, query.gender));
  if (query.activeOnly) filters.push(eq(categories.isActive, true));
  const where =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.categories.findMany({
    ...(where && { where }),
    orderBy: [asc(categories.sortOrder), asc(categories.label)],
  });
  return ok(rows);
}

/**
 * Size scales applicable to a category — drives the size pick-lists in the
 * product wizard's color → size editor. With `categoryId`, returns universal
 * scales (empty categorySlugs) plus any whose slugs match the category or one
 * of its ancestors; without it, returns every active scale.
 */
export async function listSizeScales(input: { query: z.infer<typeof SizeScalesQuery> }) {
  const all = await db.query.sizeScales.findMany({
    where: eq(sizeScales.isActive, true),
    orderBy: [asc(sizeScales.sortOrder), asc(sizeScales.name)],
  });
  if (!input.query.categoryId) return ok(all);

  // Collect the category's slug plus every ancestor slug (cycle-guarded).
  const slugs = new Set<string>();
  let cursor: string | null = input.query.categoryId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const cat: { slug: string; parentId: string | null } | undefined =
      await db.query.categories.findFirst({
        where: eq(categories.id, cursor),
        columns: { slug: true, parentId: true },
      });
    if (!cat) break;
    slugs.add(cat.slug);
    cursor = cat.parentId;
  }

  const rows = all.filter(
    (s) => s.categorySlugs.length === 0 || s.categorySlugs.some((slug) => slugs.has(slug)),
  );
  return ok(rows);
}

export async function listBrands(input: { query: z.infer<typeof BrandsQuery> }) {
  const where = input.query.activeOnly ? eq(brands.isActive, true) : undefined;
  const rows = await db.query.brands.findMany({
    ...(where && { where }),
    orderBy: asc(brands.name),
  });
  return ok(rows);
}

export async function listCollections(input: { query: z.infer<typeof CollectionsQuery> }) {
  const { query } = input;
  const now = new Date();
  const filters = [eq(collections.status, 'active')];
  if (query.kind) filters.push(eq(collections.kind, query.kind));
  if (query.gender) {
    // For gender filter we want the requested gender + 'unisex' (an outfit
    // marked unisex shows up on both HER and HIM rails).
    filters.push(
      or(eq(collections.gender, query.gender), eq(collections.gender, 'unisex'))!,
    );
  }
  if (query.featured !== undefined)
    filters.push(eq(collections.isFeatured, query.featured));
  // Time-window guard: hide collections whose drop window hasn't started or has ended.
  filters.push(or(isNull(collections.startsAt), lte(collections.startsAt, now))!);
  filters.push(or(isNull(collections.endsAt), gte(collections.endsAt, now))!);
  const rows = await db.query.collections.findMany({
    where: and(...filters),
    orderBy: [asc(collections.sortOrder), asc(collections.createdAt)],
  });
  return ok(rows);
}

export async function getCollection(slug: string) {
  const c = await db.query.collections.findFirst({
    where: eq(collections.slug, slug),
  });
  if (!c || c.status !== 'active') {
    throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
  }
  const now = new Date();
  if (c.startsAt && c.startsAt > now)
    throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
  if (c.endsAt && c.endsAt < now)
    throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

  // US-5.8.2: brand and occasion collections auto-resolve from live catalog so
  // newly published listings in a featured brand/occasion appear without admin
  // having to manually re-add them.
  let listings: Array<typeof productListings.$inferSelect & { sortOrder: number }>;
  if (c.kind === 'brand' && c.brandId) {
    const rows = await db.query.productListings.findMany({
      where: and(
        eq(productListings.brandId, c.brandId),
        eq(productListings.status, 'active'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    listings = rows.map((r, i) => ({ ...r, sortOrder: i }));
  } else if (c.kind === 'occasion' && c.occasionTag) {
    const rows = await db.query.productListings.findMany({
      where: and(
        sql`${productListings.occasion} @> ${JSON.stringify([c.occasionTag])}::jsonb`,
        eq(productListings.status, 'active'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    listings = rows.map((r, i) => ({ ...r, sortOrder: i }));
  } else {
    const memberships = await db
      .select({ listing: productListings, sortOrder: collectionListings.sortOrder })
      .from(collectionListings)
      .innerJoin(productListings, eq(productListings.id, collectionListings.listingId))
      .where(
        and(
          eq(collectionListings.collectionId, c.id),
          eq(productListings.status, 'active'),
        ),
      )
      .orderBy(asc(collectionListings.sortOrder));
    listings = memberships.map((m) => ({ ...m.listing, sortOrder: m.sortOrder }));
  }

  return ok({ ...c, listings });
}
