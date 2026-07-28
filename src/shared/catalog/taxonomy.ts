/**
 * The real two-level category taxonomy the consumer app renders.
 *
 * Mirrors `customer-app/src/screens/CategoryBrowseScreen.tsx` — `TAXONOMY` (HER, 14
 * parents / 84 sub-tiles) and `HIM_TAXONOMY` (HIM, 13 parents / 63 sub-tiles). Those
 * two arrays were the app's hardcoded source of truth; this seeder makes the database
 * the source of truth instead, and the app falls back to them only when offline.
 *
 * MIXED-GENDER TREE. A node both rails render is `unisex`; a node only one rail has is
 * `her`/`him`. Each rail then asks for "my gender OR unisex" at both levels, the same
 * rule listings and collections already use. The payoff is that a genuinely unisex
 * product (a canvas sneaker, a fleece hoodie) lives in ONE shared leaf and shows up
 * under HER *and* HIM — which is impossible if the trees are duplicated per gender.
 *
 * Where the two rails disagree only on wording or position, `labelHim` / `sortOrderHim`
 * carry the HIM variant instead of forcing a duplicate node:
 *   labelHim      Shoes→Footwear, Loungewear→Innerwear, Swimwear→Beachwear, Beauty→Grooming
 *   sortOrderHim  HER has Activewear before Outerwear and Bags before Accessories; HIM reverses both
 *
 * Result: 16 parents + 118 leaves = 134 rows, and each rail reconstructs its original
 * array exactly (HER 14 parents/84 leaves, HIM 13 parents/63 leaves).
 *
 * Pure data — no database imports — so `category-taxonomy.ts` can seed it and the unit
 * test can assert each rail reconstructs its original array without a live DB.
 */

export type Gender = 'her' | 'him' | 'unisex';

/** A sub-tile. `gender` defaults to the parent's. Sort values are rail positions × 10. */
export type Leaf = {
  key: string;
  label: string;
  gender?: Gender;
  sortOrder: number;
  sortOrderHim?: number;
};

export type Parent = {
  /** Slug is `key` for unisex parents, `<gender>-<key>` for gendered ones. */
  key: string;
  label: string;
  labelHim?: string;
  gender: Gender;
  iconName: string;
  tintColor: string;
  sortOrder: number;
  sortOrderHim?: number;
  leaves: Leaf[];
};

