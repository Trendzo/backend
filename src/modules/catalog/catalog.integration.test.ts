/**
 * End-to-end check of the category retaxonomy against a real database.
 *
 * The vitest global setup boots a throwaway Postgres and pushes the schema, so this runs
 * the actual seed chain and then asks the actual controllers the questions the consumer
 * app will ask: does a parent return its children's products, does sorting work, does a
 * rail get its gender plus the shared nodes, do the counts let us hide empty tiles.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/db/client.js';
import { seedCatalogDefaults } from '@/db/seed/catalog-defaults.js';
import { seedCatalogExpand } from '@/db/seed/catalog-expand.js';
import { seedCategoryTaxonomy } from '@/db/seed/category-taxonomy.js';
import { seedConsumerCatalog } from '@/db/seed/consumer-catalog.js';
import { invalidateCategoryTree, resolveDescendantIds } from '@/shared/catalog/category-tree.js';
import { TAXONOMY, leafSlug, parentSlug } from '@/shared/catalog/taxonomy.js';
import { getCollection, listCategories, listFacets, listProducts } from './catalog.controller.js';

type Row = Record<string, unknown>;
const data = <T>(env: { data: T }): T => env.data;

/**
 * listProducts' return type is a union of the full and card shapes (chosen by
 * `view`), which TypeScript cannot narrow from the argument. Every call here
 * passes view:'full', so assert that shape once rather than at each call site.
 */
type FullRow = Extract<
  Awaited<ReturnType<typeof listProducts>>['data'][number],
  { variants: unknown }
>;
const rowsOf = (env: Awaited<ReturnType<typeof listProducts>>): FullRow[] =>
  env.data as FullRow[];

const LEAF_COUNT = TAXONOMY.reduce((n, p) => n + p.leaves.length, 0);
const PARENT_SLUGS = new Set(TAXONOMY.map(parentSlug));
const LEAF_SLUGS = new Set(TAXONOMY.flatMap((p) => p.leaves.map((l) => leafSlug(p, l.key))));

/**
 * Other suites share this database and seed categories of their own, so assertions count
 * only rows this taxonomy owns rather than everything in the table.
 */
const ours = (rows: Row[]): Row[] =>
  rows.filter((r) => PARENT_SLUGS.has(r.slug as string) || LEAF_SLUGS.has(r.slug as string));

