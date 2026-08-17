/**
 * Ranks each leaf's photo pool by how well the photo's own alt-text matches the
 * garment, and reports the leaves where stock photography let us down.
 *
 *   npx tsx src/db/seed/indore-market/vet-images.ts          # report only
 *   npx tsx src/db/seed/indore-market/vet-images.ts --apply  # reorder the pool file
 *
 * Why this exists: Unsplash is stock photography, not a product catalog. "mens kurta"
 * returns "a man standing next to a tree wearing a green shirt" alongside actual kurtas.
 * `compose.ts` takes the FIRST few photos of a pool, so sorting matched photos to the
 * front is what decides whether a listing shows the thing it claims to sell.
 *
 * Reordering rather than deleting is deliberate — a weak photo at position 20 costs
 * nothing, but an empty pool breaks the seed's invariants.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAF_SPECS } from './leaf-catalog.js';
import type { ImagePool, PoolPhoto } from './fetch-images.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_PATH = resolve(HERE, 'image-pool.json');
const APPLY = process.argv.includes('--apply');

/** How many photos from the front of a pool actually get used by compose(). */
const USED_DEPTH = 12;
/** Below this many matches in the used depth, the query needs rewriting. */
const WEAK_THRESHOLD = 4;

/**
 * Words that say nothing about what the garment IS.
 *
 * Note what is NOT here: "set" and "pair". They look like filler but they are the
 * load-bearing word for co-ords, pyjama sets and socks — dropping them scored
 * "Woman in floral print matching set" as a miss.
 */
const STOPWORDS = new Set([
  'womens', 'women', 'mens', 'men', 'product', 'plain',
  'india', 'indian', 'the', 'and', 'with', 'a', 'an', 'of', 'for', 'in', 'on',
]);

/** Extra words that reliably indicate the right subject for a given noun. */
const SYNONYMS: Record<string, string[]> = {
  'T-Shirt': ['tshirt', 't-shirt', 'tee'],
  Sneakers: ['sneaker', 'shoe', 'shoes', 'trainer'],
  Heels: ['heel', 'stiletto', 'pump'],
  Boots: ['boot'],
  Flats: ['flat', 'ballerina'],
  Sandals: ['sandal', 'slide'],
  Loafers: ['loafer'],
  'Formal Shoes': ['oxford', 'brogue', 'derby', 'shoe'],
  Jeans: ['jean', 'denim'],
  'Skinny Jeans': ['jean', 'denim'],
  'Slim Jeans': ['jean', 'denim'],
  'Baggy Jeans': ['jean', 'denim'],
  'Wide-Leg Jeans': ['jean', 'denim'],
  'Denim Shorts': ['denim', 'short'],
  'Denim Jacket': ['denim', 'jacket'],
  Kurta: ['kurta', 'ethnic', 'sherwani'],
  'Kurta Set': ['kurta', 'ethnic'],
  Sherwani: ['sherwani', 'groom', 'ethnic'],
  'Nehru Jacket': ['nehru', 'waistcoat', 'ethnic'],
  'Pathani Suit': ['pathani', 'kurta', 'ethnic'],
  Lipstick: ['lipstick', 'lip', 'makeup', 'cosmetic'],
  'Eau de Parfum': ['perfume', 'fragrance', 'bottle', 'scent'],
  'Face Serum': ['serum', 'skincare', 'bottle', 'dropper', 'cosmetic'],
  'Nail Polish': ['nail', 'polish', 'manicure'],
  'Beard Oil': ['beard', 'oil', 'grooming', 'bottle'],
  'Hair Pomade': ['pomade', 'hair', 'grooming', 'wax'],
  Earrings: ['earring', 'jewelry', 'jewellery'],
  Necklace: ['necklace', 'pendant', 'jewelry', 'jewellery'],
  Ring: ['ring', 'jewelry', 'jewellery'],
  Bracelet: ['bracelet', 'bangle', 'jewelry', 'jewellery'],
  Anklet: ['anklet', 'jewelry', 'jewellery'],
  Watch: ['watch', 'wristwatch', 'timepiece'],
  Sunglasses: ['sunglass', 'glasses', 'eyewear', 'shades'],
  Cap: ['cap', 'hat'],
  Hat: ['hat', 'cap'],
  Belt: ['belt', 'buckle'],
  Wallet: ['wallet', 'purse'],
  Socks: ['sock'],
  Tights: ['tight', 'stocking', 'hosiery'],
  Scarf: ['scarf', 'shawl'],
  'Hair Clip': ['hair', 'clip', 'barrette'],
  'Tote Bag': ['tote', 'bag'],
  Backpack: ['backpack', 'rucksack', 'bag'],
  'Crossbody Bag': ['crossbody', 'bag', 'purse'],
  'Duffle Bag': ['duffle', 'duffel', 'bag'],
  'Shoulder Bag': ['shoulder', 'bag', 'purse'],
  'Sling Bag': ['sling', 'bag'],
  Clutch: ['clutch', 'bag', 'purse'],
  'Laptop Bag': ['laptop', 'bag', 'briefcase'],
  'Mini Bag': ['bag', 'purse'],
  // Stock photographers describe these by their everyday name, not the retail one.
  Vest: ['tank', 'undershirt', 'singlet', 'vest'],
  Briefs: ['underwear', 'brief', 'boxer'],
  Boxers: ['underwear', 'boxer', 'short'],
  Bralette: ['bra', 'lingerie', 'bralette'],
  Bra: ['bra', 'lingerie'],
  Shapewear: ['bodysuit', 'shaper', 'lingerie'],
  'Lounge Pants': ['pyjama', 'pajama', 'sweatpant', 'lounge', 'pant'],
  'Loungewear Set': ['pyjama', 'pajama', 'loungewear', 'lounge'],
  'Pajama Set': ['pyjama', 'pajama', 'sleepwear'],
  Robe: ['robe', 'bathrobe', 'kimono'],
  Joggers: ['jogger', 'sweatpant', 'track', 'pant'],
  Chinos: ['chino', 'khaki', 'trouser', 'pant'],
  Trousers: ['trouser', 'pant', 'slack'],
  'Formal Trousers': ['trouser', 'pant', 'slack'],
  Overshirt: ['overshirt', 'shacket', 'flannel', 'shirt', 'jacket'],
  Waistcoat: ['waistcoat', 'vest'],
  Pants: ['pant', 'trouser'],
  'Wide-Leg Pants': ['pant', 'trouser'],
  Leggings: ['legging', 'tight'],
  'Gym Leggings': ['legging', 'tight'],
  'Track Pants': ['track', 'pant', 'sweatpant'],
  Tanks: ['tank', 'singlet'],
  Tank: ['tank', 'singlet'],
};