export const TAXONOMY: Parent[] = [
  {
    key: 'tops',
    label: 'Tops',
    gender: 'unisex',
    iconName: 'shirt-outline',
    tintColor: '#A78BFA',
    sortOrder: 10,
    sortOrderHim: 10,
    leaves: [
      { key: 'tshirts', label: 'T-Shirts', sortOrder: 10, sortOrderHim: 10 },
      { key: 'blouses', label: 'Blouses', gender: 'her', sortOrder: 20 },
      { key: 'shirts', label: 'Shirts', sortOrder: 30, sortOrderHim: 20 },
      { key: 'polos', label: 'Polos', gender: 'him', sortOrder: 30 },
      { key: 'tank-tops', label: 'Tank Tops', gender: 'her', sortOrder: 40 },
      { key: 'camis', label: 'Camis', gender: 'her', sortOrder: 50 },
      { key: 'crop-tops', label: 'Crop Tops', gender: 'her', sortOrder: 60 },
      { key: 'bodysuits', label: 'Bodysuits', gender: 'her', sortOrder: 70 },
      { key: 'vests', label: 'Vests', gender: 'him', sortOrder: 70 },
      { key: 'sweatshirts', label: 'Sweatshirts', sortOrder: 80, sortOrderHim: 50 },
      { key: 'hoodies', label: 'Hoodies', sortOrder: 90, sortOrderHim: 40 },
      { key: 'sweaters', label: 'Sweaters', sortOrder: 100, sortOrderHim: 60 },
      { key: 'cardigans', label: 'Cardigans', gender: 'her', sortOrder: 110 },
    ],
  },
  {
    key: 'dresses',
    label: 'Dresses',
    gender: 'her',
    iconName: 'woman-outline',
    tintColor: '#FFAFBD',
    sortOrder: 20,
    leaves: [
      { key: 'mini', label: 'Mini Dresses', sortOrder: 10 },
      { key: 'midi', label: 'Midi Dresses', sortOrder: 20 },
      { key: 'maxi', label: 'Maxi Dresses', sortOrder: 30 },
      { key: 'bodycon', label: 'Bodycon Dresses', sortOrder: 40 },
      { key: 'party', label: 'Party Dresses', sortOrder: 50 },
      { key: 'casual', label: 'Casual Dresses', sortOrder: 60 },
    ],
  },
  {
    key: 'coords',
    label: 'Co-ords',
    gender: 'her',
    iconName: 'albums-outline',
    tintColor: '#FFC3A0',
    sortOrder: 30,
    leaves: [
      { key: 'two-piece', label: 'Two-Piece Sets', sortOrder: 10 },
      { key: 'matching', label: 'Matching Sets', sortOrder: 20 },
      { key: 'skirt-sets', label: 'Skirt Sets', sortOrder: 30 },
      { key: 'pant-sets', label: 'Pant Sets', sortOrder: 40 },
    ],
  },
  {
    key: 'bottoms',
    label: 'Bottoms',
    gender: 'unisex',
    iconName: 'walk-outline',
    tintColor: '#FECA57',
    sortOrder: 40,
    sortOrderHim: 20,
    leaves: [
      { key: 'pants', label: 'Pants', gender: 'her', sortOrder: 10 },
      { key: 'jeans', label: 'Jeans', gender: 'him', sortOrder: 10 },
      { key: 'trousers', label: 'Trousers', sortOrder: 20, sortOrderHim: 20 },
      { key: 'skirts', label: 'Skirts', gender: 'her', sortOrder: 30 },
      { key: 'shorts', label: 'Shorts', sortOrder: 40, sortOrderHim: 50 },
      { key: 'joggers', label: 'Joggers', gender: 'him', sortOrder: 40 },
      { key: 'leggings', label: 'Leggings', gender: 'her', sortOrder: 50 },
      { key: 'wide-leg', label: 'Wide-Leg', gender: 'her', sortOrder: 60 },
      { key: 'chinos', label: 'Chinos', gender: 'him', sortOrder: 60 },
      // HER calls these "Cargo Pants", HIM "Cargos" — same thing, one leaf.
      { key: 'cargos', label: 'Cargo Pants', sortOrder: 70, sortOrderHim: 30 },
    ],
  },
  {
    key: 'denim',
    label: 'Denim',
    gender: 'unisex',
    iconName: 'layers-outline',
    tintColor: '#4A6FA5',
    sortOrder: 50,
    sortOrderHim: 30,
    leaves: [
      { key: 'jeans', label: 'Jeans', sortOrder: 10, sortOrderHim: 10 },
      { key: 'skinny', label: 'Skinny Jeans', gender: 'her', sortOrder: 20 },
      { key: 'wide-leg', label: 'Wide-Leg Jeans', gender: 'her', sortOrder: 30 },
      { key: 'slim', label: 'Slim Jeans', gender: 'him', sortOrder: 30 },
      { key: 'baggy', label: 'Baggy Jeans', sortOrder: 40, sortOrderHim: 20 },
      { key: 'jackets', label: 'Denim Jackets', sortOrder: 50, sortOrderHim: 40 },
      { key: 'shorts', label: 'Denim Shorts', sortOrder: 60, sortOrderHim: 50 },
    ],
  },
  {
    key: 'lounge',
    label: 'Loungewear',
    labelHim: 'Innerwear',
    gender: 'unisex',
    iconName: 'moon-outline',
    tintColor: '#F5E6D3',
    sortOrder: 60,
    sortOrderHim: 80,
    leaves: [
      { key: 'pajamas', label: 'Pajama Sets', sortOrder: 10, sortOrderHim: 40 },
      { key: 'vests', label: 'Vests', gender: 'him', sortOrder: 10 },
      { key: 'robes', label: 'Robes', gender: 'her', sortOrder: 20 },
      { key: 'boxers', label: 'Boxers', gender: 'him', sortOrder: 20 },
      { key: 'bras', label: 'Bras', gender: 'her', sortOrder: 30 },
      { key: 'briefs', label: 'Briefs', gender: 'him', sortOrder: 30 },
      { key: 'bralettes', label: 'Bralettes', gender: 'her', sortOrder: 40 },
      { key: 'shapewear', label: 'Shapewear', gender: 'her', sortOrder: 50 },
      { key: 'lounge-pants', label: 'Lounge Pants', gender: 'him', sortOrder: 50 },
      { key: 'sets', label: 'Loungewear Sets', gender: 'her', sortOrder: 60 },
    ],
  },
  {
    key: 'active',
    label: 'Activewear',
    gender: 'unisex',
    iconName: 'barbell-outline',
    tintColor: '#4ECDC4',
    sortOrder: 70,
    sortOrderHim: 70,
    leaves: [
      { key: 'sports-bras', label: 'Sports Bras', gender: 'her', sortOrder: 10 },
      { key: 'gym-tees', label: 'Gym T-Shirts', gender: 'him', sortOrder: 10 },
      { key: 'gym-leggings', label: 'Gym Leggings', gender: 'her', sortOrder: 20 },
      { key: 'track-pants', label: 'Track Pants', sortOrder: 30, sortOrderHim: 20 },
      { key: 'shorts', label: 'Shorts', gender: 'him', sortOrder: 30 },
      { key: 'workout-tops', label: 'Workout Tops', gender: 'her', sortOrder: 40 },
      { key: 'tanks', label: 'Tanks', gender: 'him', sortOrder: 40 },
      { key: 'windbreakers', label: 'Windbreakers', sortOrder: 50, sortOrderHim: 50 },
    ],
  },
  {
    key: 'swim',
    label: 'Swimwear',
    labelHim: 'Beachwear',
    gender: 'unisex',
    iconName: 'water-outline',
    tintColor: '#A8E6CF',
    sortOrder: 80,
    sortOrderHim: 90,
    leaves: [
      { key: 'bikinis', label: 'Bikinis', gender: 'her', sortOrder: 10 },
      { key: 'swim-shorts', label: 'Swim Shorts', gender: 'him', sortOrder: 10 },
      { key: 'one-pieces', label: 'One-Pieces', gender: 'her', sortOrder: 20 },
      { key: 'beach-shirts', label: 'Beach Shirts', gender: 'him', sortOrder: 20 },
      { key: 'cover-ups', label: 'Cover-Ups', gender: 'her', sortOrder: 30 },
      { key: 'beach-dresses', label: 'Beach Dresses', gender: 'her', sortOrder: 40 },
    ],
  },
  {
    key: 'outerwear',
    label: 'Outerwear',
    gender: 'unisex',
    iconName: 'shield-outline',
    tintColor: '#2C3E50',
    sortOrder: 90,
    sortOrderHim: 60,
    leaves: [
      { key: 'jackets', label: 'Jackets', sortOrder: 10, sortOrderHim: 10 },
      { key: 'blazers', label: 'Blazers', gender: 'her', sortOrder: 20 },
      { key: 'coats', label: 'Coats', sortOrder: 30, sortOrderHim: 30 },
      { key: 'puffers', label: 'Puffers', sortOrder: 40, sortOrderHim: 40 },
      { key: 'trench', label: 'Trench Coats', gender: 'her', sortOrder: 50 },
      { key: 'overshirts', label: 'Overshirts', gender: 'him', sortOrder: 50 },
      { key: 'bombers', label: 'Bombers', sortOrder: 60, sortOrderHim: 20 },
    ],
  },
  {
    key: 'shoes',
    label: 'Shoes',
    labelHim: 'Footwear',
    gender: 'unisex',
    iconName: 'footsteps-outline',
    tintColor: '#5D4037',
    sortOrder: 100,
    sortOrderHim: 100,
    leaves: [
      { key: 'sneakers', label: 'Sneakers', sortOrder: 10, sortOrderHim: 10 },
      { key: 'heels', label: 'Heels', gender: 'her', sortOrder: 20 },
      { key: 'formal', label: 'Formal Shoes', gender: 'him', sortOrder: 20 },
      { key: 'boots', label: 'Boots', sortOrder: 30, sortOrderHim: 50 },
      { key: 'flats', label: 'Flats', gender: 'her', sortOrder: 40 },
      { key: 'sandals', label: 'Sandals', sortOrder: 50, sortOrderHim: 40 },
      { key: 'loafers', label: 'Loafers', sortOrder: 60, sortOrderHim: 30 },
    ],
  },
  {
    key: 'bags',
    label: 'Bags',
    gender: 'unisex',
    iconName: 'bag-handle-outline',
    tintColor: '#8B5E3C',
    sortOrder: 110,
    sortOrderHim: 120,
    leaves: [
      { key: 'totes', label: 'Tote Bags', gender: 'her', sortOrder: 10 },
      { key: 'backpacks', label: 'Backpacks', sortOrder: 50, sortOrderHim: 10 },
      { key: 'crossbody', label: 'Crossbody Bags', gender: 'her', sortOrder: 20 },
      { key: 'duffles', label: 'Duffles', gender: 'him', sortOrder: 20 },
      { key: 'shoulder', label: 'Shoulder Bags', gender: 'her', sortOrder: 30 },
      { key: 'slings', label: 'Sling Bags', gender: 'him', sortOrder: 30 },
      { key: 'clutches', label: 'Clutches', gender: 'her', sortOrder: 40 },
      { key: 'laptop', label: 'Laptop Bags', gender: 'him', sortOrder: 40 },
      { key: 'mini', label: 'Mini Bags', gender: 'her', sortOrder: 60 },
    ],
  },
  {
    key: 'accessories',
    label: 'Accessories',
    gender: 'unisex',
    iconName: 'glasses-outline',
    tintColor: '#A9BFE6',
    sortOrder: 120,
    sortOrderHim: 110,
    leaves: [
      { key: 'belts', label: 'Belts', sortOrder: 10, sortOrderHim: 20 },
      { key: 'hats', label: 'Hats', gender: 'her', sortOrder: 20 },
      { key: 'caps', label: 'Caps', sortOrder: 30, sortOrderHim: 10 },
      { key: 'sunglasses', label: 'Sunglasses', sortOrder: 40, sortOrderHim: 30 },
      { key: 'watches', label: 'Watches', gender: 'him', sortOrder: 40 },
      { key: 'scarves', label: 'Scarves', gender: 'her', sortOrder: 50 },
      { key: 'wallets', label: 'Wallets', gender: 'him', sortOrder: 50 },
      { key: 'hair', label: 'Hair Accessories', gender: 'her', sortOrder: 60 },
      { key: 'socks', label: 'Socks', gender: 'her', sortOrder: 70 },
      { key: 'tights', label: 'Tights', gender: 'her', sortOrder: 80 },
    ],
  },
  {
    key: 'jewelry',
    label: 'Jewelry',
    gender: 'her',
    iconName: 'diamond-outline',
    tintColor: '#FFE66D',
    sortOrder: 130,
    leaves: [
      { key: 'earrings', label: 'Earrings', sortOrder: 10 },
      { key: 'necklaces', label: 'Necklaces', sortOrder: 20 },
      { key: 'rings', label: 'Rings', sortOrder: 30 },
      { key: 'bracelets', label: 'Bracelets', sortOrder: 40 },
      { key: 'anklets', label: 'Anklets', sortOrder: 50 },
    ],
  },
  {
    key: 'beauty',
    label: 'Beauty',
    labelHim: 'Grooming',
    gender: 'unisex',
    iconName: 'color-palette-outline',
    tintColor: '#FF6B9D',
    sortOrder: 140,
    sortOrderHim: 130,
    leaves: [
      { key: 'makeup', label: 'Makeup', gender: 'her', sortOrder: 10 },
      { key: 'fragrance', label: 'Fragrance', sortOrder: 40, sortOrderHim: 10 },
      { key: 'beard', label: 'Beard Care', gender: 'him', sortOrder: 20 },
      { key: 'skincare', label: 'Skincare', sortOrder: 20, sortOrderHim: 30 },
      { key: 'nails', label: 'Nails', gender: 'her', sortOrder: 30 },
      { key: 'hair', label: 'Hair', gender: 'him', sortOrder: 40 },
    ],
  },
  {
    key: 'ethnic',
    label: 'Ethnic Wear',
    gender: 'him',
    iconName: 'ribbon-outline',
    tintColor: '#3E2723',
    sortOrder: 40,
    leaves: [
      { key: 'kurtas', label: 'Kurtas', sortOrder: 10 },
      { key: 'kurta-sets', label: 'Kurta Sets', sortOrder: 20 },
      { key: 'nehru-jackets', label: 'Nehru Jackets', sortOrder: 30 },
      { key: 'sherwanis', label: 'Sherwanis', sortOrder: 40 },
      { key: 'pathani', label: 'Pathani', sortOrder: 50 },
    ],
  },
  {
    key: 'formal',
    label: 'Formalwear',
    gender: 'him',
    iconName: 'business-outline',
    tintColor: '#1A1A1A',
    sortOrder: 50,
    leaves: [
      { key: 'blazers', label: 'Blazers', sortOrder: 10 },
      { key: 'suits', label: 'Suits', sortOrder: 20 },
      { key: 'shirts', label: 'Formal Shirts', sortOrder: 30 },
      { key: 'trousers', label: 'Formal Trousers', sortOrder: 40 },
      { key: 'waistcoats', label: 'Waistcoats', sortOrder: 50 },
    ],
  },
];