describe('category taxonomy end to end', () => {
  beforeAll(async () => {
    await seedCatalogDefaults(db);
    await seedCategoryTaxonomy(db);
    await seedConsumerCatalog(db);
    await seedCatalogExpand(db);
    invalidateCategoryTree();
  }, 240_000);

  it('seeds the whole tree with parents wired to children', async () => {
    const rows = ours(
      data(await listCategories({ query: { activeOnly: true, withCounts: false } })) as Row[],
    );
    expect(rows.length).toBe(TAXONOMY.length + LEAF_COUNT);
    expect(rows.filter((r) => r.parentId === null).length).toBe(TAXONOMY.length);
    expect(rows.filter((r) => r.isLeaf === true).length).toBe(LEAF_COUNT);
  });

  it('gives each rail its own gender plus the shared nodes', async () => {
    const her = data(
      await listCategories({ query: { gender: 'her', activeOnly: true, withCounts: false } }),
    ) as Row[];
    const slugs = new Set(her.map((r) => r.slug));
    expect(slugs.has('her-dresses')).toBe(true); // her-only
    expect(slugs.has('tops')).toBe(true); // shared
    expect(slugs.has('him-ethnic')).toBe(false); // him-only
    // Shared parent, gendered leaves: HER sees Blouses but never Polos.
    expect(slugs.has('tops-blouses')).toBe(true);
    expect(slugs.has('tops-polos')).toBe(false);
    expect(slugs.has('tops-tshirts')).toBe(true); // shared leaf, on both rails
  });

  it('retires the flat pre-taxonomy categories', async () => {
    const rows = data(
      await listCategories({ query: { activeOnly: false, withCounts: false } }),
    ) as Row[];
    const slugs = new Set(rows.map((r) => r.slug));
    for (const gone of ['apparel', 'footwear', 'her-tops', 'him-tshirts', 'him-sneakers']) {
      expect(slugs.has(gone), `${gone} should have been retired`).toBe(false);
    }
  });

  it('leaves no sub-category empty, so no browse tile is a dead end', async () => {
    const rows = ours(
      data(await listCategories({ query: { activeOnly: true, withCounts: true } })) as Row[],
    );
    const empty = rows.filter((r) => r.isLeaf === true && (r.listingCount as number) === 0);
    expect(empty.map((r) => r.slug)).toEqual([]);
  });

  it('rolls counts up so a parent reports what its children hold', async () => {
    const rows = data(
      await listCategories({ query: { activeOnly: true, withCounts: true } }),
    ) as Row[];
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    const tops = rows.find((r) => r.slug === 'tops')!;
    const childSum = rows
      .filter((r) => r.parentId === tops.id)
      .reduce((n, r) => n + (r.listingCount as number), 0);
    expect(tops.listingCount).toBe(childSum);
    expect(childSum).toBeGreaterThan(0);
    expect(byId.get(tops.id as string)?.isLeaf).toBe(false);
  });

  it('filters by a parent category inclusive of its descendants', async () => {
    const ids = await resolveDescendantIds({ categorySlug: 'tops' });
    const tops = TAXONOMY.find((p) => p.key === 'tops')!;
    expect(ids?.length).toBe(1 + tops.leaves.length);

    const parentRows = data(
      await listProducts({ query: { categorySlug: 'tops', sort: 'newest', view: 'full' as const, limit: 100, offset: 0 } }),
    );
    const leafRows = data(
      await listProducts({
        query: { categorySlug: 'tops-tshirts', sort: 'newest', view: 'full' as const, limit: 100, offset: 0 },
      }),
    );
    expect(leafRows.length).toBeGreaterThan(0);
    // The whole point: a parent is the union of its leaves, not an empty exact match.
    expect(parentRows.length).toBeGreaterThan(leafRows.length);
    const parentIds = new Set(parentRows.map((p) => p.id));
    for (const l of leafRows) expect(parentIds.has(l.id)).toBe(true);
  });

  it('treats an unknown category as "no products", not "no filter"', async () => {
    const rows = data(
      await listProducts({
        query: { categorySlug: 'not-a-real-slug', sort: 'newest', view: 'full' as const, limit: 50, offset: 0 },
      }),
    );
    expect(rows).toEqual([]);
  });

  it('sorts by price on the server, across the whole category not just one page', async () => {
    const asc = rowsOf(
      await listProducts({
        query: { categorySlug: 'tops', sort: 'price_asc', view: 'full' as const, limit: 20, offset: 0 },
      }),
    );
    const desc = rowsOf(
      await listProducts({
        query: { categorySlug: 'tops', sort: 'price_desc', view: 'full' as const, limit: 20, offset: 0 },
      }),
    );
    const cheapest = (p: (typeof asc)[number]) => Math.min(...p.variants.map((v) => v.pricePaise));
    const ascPrices = asc.map(cheapest);
    expect([...ascPrices].sort((a, b) => a - b)).toEqual(ascPrices);
    expect(cheapest(desc[0]!)).toBeGreaterThanOrEqual(cheapest(asc[0]!));
  });

  it('keeps a unisex product on both rails via its shared leaf', async () => {
    const her = rowsOf(
      await listProducts({
        query: { gender: 'her', categorySlug: 'shoes-sneakers', sort: 'newest', view: 'full' as const, limit: 50, offset: 0 },
      }),
    );
    const him = rowsOf(
      await listProducts({
        query: { gender: 'him', categorySlug: 'shoes-sneakers', sort: 'newest', view: 'full' as const, limit: 50, offset: 0 },
      }),
    );
    const shared = her.filter((p) => him.some((h) => h.id === p.id));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((p) => p.gender === 'unisex')).toBe(true);
  });

  it('pages without losing rows to variant shaping', async () => {
    const first = data(
      await listProducts({ query: { categorySlug: 'tops', sort: 'newest', view: 'full' as const, limit: 10, offset: 0 } }),
    );
    const second = data(
      await listProducts({ query: { categorySlug: 'tops', sort: 'newest', view: 'full' as const, limit: 10, offset: 10 } }),
    );
    expect(first.length).toBe(10);
    const firstIds = new Set(first.map((p) => p.id));
    for (const p of second) expect(firstIds.has(p.id)).toBe(false);
  });

  it('scopes facet totals to the category subtree', async () => {
    // The category facet deliberately ignores its own axis (so the UI can answer "what
    // else is there"), but `total` and the gender facet are scoped — and scoping has to
    // mean the whole subtree, not an exact match on the parent.
    const parent = data(await listFacets({ query: { categorySlug: 'tops' } }));
    const leaf = data(await listFacets({ query: { categorySlug: 'tops-tshirts' } }));
    expect(parent.total).toBeGreaterThan(leaf.total);
    expect(leaf.total).toBeGreaterThan(0);

    const parentGenderTotal = parent.genders.reduce((n, g) => n + g.count, 0);
    expect(parentGenderTotal).toBe(parent.total);
  });

  it('returns an empty facet set for an unknown category', async () => {
    const facets = data(await listFacets({ query: { categorySlug: 'not-a-real-slug' } }));
    expect(facets).toEqual({ total: 0, genders: [], categories: [] });
  });
});

