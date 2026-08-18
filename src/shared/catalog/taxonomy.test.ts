import { describe, expect, it } from 'vitest';
import { TAXONOMY, canonicalCategorySlug, leafSlug, parentSlug, railFor } from './taxonomy.js';

/**
 * The taxonomy is stored once as a mixed-gender tree but has to render as the two
 * arrays the consumer app was hardcoding. These expectations are transcribed from
 * `customer-app/src/screens/CategoryBrowseScreen.tsx` — `TAXONOMY` (:107-324) and
 * `HIM_TAXONOMY` (:330-420) — so if the seed drifts from the design, this fails.
 */
const HER_EXPECTED: [string, string[]][] = [
  ['Tops', ['T-Shirts', 'Blouses', 'Shirts', 'Tank Tops', 'Camis', 'Crop Tops', 'Bodysuits', 'Sweatshirts', 'Hoodies', 'Sweaters', 'Cardigans']],
  ['Dresses', ['Mini Dresses', 'Midi Dresses', 'Maxi Dresses', 'Bodycon Dresses', 'Party Dresses', 'Casual Dresses']],
  ['Co-ords', ['Two-Piece Sets', 'Matching Sets', 'Skirt Sets', 'Pant Sets']],
  ['Bottoms', ['Pants', 'Trousers', 'Skirts', 'Shorts', 'Leggings', 'Wide-Leg', 'Cargo Pants']],
  ['Denim', ['Jeans', 'Skinny Jeans', 'Wide-Leg Jeans', 'Baggy Jeans', 'Denim Jackets', 'Denim Shorts']],
  ['Loungewear', ['Pajama Sets', 'Robes', 'Bras', 'Bralettes', 'Shapewear', 'Loungewear Sets']],
  ['Activewear', ['Sports Bras', 'Gym Leggings', 'Track Pants', 'Workout Tops', 'Windbreakers']],
  ['Swimwear', ['Bikinis', 'One-Pieces', 'Cover-Ups', 'Beach Dresses']],
  ['Outerwear', ['Jackets', 'Blazers', 'Coats', 'Puffers', 'Trench Coats', 'Bombers']],
  ['Shoes', ['Sneakers', 'Heels', 'Boots', 'Flats', 'Sandals', 'Loafers']],
  ['Bags', ['Tote Bags', 'Crossbody Bags', 'Shoulder Bags', 'Clutches', 'Backpacks', 'Mini Bags']],
  ['Accessories', ['Belts', 'Hats', 'Caps', 'Sunglasses', 'Scarves', 'Hair Accessories', 'Socks', 'Tights']],
  ['Jewelry', ['Earrings', 'Necklaces', 'Rings', 'Bracelets', 'Anklets']],
  ['Beauty', ['Makeup', 'Skincare', 'Nails', 'Fragrance']],
];

const HIM_EXPECTED: [string, string[]][] = [
  ['Tops', ['T-Shirts', 'Shirts', 'Polos', 'Hoodies', 'Sweatshirts', 'Sweaters', 'Vests']],
  ['Bottoms', ['Jeans', 'Trousers', 'Cargo Pants', 'Joggers', 'Shorts', 'Chinos']],
  ['Denim', ['Jeans', 'Baggy Jeans', 'Slim Jeans', 'Denim Jackets', 'Denim Shorts']],
  ['Ethnic Wear', ['Kurtas', 'Kurta Sets', 'Nehru Jackets', 'Sherwanis', 'Pathani']],
  ['Formalwear', ['Blazers', 'Suits', 'Formal Shirts', 'Formal Trousers', 'Waistcoats']],
  ['Outerwear', ['Jackets', 'Bombers', 'Coats', 'Puffers', 'Overshirts']],
  ['Activewear', ['Gym T-Shirts', 'Track Pants', 'Shorts', 'Tanks', 'Windbreakers']],
  ['Innerwear', ['Vests', 'Boxers', 'Briefs', 'Pajama Sets', 'Lounge Pants']],
  ['Beachwear', ['Swim Shorts', 'Beach Shirts']],
  ['Footwear', ['Sneakers', 'Formal Shoes', 'Loafers', 'Sandals', 'Boots']],
  ['Accessories', ['Caps', 'Belts', 'Sunglasses', 'Watches', 'Wallets']],
  ['Bags', ['Backpacks', 'Duffles', 'Sling Bags', 'Laptop Bags']],
  ['Grooming', ['Fragrance', 'Beard Care', 'Skincare', 'Hair']],
];

