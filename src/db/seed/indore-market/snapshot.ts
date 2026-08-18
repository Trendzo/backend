/**
 * Writes the composed catalog to `products.snapshot.json` — 400 flat, one-line-per-
 * product records — and prints a sample.
 *
 *   npx tsx src/db/seed/indore-market/snapshot.ts
 *
 * The snapshot is the only artifact where a human can actually see the thing that
 * matters: "Gucci Sherwani, Rs 1,299, photo of socks" is obvious in a flat list and
 * invisible in a generator. Commit it, and a future change to the vocabulary shows up
 * as a reviewable diff rather than as a surprise in production.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, loadImagePool } from './compose.js';
import { STORES } from './stores.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'products.snapshot.json');

const pool = loadImagePool();
// Fixed epoch so the snapshot is byte-stable across runs; the real createdAt is
// computed from the run clock at seed time.
const { listings } = compose(pool, new Date('2026-01-01T00:00:00Z'));

const flat = listings.map((l) => ({
  id: l.id,
  store: STORES[l.storeIndex]!.legalName,
  leaf: l.leafSlug,
  name: l.name,
  gender: l.gender,
  brand: l.brandName,
  priceRupees: l.variants[0]!.pricePaise / 100,
  sizes: [...new Set(l.variants.map((v) => v.size))],
  colors: [...new Set(l.variants.map((v) => v.colorName))],
  hsn: l.hsn,
  images: l.galleryUrls.length,
  firstImage: l.galleryUrls[0] ?? null,
}));

writeFileSync(OUT, `${JSON.stringify(flat, null, 2)}\n`, 'utf8');
console.log(`Wrote ${flat.length} records → ${OUT}\n`);

// One product from each of the 16 taxonomy parents — the spread a reviewer should scan.
const seenParent = new Set<string>();
console.log('Sample, one per parent category:\n');
for (const r of flat) {
  const parent = r.leaf.replace(/-[^-]+$/, '');
  if (seenParent.has(parent)) continue;
  seenParent.add(parent);
  console.log(`  ${r.name}`);
  console.log(`    leaf ${r.leaf} · ${r.gender} · ${r.brand} · Rs ${r.priceRupees} · HSN ${r.hsn ?? '—'}`);
  console.log(`    sizes ${r.sizes.join('/')} · colors ${r.colors.join('/')} · ${r.store}`);
}
