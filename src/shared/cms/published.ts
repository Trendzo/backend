/**
 * The latest published CMS snapshot, held in memory.
 *
 * Every consumer app launch hits `GET /cms/home`, and the answer is one row that changes only
 * when an admin presses Publish. Reading it from Postgres on every request would be a pure
 * waste, so it is cached in-process behind a short TTL and dropped explicitly on publish or
 * restore — the same shape as `shared/catalog/category-tree.ts`, which is the established
 * pattern here (there is no Redis in this stack).
 *
 * The TTL matters even with explicit invalidation: the backend can run more than one process,
 * and only the process that served the publish call gets the invalidation. 60s bounds how long
 * a sibling process can keep serving the previous version.
 */

import { desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { cmsPublications } from '@/db/schema/cms.js';
import { asSnapshot, type CmsSnapshot } from './render.js';

const TTL_MS = 60_000;

type Cached = { loadedAt: number; version: number | null; snapshot: CmsSnapshot };

let cache: Cached | null = null;

/** Drop the cached snapshot — call after publish and after restoring an older version. */
export function invalidateCmsPublication(): void {
  cache = null;
}

/**
 * Latest publication, or an empty snapshot when nothing has ever been published. An empty
 * snapshot is a legitimate answer, not an error: the app ships its own content file and falls
 * back to it, so a brand-new environment renders correctly rather than blank.
 */
export async function latestPublication(): Promise<{
  version: number | null;
  snapshot: CmsSnapshot;
}> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) {
    return { version: cache.version, snapshot: cache.snapshot };
  }

  const rows = await db
    .select({ version: cmsPublications.version, payload: cmsPublications.payload })
    .from(cmsPublications)
    .orderBy(desc(cmsPublications.version))
    .limit(1);

  const row = rows[0];
  const next: Cached = row
    ? { loadedAt: Date.now(), version: row.version, snapshot: asSnapshot(row.payload) }
    : { loadedAt: Date.now(), version: null, snapshot: asSnapshot(null) };

  cache = next;
  return { version: next.version, snapshot: next.snapshot };
}
