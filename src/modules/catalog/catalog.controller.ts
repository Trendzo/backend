import { and, asc, eq, ilike, inArray, lte, gte, ne, or, isNull, sql } from 'drizzle-orm';
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
  retailerStores,
  sizeScales,
  storePickupSlots,
  variants,
} from '@/db/schema/index.js';
import { parentIdSet, resolveDescendantIds } from '@/shared/catalog/category-tree.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type {
  BrandsQuery,
  CategoriesQuery,
  CollectionsQuery,
  FacetsQuery,
  NearbyStoresQuery,
  PickupSlotsQuery,
  ProductReviewsQuery,
  ProductsQuery,
  SizeScalesQuery,
} from './catalog.validators.js';

/**
 * Public read-only catalog metadata. Retailer UIs read these to populate brand/category
 * dropdowns; consumer-facing browse uses richer endpoints (later phase).
 */

/**
 * The category tree, flat, with `parentId` — the client assembles it (the admin dashboard
 * already does, see webprotal `routes/admin/categories.tsx`).
 *
 * Gender is "requested OR unisex", matching listings (`listProducts`) and collections
 * (`listCollections`). That is what makes the mixed-gender tree work: a shared node like
 * Tops is stored once as `unisex` and appears on both rails, while Dresses (her) and
 * Ethnic Wear (him) appear on one. It used to be strict equality, which would have hidden
 * every shared node from both rails.
 *
 * `isLeaf` is computed so pick-lists can indent and disable parents; `listingCount` is
 * descendant-inclusive so a parent reports what its children hold, not zero.
 */
export async function listCategories(input: { query: z.infer<typeof CategoriesQuery> }) {
  const { query } = input;
  const filters = [];
  if (query.gender) {
    filters.push(or(eq(categories.gender, query.gender), eq(categories.gender, 'unisex'))!);
  }
  if (query.activeOnly) filters.push(eq(categories.isActive, true));
  const where =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.categories.findMany({
    ...(where && { where }),
    orderBy: [asc(categories.sortOrder), asc(categories.label)],
  });

  const parents = await parentIdSet();
  if (!query.withCounts) {
    return ok(rows.map((c) => ({ ...c, isLeaf: !parents.has(c.id) })));
  }

  // Direct counts per category, then rolled up to ancestors. Counting per-leaf once and
  // adding it into each ancestor is a single pass; doing a descendant query per row would
  // be ~134 aggregates per request.
  const direct = await db
    .select({ categoryId: productListings.categoryId, count: sql<number>`count(*)::int` })
    .from(productListings)
    .where(and(eq(productListings.status, 'active' as const), storeIsBrowsableSql))
    .groupBy(productListings.categoryId);

  const parentById = new Map(rows.map((c) => [c.id, c.parentId]));
  // Ancestors may be filtered out of `rows` by gender, so resolve parents from the full
  // tree rather than from the (possibly partial) result set.
  const allNodes = await db.query.categories.findMany({ columns: { id: true, parentId: true } });
  for (const n of allNodes) parentById.set(n.id, n.parentId);

  const total = new Map<string, number>();
  for (const d of direct) {
    let cursor: string | null | undefined = d.categoryId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      total.set(cursor, (total.get(cursor) ?? 0) + d.count);
      cursor = parentById.get(cursor) ?? null;
    }
  }

  return ok(
    rows.map((c) => ({ ...c, isLeaf: !parents.has(c.id), listingCount: total.get(c.id) ?? 0 })),
  );
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
/**
 * A listing is only browsable while its STORE is: 'active', or 'paused' with
 * visibility 'visible' (paused-visible stays listed; orders are still blocked at
 * quote). Suspended, terminated, and paused-hidden stores' listings disappear from
 * every consumer surface. Previously the catalog had NO store-status condition at
 * all — a terminated store's products stayed fully browsable and shoppers only hit
 * a 409 at checkout.
 */
// NOTE: the inner table is written as raw SQL (alias `rs`) on purpose — drizzle's
// relational query builder only rewrites column refs belonging to the ROOT table
// (productListings); interpolating another table's column objects here produces
// broken bindings.
const storeIsBrowsableSql = sql`EXISTS (
  SELECT 1 FROM retailer_stores rs
  WHERE rs.id = ${productListings.storeId}
    AND (rs.status = 'active'
      OR (rs.status = 'paused' AND rs.pause_visibility IS DISTINCT FROM 'hidden'))
)`;