function keywordsFor(noun: string, query: string): string[] {
  const fromNoun = noun.toLowerCase().split(/[^a-z]+/).filter((w) => w && !STOPWORDS.has(w));
  const fromQuery = query.toLowerCase().split(/[^a-z]+/).filter((w) => w && !STOPWORDS.has(w));
  const extra = (SYNONYMS[noun] ?? []).map((w) => w.toLowerCase());
  return [...new Set([...fromNoun, ...fromQuery, ...extra])];
}

/** 2 = alt names the garment, 1 = alt exists but is unrelated, 0 = no alt at all. */
function scorePhoto(p: PoolPhoto, keywords: string[]): number {
  if (!p.alt) return 0;
  const alt = p.alt.toLowerCase();
  return keywords.some((k) => alt.includes(k)) ? 2 : 1;
}

function main(): void {
  const pool = JSON.parse(readFileSync(POOL_PATH, 'utf8')) as ImagePool;
  const weak: { slug: string; matches: number; query: string; sample: string[] }[] = [];
  let reordered = 0;
  let cached = 0;

  for (const spec of LEAF_SPECS) {
    const photos = pool[spec.slug];
    if (!photos?.length) continue;
    cached += 1;

    const keywords = keywordsFor(spec.noun, spec.query);
    const scored = photos.map((p, i) => ({ p, i, s: scorePhoto(p, keywords) }));
    // Stable sort: matched first, then original order (Unsplash relevance).
    const sorted = [...scored].sort((a, b) => b.s - a.s || a.i - b.i);

    if (sorted.some((x, i) => x.i !== i)) reordered += 1;
    pool[spec.slug] = sorted.map((x) => x.p);

    const matchesInUsed = sorted.slice(0, USED_DEPTH).filter((x) => x.s === 2).length;
    if (matchesInUsed < WEAK_THRESHOLD) {
      weak.push({
        slug: spec.slug,
        matches: matchesInUsed,
        query: spec.query,
        sample: sorted.slice(0, 3).map((x) => x.p.alt ?? '(no description)'),
      });
    }
  }

  console.log(`Leaves with photos: ${cached}/${LEAF_SPECS.length}`);
  console.log(`Pools reordered:    ${reordered}`);
  console.log(`Weak pools (<${WEAK_THRESHOLD} confident matches in the top ${USED_DEPTH}): ${weak.length}\n`);

  for (const w of weak) {
    console.log(`  ${w.slug}  [${w.matches} matches]  query: "${w.query}"`);
    for (const s of w.sample) console.log(`      · ${s}`);
  }

  if (APPLY) {
    writeFileSync(POOL_PATH, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
    console.log(`\nReordered pool written to ${POOL_PATH}`);
  } else {
    console.log('\nReport only. Re-run with --apply to write the reordered pool.');
  }
}

main();
