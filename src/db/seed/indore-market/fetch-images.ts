/**
 * Fetches a photo pool per LEAF category from Unsplash into `image-pool.json`.
 *
 * Run:  UNSPLASH_ACCESS_KEY=... npx tsx src/db/seed/indore-market/fetch-images.ts
 *
 * Why a cache file rather than fetching inside the seed:
 *  - the demo-tier key allows 50 requests/hour, and there are 118 leaves, so a full
 *    sweep spans ~3 hourly windows. The seed must not depend on that.
 *  - Unsplash is stock photography, not a product catalog. "mens kurta" happily returns
 *    "a man standing next to a tree wearing a green shirt". Every photo is stored WITH
 *    its `alt` text so the pool can be reviewed by a human and bad matches swapped out
 *    BEFORE anything reaches the database.
 *  - once vetted, seeding is deterministic and re-runnable at zero API cost.
 *
 * Resumable: leaves already present in the file are skipped, so re-running after a
 * rate-limit pause (or a crash) picks up exactly where it stopped.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAF_SPECS } from './leaf-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_PATH = resolve(HERE, 'image-pool.json');

const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PER_PAGE = 30;
/** Politeness gap between calls; the hourly cap is the real constraint. */
const GAP_MS = 400;

export type PoolPhoto = {
  id: string;
  /** `urls.raw` — the seed appends its own sizing params. */
  raw: string;
  /** Unsplash's own description. This is what makes human vetting possible. */
  alt: string | null;
  /** Attribution, required by the Unsplash API terms. */
  by: string;
  byLink: string;
};

export type ImagePool = Record<string, PoolPhoto[]>;

function loadPool(): ImagePool {
  if (!existsSync(POOL_PATH)) return {};
  return JSON.parse(readFileSync(POOL_PATH, 'utf8')) as ImagePool;
}

function savePool(pool: ImagePool): void {
  mkdirSync(dirname(POOL_PATH), { recursive: true });
  writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SearchResult = { photos: PoolPhoto[]; remaining: number };

async function search(query: string): Promise<SearchResult> {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('content_filter', 'high');

  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${ACCESS_KEY}`, 'Accept-Version': 'v1' },
  });

  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '0');

  if (res.status === 403) {
    // Unsplash returns 403 (not 429) when the hourly allowance is spent.
    throw Object.assign(new Error('rate-limited'), { rateLimited: true });
  }
  if (!res.ok) {
    throw new Error(`Unsplash ${res.status} for "${query}": ${await res.text()}`);
  }

  const body = (await res.json()) as {
    results: {
      id: string;
      urls: { raw: string };
      alt_description: string | null;
      user: { name: string; links: { html: string } };
    }[];
  };

  return {
    remaining,
    photos: body.results.map((p) => ({
      id: p.id,
      raw: p.urls.raw,
      alt: p.alt_description,
      by: p.user.name,
      byLink: p.user.links.html,
    })),
  };
}

async function main(): Promise<void> {
  if (!ACCESS_KEY) {
    console.error('UNSPLASH_ACCESS_KEY is not set. Export it and re-run.');
    process.exit(1);
  }

  const pool = loadPool();
  const todo = LEAF_SPECS.filter((s) => !pool[s.slug]?.length);

  console.log(`Leaves: ${LEAF_SPECS.length} · cached: ${LEAF_SPECS.length - todo.length} · to fetch: ${todo.length}`);
  if (!todo.length) {
    console.log('Pool is complete. Nothing to do.');
    return;
  }

  let done = 0;
  for (const spec of todo) {
    try {
      const { photos, remaining } = await search(spec.query);
      pool[spec.slug] = photos;
      savePool(pool);
      done += 1;
      console.log(
        `  [${done}/${todo.length}] ${spec.slug} ← "${spec.query}" · ${photos.length} photos · ${remaining} req left`,
      );

      // Exit rather than sleep out the hour. Everything fetched is already on disk, so
      // re-running an hour later resumes exactly here — and a short-lived process
      // survives supervisors that cap how long a command may run.
      if (remaining <= 1) {
        console.log(`\n  → hourly allowance spent after ${done} leaf/leaves. Re-run in ~60 min to continue.`);
        break;
      }
      await sleep(GAP_MS);
    } catch (err) {
      if ((err as { rateLimited?: boolean }).rateLimited) {
        console.log(`\n  → rate-limited on ${spec.slug}. Re-run in ~60 min to continue.`);
        break;
      }
      console.error(`  ! ${spec.slug}: ${(err as Error).message}`);
    }
  }

  const filled = LEAF_SPECS.filter((s) => pool[s.slug]?.length).length;
  console.log(`\nDone. ${filled}/${LEAF_SPECS.length} leaves have photos → ${POOL_PATH}`);
  if (filled < LEAF_SPECS.length) console.log('Re-run to pick up the remainder.');
}

void main();
