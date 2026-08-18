/**
 * Category tree lookups for browse.
 *
 * Since the retaxonomy the catalog is two-level, so filtering by a parent category has to
 * mean "this category OR anything under it" — a listing lives on a leaf (`tops-tshirts`),
 * while the rail's "Shop All" banner and the admin listing filter address the parent
 * (`tops`). Exact-equality filtering would return nothing for every parent.
 *
 * The table is ~134 rows and changes only when an admin edits the taxonomy, so the whole
 * thing is loaded once and walked in memory behind a short TTL. That is cheaper and far
 * simpler than a recursive CTE per request, and it also gives us child counts for free.
 * Admin writes call `invalidateCategoryTree()` so an edit shows up immediately.
 */

import { db } from '@/db/client.js';
import { canonicalCategorySlug } from './taxonomy.js';

export type CategoryNode = {
  id: string;
  slug: string;
  parentId: string | null;
};

const TTL_MS = 60_000;

let cache: { loadedAt: number; nodes: CategoryNode[] } | null = null;

/** Drop the cached tree — call after any admin create/patch/delete of a category. */
export function invalidateCategoryTree(): void {
  cache = null;
}

async function loadNodes(): Promise<CategoryNode[]> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.nodes;
  const nodes = await db.query.categories.findMany({
    columns: { id: true, slug: true, parentId: true },
  });
  cache = { loadedAt: Date.now(), nodes };
  return nodes;
}

/** Ids of every category that has at least one child. Lets a picker disable non-leaves. */
export async function parentIdSet(): Promise<Set<string>> {
  const nodes = await loadNodes();
  const parents = new Set<string>();
  for (const n of nodes) if (n.parentId) parents.add(n.parentId);
  return parents;
}

/**
 * A category plus every descendant, as ids. Accepts an id or a slug so callers can address
 * a category either way. Returns null when the reference matches nothing — callers treat
 * that as "filter matched no listings" rather than silently ignoring the filter, which
 * would leak the entire catalog on a typo'd slug.
 */
export async function resolveDescendantIds(ref: {
  categoryId?: string | undefined;
  categorySlug?: string | undefined;
}): Promise<string[] | null> {
  if (!ref.categoryId && !ref.categorySlug) return null;
  const nodes = await loadNodes();
  // Category slugs lost their gender prefix; shipped apps and CMS rows still send the
  // old ones, so every inbound slug is normalised here — the single choke point for
  // slug→category resolution.
  const slug = ref.categorySlug ? canonicalCategorySlug(ref.categorySlug) : undefined;
  const root = ref.categoryId
    ? nodes.find((n) => n.id === ref.categoryId)
    : nodes.find((n) => n.slug === slug);
  if (!root) return null;

  const childrenByParent = new Map<string, CategoryNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = childrenByParent.get(n.parentId);
    if (list) list.push(n);
    else childrenByParent.set(n.parentId, [n]);
  }

  // Breadth-first with a seen-set: the admin API guards against cycles on write, but a
  // cycle here would hang the request, so never trust the data to be acyclic.
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: CategoryNode[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push(cur.id);
    const kids = childrenByParent.get(cur.id);
    if (kids) queue.push(...kids);
  }
  return out;
}