/** Slug for a parent: bare key when unisex, gender-prefixed when it belongs to one rail. */
export const parentSlug = (p: Pick<Parent, 'key' | 'gender'>): string =>
  p.gender === 'unisex' ? p.key : `${p.gender}-${p.key}`;

/** Slug for a leaf: always `<parentSlug>-<leafKey>`, which keeps them globally unique. */
export const leafSlug = (p: Pick<Parent, 'key' | 'gender'>, leafKey: string): string =>
  `${parentSlug(p)}-${leafKey}`;

/** A node is on a rail when it is that gender or shared. Same rule as listings. */
export const visibleTo = (nodeGender: Gender, rail: 'her' | 'him'): boolean =>
  nodeGender === rail || nodeGender === 'unisex';

/** What a rail calls a node — HIM falls back to the shared label when there's no override. */
export const displayLabel = (
  n: { label: string; labelHim?: string | null },
  rail: 'her' | 'him',
): string => (rail === 'him' ? (n.labelHim ?? n.label) : n.label);

/** Rail position — HIM falls back to the shared order when there's no override. */
export const displaySort = (
  n: { sortOrder: number; sortOrderHim?: number | null },
  rail: 'her' | 'him',
): number => (rail === 'him' ? (n.sortOrderHim ?? n.sortOrder) : n.sortOrder);

/**
 * Reconstruct one rail exactly as the consumer app renders it. This is what the app's
 * hardcoded `TAXONOMY` / `HIM_TAXONOMY` arrays used to be, derived instead of duplicated.
 */
export function railFor(rail: 'her' | 'him'): {
  key: string;
  slug: string;
  label: string;
  leaves: { key: string; slug: string; label: string }[];
}[] {
  return TAXONOMY.filter((p) => visibleTo(p.gender, rail))
    .slice()
    .sort((a, b) => displaySort(a, rail) - displaySort(b, rail))
    .map((p) => ({
      key: p.key,
      slug: parentSlug(p),
      label: displayLabel(p, rail),
      leaves: p.leaves
        .filter((l) => visibleTo(l.gender ?? p.gender, rail))
        .slice()
        .sort((a, b) => displaySort(a, rail) - displaySort(b, rail))
        .map((l) => ({ key: l.key, slug: leafSlug(p, l.key), label: l.label })),
    }));
}