describe('category taxonomy', () => {
  it('renders the HER rail exactly as the app designed it', () => {
    const rail = railFor('her');
    expect(rail.map((p) => p.label)).toEqual(HER_EXPECTED.map(([l]) => l));
    for (const [label, leaves] of HER_EXPECTED) {
      expect(rail.find((p) => p.label === label)?.leaves.map((l) => l.label)).toEqual(leaves);
    }
  });

  it('renders the HIM rail exactly as the app designed it', () => {
    const rail = railFor('him');
    expect(rail.map((p) => p.label)).toEqual(HIM_EXPECTED.map(([l]) => l));
    for (const [label, leaves] of HIM_EXPECTED) {
      expect(rail.find((p) => p.label === label)?.leaves.map((l) => l.label)).toEqual(leaves);
    }
  });

  it('gives every node a globally unique slug', () => {
    const slugs = TAXONOMY.flatMap((p) => [
      parentSlug(p),
      ...p.leaves.map((l) => leafSlug(p, l.key)),
    ]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps a shared leaf under every parent that both rails render', () => {
    // The whole point of the mixed-gender tree: a unisex product must have somewhere to
    // live under each shared parent, or it vanishes from one rail.
    //
    // `swim` is the one honest exception — HER swimwear (Bikinis, One-Pieces, Cover-Ups,
    // Beach Dresses) and HIM beachwear (Swim Shorts, Beach Shirts) overlap in nothing, and
    // inventing a shared tile would put a sub-category on the rail the design never drew.
    // A unisex swim listing therefore picks a side.
    const NO_SHARED_LEAF = new Set(['swim']);
    const shared = TAXONOMY.filter((p) => p.gender === 'unisex' && !NO_SHARED_LEAF.has(p.key));
    for (const p of shared) {
      const unisexLeaves = p.leaves.filter((l) => (l.gender ?? p.gender) === 'unisex');
      expect(unisexLeaves.length, `${p.key} has no unisex leaf`).toBeGreaterThan(0);
    }
  });

  it('never leaves a gendered leaf stranded under the other gender', () => {
    for (const p of TAXONOMY) {
      if (p.gender === 'unisex') continue;
      for (const l of p.leaves) {
        expect(l.gender ?? p.gender, `${p.key}/${l.key}`).toBe(p.gender);
      }
    }
  });
});

/**
 * Slugs dropped their gender prefix, but apps already on phones — and CMS rows, and
 * order snapshots — still send the old ones. If this alias map ever stops covering
 * them, category browse silently returns nothing for those clients.
 */
describe('legacy category slugs', () => {
  it('maps every renamed parent and leaf to its current slug', () => {
    expect(canonicalCategorySlug('her-dresses')).toBe('dresses');
    expect(canonicalCategorySlug('her-dresses-midi')).toBe('dresses-midi');
    expect(canonicalCategorySlug('her-coords-skirt-sets')).toBe('coords-skirt-sets');
    expect(canonicalCategorySlug('her-jewelry-necklaces')).toBe('jewelry-necklaces');
    expect(canonicalCategorySlug('him-ethnic-kurtas')).toBe('ethnic-kurtas');
    expect(canonicalCategorySlug('him-formal-waistcoats')).toBe('formal-waistcoats');
  });

  it('covers every leaf of every renamed parent, not just the ones spot-checked', () => {
    for (const p of TAXONOMY) {
      if (p.gender === 'unisex') continue;
      const legacyParent = `${p.gender}-${p.key}`;
      expect(canonicalCategorySlug(legacyParent)).toBe(p.key);
      for (const l of p.leaves) {
        expect(canonicalCategorySlug(`${legacyParent}-${l.key}`)).toBe(`${p.key}-${l.key}`);
      }
    }
  });

  it('passes unknown and already-current slugs through untouched', () => {
    expect(canonicalCategorySlug('tops-tshirts')).toBe('tops-tshirts');
    expect(canonicalCategorySlug('dresses-midi')).toBe('dresses-midi');
    expect(canonicalCategorySlug('not-a-slug')).toBe('not-a-slug');
  });

  it('leaves no current slug carrying a rail prefix', () => {
    for (const p of TAXONOMY) {
      expect(parentSlug(p).startsWith('her-')).toBe(false);
      expect(parentSlug(p).startsWith('him-')).toBe(false);
    }
  });
});