function queryListings(opts: {
  where?: SQL | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
  return db.query.productListings.findMany({
    // Store browsability applies to EVERY consumer listing read — browse, product
    // detail, collections, similar — so it is fused here, not at each call site.
    where: opts.where ? and(opts.where, storeIsBrowsableSql) : storeIsBrowsableSql,
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
 * Product-CARD projection: only what a grid tile draws.
 *
 * The list endpoint and the detail endpoint used to return byte-identical shapes
 * (both called `shapeListings`), so every card in a 60-item grid carried the full
 * description, the whole galleryUrls array, every variant group, and EVERY variant
 * with its own imageUrls, price, compare-at price and availability. For a
 * 4-colour x 6-size product that is 24 variant objects downloaded and JSON.parsed
 * — on the JS thread — to render one price.
 *
 * The consumer card adapter (`customer-app/src/services/catalog.ts:toProduct`)
 * reads nine fields. This returns those nine and nothing else. `shapeListings`
 * stays exactly as it was for product detail, which genuinely needs all of it.
 */
function shapeCards(rows: ListingRow[]) {
  return rows
    .map((l) => {
      const activeGroupIds = new Set(l.variantGroups.map((g) => g.id));
      const shoppable = l.variants.filter((v) => activeGroupIds.has(v.groupId));
      if (shoppable.length === 0) return null;

      // The card shows the cheapest shoppable variant — the same number
      // `sort=price_asc` orders by, so the grid never disagrees with itself.
      let pick = shoppable[0]!;
      for (const v of shoppable) if (v.pricePaise < pick.pricePaise) pick = v;

      const compare = pick.compareAtPrice;
      const discountPct = compare && compare > pick.pricePaise
        ? Math.round((1 - pick.pricePaise / compare) * 100)
        : 0;

      // Two swatches is all a card renders.
      const colors = l.variantGroups
        .map((g) => g.colorHex)
        .filter((c): c is string => !!c)
        .slice(0, 2);

      return {
        id: l.id,
        name: l.name,
        brandName: l.brand?.name ?? l.store.legalName,
        categoryLabel: l.category.label,
        ratingAvg: Number(l.ratingAvg),
        ratingCount: l.ratingCount,
        image: pick.imageUrls?.[0] ?? l.galleryUrls?.[0] ?? null,
        pricePaise: pick.pricePaise,
        compareAtPricePaise: compare,
        discountPct,
        colors,
        occasion: l.occasion?.[0] ?? null,
        // Lets a card add to the bag without first fetching the full detail.
        defaultVariantId: pick.id,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

/**
 * At least one shoppable variant — active variant belonging to an active group, which is
 * exactly what `shapeListings` keeps. Applied while paging so `limit`/`offset` count the
 * rows the caller actually receives; without it a page of 24 could shrink to 19 after
 * shaping and the next offset would skip products.
 */
const hasShoppableVariantSql = sql`EXISTS (
  SELECT 1 FROM variants v
  JOIN variant_groups vg ON vg.id = v.group_id
  WHERE v.listing_id = ${productListings.id}
    AND v.is_active = true
    AND vg.is_active = true
)`;

/**
 * Consumer product browse — active listings with their shoppable variants, shaped for
 * the consumer app's product cards. Public (no auth). Each listing carries its storeId;
 * checkout requires it (single-store MVP: all seeded listings share one store).
 *
 * Two phases, because `queryListings` uses drizzle's relational builder — that can't order
 * by an aggregate over a joined table, which price sorting needs. Phase 1 is a plain
 * select that decides WHICH listings and in WHAT ORDER; phase 2 hydrates them through the
 * existing shared query so browse and collection detail keep returning identical payloads.
 * `getCollection` already uses this shape for membership ordering.
 */
export async function listProducts(input: { query: z.infer<typeof ProductsQuery> }) {
  const { query } = input;
  const filters = [eq(productListings.status, 'active' as const), hasShoppableVariantSql];
  if (query.gender) {
    // Unisex listings show on both HER and HIM rails.
    filters.push(or(eq(productListings.gender, query.gender), eq(productListings.gender, 'unisex'))!);
  }
  if (query.storeId) filters.push(eq(productListings.storeId, query.storeId));
  if (query.search) filters.push(ilike(productListings.name, `%${query.search}%`));

  if (query.categoryId || query.categorySlug) {
    const ids = await resolveDescendantIds({
      ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
      ...(query.categorySlug !== undefined && { categorySlug: query.categorySlug }),
    });
    // Unknown category → no products, rather than silently dropping the filter and
    // returning the whole catalog.
    if (!ids) return ok([]);
    filters.push(inArray(productListings.categoryId, ids));
  }

  const ordered = await orderedListingIds(and(...filters)!, query.sort, query.limit, query.offset);
  if (ordered.length === 0) return ok([]);

  const rows = await queryListings({ where: inArray(productListings.id, ordered) });
  const rank = new Map(ordered.map((id, i) => [id, i]));
  // `view=card` is the slim grid projection; `full` keeps the historical shape so
  // existing callers (retailer app, webprotal, MCP) are untouched.
  const shaped = query.view === 'card'
    ? shapeCards(rows).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    : shapeListings(rows).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return ok(shaped);
}

/** Phase 1 of browse: which listings, in which order. Returns ids only. */
async function orderedListingIds(
  where: SQL,
  sort: z.infer<typeof ProductsQuery>['sort'],
  limit: number,
  offset: number,
): Promise<string[]> {
  const scoped = and(where, storeIsBrowsableSql)!;

  if (sort === 'price_asc' || sort === 'price_desc') {
    // Price of a listing = its cheapest shoppable variant, the same number the product
    // card shows. Mirrors the min() aggregate `listCollections` uses for bundle pricing.
    const rows = await db
      .select({ id: productListings.id, price: sql<number>`min(${variants.pricePaise})` })
      .from(productListings)
      .innerJoin(
        variants,
        and(eq(variants.listingId, productListings.id), eq(variants.isActive, true)),
      )
      .where(scoped)
      .groupBy(productListings.id)
      // `id` breaks ties. Without it, listings sharing a price (or a createdAt, below)
      // come back in whatever order Postgres feels like per query, so page 2 can repeat
      // rows from page 1 — the seeded catalog inserts in batches and hits ties constantly.
      .orderBy(
        sort === 'price_asc'
          ? sql`min(${variants.pricePaise}) ASC, ${productListings.id} ASC`
          : sql`min(${variants.pricePaise}) DESC, ${productListings.id} ASC`,
      )
      .limit(limit)
      .offset(offset);
    return rows.map((r) => r.id);
  }

  const rows = await db
    .select({ id: productListings.id })
    .from(productListings)
    .where(scoped)
    .orderBy(
      sort === 'rating'
        ? sql`${productListings.ratingAvg} DESC, ${productListings.ratingCount} DESC, ${productListings.id} ASC`
        : sql`${productListings.createdAt} DESC, ${productListings.id} ASC`,
    )
    .limit(limit)
    .offset(offset);
  return rows.map((r) => r.id);
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
  // Same browsability rule as the product itself — otherwise reviews stay publicly
  // readable for a product whose detail endpoint 404s (suspended/terminated store).
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, id),
      eq(productListings.status, 'active'),
      storeIsBrowsableSql,
    ),
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

  // Base scope shared by every facet and the total. Includes store browsability so
  // facet counts agree with what the browse grid actually shows.
  const base: SQL[] = [eq(productListings.status, 'active' as const), storeIsBrowsableSql];
  if (query.storeId) base.push(eq(productListings.storeId, query.storeId));
  if (query.search) base.push(ilike(productListings.name, `%${query.search}%`));

  // Descendant-inclusive, same as browse: scoping to a parent has to cover its leaves.
  let categoryFilter: SQL | undefined;
  if (query.categoryId || query.categorySlug) {
    const ids = await resolveDescendantIds({
      ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
      ...(query.categorySlug !== undefined && { categorySlug: query.categorySlug }),
    });
    if (!ids) return ok({ total: 0, genders: [], categories: [] });
    categoryFilter = inArray(productListings.categoryId, ids);
  }
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
    // sortOrder has to be grouped as well as ordered by — Postgres rejects an ORDER BY on
    // a column that is neither grouped nor aggregated, so this endpoint used to 500.
    .groupBy(productListings.categoryId, categories.label, categories.slug, categories.sortOrder)
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
              // Card stats must agree with the detail page: listings from
              // non-browsable stores are excluded from counts + prices too.
              storeIsBrowsableSql,
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

/* ── Store pickup windows ─────────────────────────────────────────────────── */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** 'HH:MM' → minutes since midnight; null when unparseable. */
function parseHhMm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Upcoming pickup windows for one store.
 *
 * `store_pickup_slots` is a RECURRING weekly template (dayOfWeek + 'HH:MM'), but
 * placement wants a concrete instant (`pickupSlotStart`/`pickupSlotEnd`). This
 * expands the template over the next `days` days in IST — the store's local clock —
 * and drops windows whose END has already passed, so the app never offers a slot it
 * cannot honour. Ordering is chronological.
 */
export async function listStorePickupSlots(input: {
  storeId: string;
  query: z.infer<typeof PickupSlotsQuery>;
}) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, input.storeId),
    columns: { id: true, legalName: true, address: true, lat: true, lng: true, contactPhone: true, status: true },
  });
  if (!store || store.status !== 'active') {
    throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  }

  const rows = await db.query.storePickupSlots.findMany({
    where: and(eq(storePickupSlots.storeId, store.id), eq(storePickupSlots.isActive, true)),
  });

  const now = Date.now();
  const byDay = new Map<number, typeof rows>();
  for (const r of rows) {
    const bucket = byDay.get(r.dayOfWeek);
    if (bucket) bucket.push(r);
    else byDay.set(r.dayOfWeek, [r]);
  }

  const slots: {
    slotId: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
  }[] = [];

  for (let dayOffset = 0; dayOffset < input.query.days; dayOffset++) {
    // Midnight IST of the target day, expressed as a real UTC instant.
    const istNow = new Date(now + IST_OFFSET_MS);
    const istMidnightUtcMs =
      Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) -
      IST_OFFSET_MS +
      dayOffset * 24 * 60 * 60 * 1000;
    const dow = new Date(istMidnightUtcMs + IST_OFFSET_MS).getUTCDay();

    for (const r of byDay.get(dow) ?? []) {
      const startMin = parseHhMm(r.startTime);
      const endMin = parseHhMm(r.endTime);
      if (startMin === null || endMin === null || endMin <= startMin) continue;
      const startMs = istMidnightUtcMs + startMin * 60_000;
      const endMs = istMidnightUtcMs + endMin * 60_000;
      if (endMs <= now) continue; // already over
      slots.push({
        slotId: r.id,
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
        capacity: r.capacity,
      });
    }
  }

  slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return ok({
    store: {
      id: store.id,
      name: store.legalName,
      address: store.address,
      lat: store.lat,
      lng: store.lng,
      contactPhone: store.contactPhone,
    },
    slots,
  });
}


/* ── Consumer store projection ────────────────────────────────────────────── */

/**
 * What a shopper may see about a store.
 *
 * Consumers previously received only `{ id, legalName }` on a product and there
 * was no store endpoint at all — no address, no coordinates, no hours. The app
 * filled the gap with three invented stores complete with fake distances and
 * opening hours.
 *
 * Whitelist, not a redaction: GSTIN, PAN, legal entity, fee structure, payout
 * cadence, pause reasons and suspension attribution are all commercially
 * sensitive and never belong in a consumer response.
 */
function shapeStore(s: {
  id: string; legalName: string; address: string; lat: number; lng: number;
  contactPhone: string | null; openingHours: Record<string, { open: string; close: string }[]> | null;
  galleryImageUrls: string[] | null;
}) {
  return {
    id: s.id,
    name: s.legalName,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    phone: s.contactPhone,
    openingHours: s.openingHours ?? null,
    images: s.galleryImageUrls ?? [],
  };
}

/** Only stores a shopper can actually buy from — same rule as browsable listings. */
const STORE_IS_VISIBLE = or(
  eq(retailerStores.status, 'active'),
  and(eq(retailerStores.status, 'paused'), ne(retailerStores.pauseVisibility, 'hidden')),
)!;

export async function getStore(id: string) {
  const s = await db.query.retailerStores.findFirst({
    where: and(eq(retailerStores.id, id), STORE_IS_VISIBLE),
    columns: {
      id: true, legalName: true, address: true, lat: true, lng: true,
      contactPhone: true, openingHours: true, galleryImageUrls: true,
    },
  });
  if (!s) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return ok(shapeStore(s));
}

/** Great-circle distance in km. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Stores near a point, nearest first, with a real distance.
 *
 * Filtered and sorted in memory on purpose: the store table is small (tens of
 * rows), and PostGIS is not installed. Revisit with an earth_distance index if
 * the count ever reaches the thousands.
 */
export async function listNearbyStores(input: { query: z.infer<typeof NearbyStoresQuery> }) {
  const { lat, lng, radiusKm, limit } = input.query;
  const rows = await db.query.retailerStores.findMany({
    where: STORE_IS_VISIBLE,
    columns: {
      id: true, legalName: true, address: true, lat: true, lng: true,
      contactPhone: true, openingHours: true, galleryImageUrls: true,
    },
  });

  const near = rows
    .map((s) => ({ store: s, distanceKm: haversineKm(lat, lng, s.lat, s.lng) }))
    .filter((r) => r.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map((r) => ({ ...shapeStore(r.store), distanceKm: Math.round(r.distanceKm * 10) / 10 }));

  return ok(near);
}
