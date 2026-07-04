import { and, asc, eq, ilike, inArray, lte, gte, or, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  collectionListings,
  collections,
  productListings,
  productReviews,
  sizeScales,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type {
  BrandsQuery,
  CategoriesQuery,
  CollectionsQuery,
  FacetsQuery,
  ProductReviewsQuery,
  ProductsQuery,
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

/**
 * Listing query + shaping shared by product browse and collection detail so both
 * return byte-identical product card payloads (variants with availability, groups,
 * brand, category). Newest-first; callers needing membership order re-sort after.
 */
function queryListings(opts: {
  where?: SQL | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
  return db.query.productListings.findMany({
    ...(opts.where && { where: opts.where }),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...(opts.offset !== undefined && { offset: opts.offset }),
    with: {
      brand: { columns: { id: true, name: true } },
      category: { columns: { id: true, label: true, slug: true } },
      store: { columns: { id: true, legalName: true } },
      variants: {
        where: (v, { eq: veq }) => veq(v.isActive, true),
        columns: {
          id: true,
          groupId: true,
          attributes: true,
          attributesLabel: true,
          imageUrls: true,
          pricePaise: true,
          compareAtPrice: true,
          stock: true,
          reserved: true,
        },
      },
      variantGroups: {
        where: (g, { eq: geq }) => geq(g.isActive, true),
        columns: { id: true, name: true, colorHex: true, isDefault: true, sortOrder: true },
      },
    },
  });
}

type ListingRow = Awaited<ReturnType<typeof queryListings>>[number];

function shapeListings(rows: ListingRow[]) {
  return rows
    .map((l) => {
      const activeGroupIds = new Set(l.variantGroups.map((g) => g.id));
      // %-off is computed here (backend = single source of truth) so the strikethrough
      // badge never recomputes on the client.
      const discountPct = (pricePaise: number, comparePaise: number | null) =>
        comparePaise && comparePaise > pricePaise
          ? Math.round((1 - pricePaise / comparePaise) * 100)
          : 0;
      const variants = l.variants
        // Shoppable = variant active AND its group active.
        .filter((v) => activeGroupIds.has(v.groupId))
        .map((v) => ({
          id: v.id,
          groupId: v.groupId,
          attributes: v.attributes,
          label: v.attributesLabel,
          imageUrls: v.imageUrls,
          pricePaise: v.pricePaise,
          compareAtPricePaise: v.compareAtPrice,
          discountPct: discountPct(v.pricePaise, v.compareAtPrice),
          available: Math.max(0, v.stock - v.reserved),
        }));
      return {
        id: l.id,
        storeId: l.storeId,
        name: l.name,
        description: l.description,
        gender: l.gender,
        listingPolicy: l.listingPolicy,
        galleryUrls: l.galleryUrls,
        occasion: l.occasion,
        brand: l.brand ? { id: l.brand.id, name: l.brand.name } : null,
        category: { id: l.category.id, label: l.category.label, slug: l.category.slug },
        store: { id: l.store.id, legalName: l.store.legalName },
        ratingAvg: Number(l.ratingAvg),
        ratingCount: l.ratingCount,
        groups: l.variantGroups
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((g) => ({ id: g.id, name: g.name, colorHex: g.colorHex, isDefault: g.isDefault })),
        variants,
      };
    })
    // A listing with zero shoppable variants can't be added to a cart — hide it.
    .filter((l) => l.variants.length > 0);
}

/**
 * Consumer product browse — active listings with their shoppable variants, shaped for
 * the consumer app's product cards. Public (no auth). Each listing carries its storeId;
 * checkout requires it (single-store MVP: all seeded listings share one store).
 */
export async function listProducts(input: { query: z.infer<typeof ProductsQuery> }) {
  const { query } = input;
  const filters = [eq(productListings.status, 'active' as const)];
  if (query.gender) {
    // Unisex listings show on both HER and HIM rails.
    filters.push(or(eq(productListings.gender, query.gender), eq(productListings.gender, 'unisex'))!);
  }
  if (query.categoryId) filters.push(eq(productListings.categoryId, query.categoryId));
  if (query.storeId) filters.push(eq(productListings.storeId, query.storeId));
  if (query.search) filters.push(ilike(productListings.name, `%${query.search}%`));

  const rows = await queryListings({
    where: and(...filters),
    limit: query.limit,
    offset: query.offset,
  });
  return ok(shapeListings(rows));
}

/** Single active listing for the product detail page. Same shape as the list rows. */
export async function getProduct(id: string) {
  const rows = await queryListings({
    where: and(eq(productListings.id, id), eq(productListings.status, 'active')),
    limit: 1,
  });
  // shapeListings also drops listings with zero shoppable variants — those 404 too.
  const shaped = shapeListings(rows);
  if (shaped.length === 0) {
    throw new AppError(404, ErrorCode.NotFound, 'Product not found');
  }
  return ok(shaped[0]);
}

/**
 * Public reviews for a listing — active reviews only, newest first. The author is
 * the reviewer's first name only (consumer PII never leaves the server).
 */
export async function listProductReviews(
  id: string,
  query: z.infer<typeof ProductReviewsQuery>,
) {
  const listing = await db.query.productListings.findFirst({
    where: and(eq(productListings.id, id), eq(productListings.status, 'active')),
    columns: { id: true },
  });
  if (!listing) {
    throw new AppError(404, ErrorCode.NotFound, 'Product not found');
  }

  const rows = await db.query.productReviews.findMany({
    where: and(eq(productReviews.listingId, id), eq(productReviews.status, 'active')),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: query.limit,
    offset: query.offset,
    with: { consumer: { columns: { name: true } } },
  });

  return ok(
    rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      createdAt: r.createdAt,
      author: r.consumer.name?.trim().split(/\s+/)[0] ?? 'ClosetX Shopper',
    })),
  );
}