/**
 * Occasion is a TAG, not a gendered thing.
 *
 * The seeded occasion collections are slugged `her-occasion-brunch` /
 * `him-occasion-streetwear`, which forced every caller to guess a rail prefix even
 * though the resolver only ever matched on `occasionTag`. The customer app asked for
 * `/collections/brunch`, got a 404, and silently fell back to a generic browse — so
 * every occasion tile rendered the same grid.
 */
/**
 * getCollection returns either a real collection row or a synthesised one (bare tag with
 * no row of its own), so its envelope is a union the generic data helper cannot narrow.
 */
const coll = (env: Awaited<ReturnType<typeof getCollection>>) =>
  env.data as { occasionTag: string | null; listings: { id: string; gender: string }[] };

describe('occasion collections', () => {
  it('resolves a bare occasion tag with no collection row of its own', async () => {
    const byTag = coll(await getCollection('brunch', { limit: 60 }));
    expect(byTag.occasionTag).toBe('brunch');
    expect(byTag.listings.length).toBeGreaterThan(0);
  });

  it('returns every rail when no gender is given', async () => {
    const all = coll(await getCollection('brunch', { limit: 200 }));
    const genders = new Set(all.listings.map((l) => l.gender));
    // The tag spans rails, so an unfiltered request must not be silently one-rail.
    expect(genders.size).toBeGreaterThan(1);
  });

  it('narrows to one rail plus unisex when gender is given', async () => {
    const him = coll(await getCollection('brunch', { gender: 'him', limit: 200 }));
    expect(him.listings.length).toBeGreaterThan(0);
    for (const l of him.listings) expect(['him', 'unisex']).toContain(l.gender);
    // Narrowing must actually narrow.
    const all = coll(await getCollection('brunch', { limit: 200 }));
    expect(him.listings.length).toBeLessThan(all.listings.length);
  });

  it('does not resolve a gender-prefixed slug — the prefix is gone', async () => {
    // Occasion slugs are bare tags now. A rail-prefixed slug is not a tag any listing
    // carries, so it must 404 rather than quietly resolving to something.
    await expect(getCollection('her-occasion-brunch', { limit: 60 })).rejects.toThrow();
  });

  it('a him-only occasion still resolves for a her request, just narrower', async () => {
    // 'gym' is seeded as a him occasion. Occasion is not owned by a rail, so asking as
    // her must return her+unisex products carrying the tag rather than 404.
    const all = coll(await getCollection('gym', { limit: 200 }));
    expect(all.listings.length).toBeGreaterThan(0);
    const her = coll(await getCollection('gym', { gender: 'her', limit: 200 }));
    for (const l of her.listings) expect(['her', 'unisex']).toContain(l.gender);
  });

  it('caps the result instead of returning the whole catalog', async () => {
    const capped = coll(await getCollection('brunch', { limit: 5 }));
    expect(capped.listings.length).toBeLessThanOrEqual(5);
  });

  it('404s on a tag no listing carries', async () => {
    await expect(getCollection('not-a-real-occasion', { limit: 60 })).rejects.toThrow();
  });
});
