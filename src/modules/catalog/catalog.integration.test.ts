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
import { listCategories, listFacets, listProducts } from './catalog.controller.js';

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