/**
 * Faceted product counts for browse nav. Returns, over active listings, the count
 * per gender and per category. Both facets honour the OTHER active filters but
 * exclude their own dimension — the standard faceted-search rule — so the same
 * endpoint answers "which genders exist in this category" (pass `categoryId`, read
 * `genders`) AND "which categories exist for this gender" (pass `gender`, read
 * `categories`). Unisex listings count toward both her and him, matching
 * `listProducts`.
 *
 * Counts are over active listings only. Unlike the browse grid, they do NOT drop
 * listings whose variants are all sold-out/inactive (that needs the variant+group
 * shaping and is too costly for a count) — a facet may read a hair high. This
 * matches the existing admin category-count convention.
 */
export async function listFacets(input: { query: z.infer<typeof FacetsQuery> }) {
  const { query } = input;

  // Base scope shared by every facet and the total.
  const base: SQL[] = [eq(productListings.status, 'active' as const)];
  if (query.storeId) base.push(eq(productListings.storeId, query.storeId));
  if (query.search) base.push(ilike(productListings.name, `%${query.search}%`));

  const categoryFilter = query.categoryId
    ? eq(productListings.categoryId, query.categoryId)
    : undefined;
  const genderFilter = query.gender
    ? or(eq(productListings.gender, query.gender), eq(productListings.gender, 'unisex'))!
    : undefined;

  // Gender facet: base + category scope, but NOT the gender filter (its own axis).
  const genderRows = await db
    .select({ gender: productListings.gender, count: sql<number>`count(*)::int` })
    .from(productListings)
    .where(and(...base, ...(categoryFilter ? [categoryFilter] : [])))
    .groupBy(productListings.gender);

  // Category facet: base + gender scope, but NOT the category filter (its own axis).
  const categoryRows = await db
    .select({
      categoryId: productListings.categoryId,
      label: categories.label,
      slug: categories.slug,
      count: sql<number>`count(*)::int`,
    })
    .from(productListings)
    .innerJoin(categories, eq(categories.id, productListings.categoryId))
    .where(and(...base, ...(genderFilter ? [genderFilter] : [])))
    .groupBy(productListings.categoryId, categories.label, categories.slug)
    .orderBy(asc(categories.sortOrder), asc(categories.label));

  // Total: every active filter applied together — the "N results" header count.
  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productListings)
    .where(
      and(
        ...base,
        ...(categoryFilter ? [categoryFilter] : []),
        ...(genderFilter ? [genderFilter] : []),
      ),
    );

  return ok({
    total: totalRow[0]?.count ?? 0,
    genders: genderRows,
    categories: categoryRows,
  });
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
  // Time-window guard: hide collections whose window has ended. Not-yet-started
  // collections stay hidden EXCEPT drops — upcoming drops are listed (with their
  // future startsAt) so the app can render launch countdowns; getCollection still
  // 404s their contents until launch.
  if (query.kind !== 'drop') {
    filters.push(or(isNull(collections.startsAt), lte(collections.startsAt, now))!);
  }
  filters.push(or(isNull(collections.endsAt), gte(collections.endsAt, now))!);
  const rows = await db.query.collections.findMany({
    where: and(...filters),
    orderBy: [asc(collections.sortOrder), asc(collections.createdAt)],
  });

  // Bundle cards need pieces + total price: per explicit member listing take its
  // cheapest active variant, then count/sum per collection. Auto-resolve kinds
  // (occasion/brand with no memberships) get 0/0 — their cards don't show these.
  const ids = rows.map((r) => r.id);
  const perListing =
    ids.length === 0
      ? []
      : await db
          .select({
            collectionId: collectionListings.collectionId,
            listingId: collectionListings.listingId,
            minPricePaise: sql<number>`min(${variants.pricePaise})`,
          })
          .from(collectionListings)
          .innerJoin(
            productListings,
            and(
              eq(productListings.id, collectionListings.listingId),
              eq(productListings.status, 'active'),
            ),
          )
          .innerJoin(
            variants,
            and(eq(variants.listingId, productListings.id), eq(variants.isActive, true)),
          )
          .where(inArray(collectionListings.collectionId, ids))
          .groupBy(collectionListings.collectionId, collectionListings.listingId);

  const stats = new Map<string, { count: number; sum: number }>();
  for (const r of perListing) {
    const s = stats.get(r.collectionId) ?? { count: 0, sum: 0 };
    s.count += 1;
    s.sum += Number(r.minPricePaise);
    stats.set(r.collectionId, s);
  }

  return ok(
    rows.map((c) => ({
      ...c,
      listingCount: stats.get(c.id)?.count ?? 0,
      pricePaise: stats.get(c.id)?.sum ?? 0,
    })),
  );
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
  // having to manually re-add them. All branches return shaped listings (same
  // payload as /catalog/products) so the consumer app's product mapper works.
  let listings: ReturnType<typeof shapeListings>;
  if (c.kind === 'brand' && c.brandId) {
    const rows = await queryListings({
      where: and(eq(productListings.brandId, c.brandId), eq(productListings.status, 'active')),
    });
    listings = shapeListings(rows);
  } else if (c.kind === 'occasion' && c.occasionTag) {
    const rows = await queryListings({
      where: and(
        sql`${productListings.occasion} @> ${JSON.stringify([c.occasionTag])}::jsonb`,
        eq(productListings.status, 'active'),
      ),
    });
    listings = shapeListings(rows);
  } else {
    const memberships = await db
      .select({
        listingId: collectionListings.listingId,
        sortOrder: collectionListings.sortOrder,
      })
      .from(collectionListings)
      .where(eq(collectionListings.collectionId, c.id))
      .orderBy(asc(collectionListings.sortOrder));
    if (memberships.length === 0) {
      listings = [];
    } else {
      const rows = await queryListings({
        where: and(
          inArray(
            productListings.id,
            memberships.map((m) => m.listingId),
          ),
          eq(productListings.status, 'active'),
        ),
      });
      const order = new Map(memberships.map((m) => [m.listingId, m.sortOrder]));
      listings = shapeListings(rows).sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
    }
  }

  return ok({ ...c, listings });
}
