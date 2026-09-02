/**
 * The latest published theme snapshot, held in memory.
 *
 * Same shape and rationale as ./published.ts (the Home CMS cache): every app launch and
 * every half-hour refresh hits GET /cms/theme, and the answer is one row that changes only
 * when an admin presses Publish (or Disable now). The TTL matters even with explicit
 * invalidation because only the process that served the publish call sees it — 60s bounds
 * how long a sibling process serves the previous version, which is also the honest bound on
 * "disable now" propagation.
 */

import { desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { cmsThemePublications } from '@/db/schema/index.js';
import { asThemeSnapshot } from './theme-render.js';
import type { ThemeSnapshot } from './theme-schema.js';

const TTL_MS = 60_000;

type Cached = { loadedAt: number; version: number | null; snapshot: ThemeSnapshot };

let cache: Cached | null = null;

/** Drop the cached snapshot — call after publish, restore, and disable-now. */
export function invalidateThemePublication(): void {
  cache = null;
}

/**
 * Latest theme publication, or an empty snapshot when nothing was ever published. Empty is
 * a legitimate answer — the app owns its bundled LIGHT look and `theme: null` is the normal
 * response for most of the year.
 */
export async function latestThemePublication(): Promise<{
  version: number | null;
  snapshot: ThemeSnapshot;
}> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) {
    return { version: cache.version, snapshot: cache.snapshot };
  }

  const rows = await db
    .select({ version: cmsThemePublications.version, payload: cmsThemePublications.payload })
    .from(cmsThemePublications)
    .orderBy(desc(cmsThemePublications.version))
    .limit(1);

  const row = rows[0];
  const next: Cached = row
    ? { loadedAt: Date.now(), version: row.version, snapshot: asThemeSnapshot(row.payload) }
    : { loadedAt: Date.now(), version: null, snapshot: asThemeSnapshot(null) };

  cache = next;
  return { version: next.version, snapshot: next.snapshot };
}
