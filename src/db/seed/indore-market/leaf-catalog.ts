/**
 * The coherence source of truth for the Indore market seed.
 *
 * Every fact about a seeded product — its name, gender, size run, price band, brand,
 * colourways, HSN-bearing category and image search query — is read from the spec of
 * the LEAF CATEGORY it sits on. Nothing is picked by a global counter.
 *
 * That is the whole point. `catalog-expand.ts` derives brand from
 * `brandRows[n % brandRows.length]` over an unordered query, which is how the existing
 * catalog ended up with Gucci sherwanis; and it leaves galleries empty for
 * `fix-images.ts` to fill from a pool keyed by taxonomy PARENT, whose lookup drops one
 * trailing slug segment and silently falls back to a generic "apparel" pool. Here a
 * product cannot disagree with itself, because there is only one place its facts live.
 *
 * Specs are merged parent-defaults-then-leaf-override, so the common case is one line
 * per leaf and only genuinely different leaves carry detail.
 */

import { TAXONOMY, leafSlug, type Gender } from '@/shared/catalog/taxonomy.js';

export type SizeKind = 'letter' | 'waist' | 'shoe' | 'one';

export const SIZE_RUNS: Record<SizeKind, string[]> = {
  letter: ['XS', 'S', 'M', 'L', 'XL'],
  waist: ['28', '30', '32', '34', '36'],
  shoe: ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'],
  one: ['Free Size'],
};

export type Colorway = { name: string; hex: string };

/** What a parent contributes to every leaf beneath it unless the leaf overrides it. */
type ParentDefaults = {
  sizeKind: SizeKind;
  priceFrom: number;
  priceTo: number;
  /** Fit/style words. MUST hold >= 4 entries: product k takes qualifiers[k], which is
   *  what guarantees the 3-4 products in a leaf get distinct names. */
  qualifiers: string[];
  /** Fabric/finish words. May be empty (beauty), in which case the name omits the slot. */
  materials: string[];
  colors: Colorway[];
  /** Brand slugs that plausibly sell this kind of thing. Never a global round-robin. */
  brands: string[];
  occasion: string[];
};

type LeafOverride = Partial<ParentDefaults> & {
  /** Singular, hand-written. Never regex de-pluralisation — that is how "Vintage Scarve"
   *  happens. For leaves that name a department rather than a product (Makeup, Skincare)
   *  this is a concrete item sold there. */
  noun: string;
  /** Unsplash search string. Hand-written per leaf; generic ones return lifestyle shots. */
  query: string;
};

export type LeafSpec = ParentDefaults & {
  slug: string;
  parentSlug: string;
  noun: string;
  gender: Gender;
  query: string;
};

// ---------------------------------------------------------------------------
// Brand affinity. Slugs must exist in `brands` — the Indian ones are created by
// the seed (see NEW_BRANDS below); the rest come from consumer-catalog.ts.
// ---------------------------------------------------------------------------
const BASICS = ['zara', 'hm', 'uniqlo'];
const PREMIUM = ['ralph-lauren', 'tommy', 'calvin-klein', 'hugo-boss'];
const LUXURY = ['gucci', 'prada', 'versace', 'burberry'];
const SPORT = ['nike', 'adidas', 'puma', 'under-armour', 'reebok', 'champion'];
const SNEAKER = ['nike', 'adidas', 'converse', 'vans', 'new-balance', 'puma'];
const DENIM_BRANDS = ['levis', 'diesel', 'calvin-klein'];
const OUTER = ['north-face', 'burberry', 'diesel', 'zara'];
const ETHNIC = ['manyavar', 'fabindia', 'biba'];
const LEATHER = ['hidesign', 'tommy', 'calvin-klein'];
const BEAUTY_BRANDS = ['sugar-cosmetics', 'forest-essentials'];
const GROOMING = ['bombay-shaving', 'forest-essentials'];

/** Brands the existing seed does not have. Created idempotently by seed.ts. */
export const NEW_BRANDS = [
  { slug: 'fabindia', name: 'FabIndia', tintColor: '#8B4513', domain: 'fabindia.com' },
  { slug: 'manyavar', name: 'Manyavar', tintColor: '#7B1113', domain: 'manyavar.com' },
  { slug: 'biba', name: 'Biba', tintColor: '#E23744', domain: 'biba.in' },
  { slug: 'hidesign', name: 'Hidesign', tintColor: '#5C3A21', domain: 'hidesign.com' },
  { slug: 'titan', name: 'Titan', tintColor: '#0F2B5B', domain: 'titan.co.in' },
  { slug: 'sugar-cosmetics', name: 'Sugar Cosmetics', tintColor: '#1A1A1A', domain: 'sugarcosmetics.com' },
  { slug: 'forest-essentials', name: 'Forest Essentials', tintColor: '#2E5339', domain: 'forestessentialsindia.com' },
  { slug: 'bombay-shaving', name: 'Bombay Shaving Company', tintColor: '#1C1C1C', domain: 'bombayshavingcompany.com' },
] as const;

// ---------------------------------------------------------------------------
// Colour palettes
// ---------------------------------------------------------------------------
const NEUTRALS: Colorway[] = [
  { name: 'Black', hex: '#151515' },
  { name: 'Ivory', hex: '#F6F2EA' },
  { name: 'Navy', hex: '#1F2A44' },
  { name: 'Olive', hex: '#5A6247' },
  { name: 'Sand', hex: '#D8C3A5' },
];
const BRIGHTS: Colorway[] = [
  { name: 'Blush', hex: '#EBC7C7' },
  { name: 'Rust', hex: '#A6482E' },
  { name: 'Emerald', hex: '#1E6F5C' },
  { name: 'Mustard', hex: '#D4A017' },
  { name: 'Wine', hex: '#6E1B2E' },
];
const INDIGO: Colorway[] = [
  { name: 'Dark Indigo', hex: '#2B3A55' },
  { name: 'Mid Blue', hex: '#4A6FA5' },
  { name: 'Stone Wash', hex: '#8CA3BF' },
  { name: 'Jet Black', hex: '#1A1A1A' },
];
const LEATHER_TONES: Colorway[] = [
  { name: 'Tan', hex: '#B07D50' },
  { name: 'Black', hex: '#151515' },
  { name: 'Cognac', hex: '#8B4513' },
  { name: 'Oxblood', hex: '#5C1A1B' },
];
const METALS: Colorway[] = [
  { name: 'Gold', hex: '#C9A227' },
  { name: 'Silver', hex: '#C0C0C0' },
  { name: 'Rose Gold', hex: '#B76E79' },
  { name: 'Oxidised', hex: '#5A5A5A' },
];
const FESTIVE: Colorway[] = [
  { name: 'Ivory', hex: '#F6F2EA' },
  { name: 'Maroon', hex: '#6E1B2E' },
  { name: 'Royal Blue', hex: '#1F3A93' },
  { name: 'Bottle Green', hex: '#0B5345' },
];
const SHADES: Colorway[] = [
  { name: 'Nude', hex: '#D9A88C' },
  { name: 'Berry', hex: '#8E2A50' },
  { name: 'Coral', hex: '#F07857' },
  { name: 'Classic Red', hex: '#B3121D' },
];

// ---------------------------------------------------------------------------
// Parent defaults. Price bands follow the existing PARENT_PROFILE in
// catalog-expand.ts so the new catalog sits in the same price world as the old.
// Keyed by parent SLUG (gender-prefixed for single-rail parents).
// ---------------------------------------------------------------------------
const PARENTS: Record<string, ParentDefaults> = {
  tops: {
    sizeKind: 'letter',
    priceFrom: 799,
    priceTo: 2499,
    qualifiers: ['Relaxed', 'Classic', 'Slim', 'Oversized', 'Tailored'],
    materials: ['Cotton', 'Linen', 'Poplin', 'Jersey'],
    colors: [...NEUTRALS, ...BRIGHTS.slice(0, 2)],
    brands: [...BASICS, ...PREMIUM],
    occasion: ['brunch', 'office'],
  },
  'her-dresses': {
    sizeKind: 'letter',
    priceFrom: 1499,
    priceTo: 5999,
    qualifiers: ['Flowy', 'Fitted', 'Pleated', 'Wrap', 'Tiered'],
    materials: ['Satin', 'Chiffon', 'Cotton', 'Crepe'],
    colors: [...BRIGHTS, ...NEUTRALS.slice(0, 2)],
    brands: [...BASICS, 'zara', ...LUXURY.slice(0, 2)],
    occasion: ['party', 'date'],
  },
  'her-coords': {
    sizeKind: 'letter',
    priceFrom: 1999,
    priceTo: 4999,
    qualifiers: ['Relaxed', 'Structured', 'Cropped', 'Longline', 'Textured'],
    materials: ['Linen', 'Cotton', 'Rayon', 'Crepe'],
    colors: [...NEUTRALS, ...BRIGHTS.slice(0, 2)],
    brands: [...BASICS, 'biba', 'w'],
    occasion: ['brunch', 'party'],
  },
  bottoms: {
    sizeKind: 'waist',
    priceFrom: 1299,
    priceTo: 3499,
    qualifiers: ['Slim', 'Straight', 'Relaxed', 'High-Rise', 'Tapered'],
    materials: ['Cotton', 'Twill', 'Linen', 'Ponte'],
    colors: NEUTRALS,
    brands: [...BASICS, ...PREMIUM.slice(0, 2)],
    occasion: ['office', 'streetwear'],
  },
  denim: {
    sizeKind: 'waist',
    priceFrom: 1999,
    priceTo: 4999,
    qualifiers: ['Slim', 'Straight', 'Relaxed', 'High-Rise', 'Loose'],
    materials: ['Rigid Denim', 'Stretch Denim', 'Selvedge', 'Washed Denim'],
    colors: INDIGO,
    brands: DENIM_BRANDS,
    occasion: ['streetwear', 'travel'],
  },
  lounge: {
    sizeKind: 'letter',
    priceFrom: 699,
    priceTo: 1999,
    qualifiers: ['Soft', 'Relaxed', 'Everyday', 'Brushed', 'Lightweight'],
    materials: ['Cotton', 'Modal', 'Bamboo', 'Fleece'],
    colors: [...NEUTRALS.slice(0, 3), ...BRIGHTS.slice(0, 2)],
    brands: [...BASICS, 'calvin-klein'],
    occasion: ['travel'],
  },
  active: {
    sizeKind: 'letter',
    priceFrom: 999,
    priceTo: 2999,
    qualifiers: ['Dry-Fit', 'Compression', 'Seamless', 'Lightweight', 'Training'],
    materials: ['Polyester', 'Nylon Blend', 'Mesh', 'Recycled Knit'],
    colors: [...NEUTRALS.slice(0, 3), ...BRIGHTS.slice(0, 2)],
    brands: SPORT,
    occasion: ['gym'],
  },
  swim: {
    sizeKind: 'letter',
    priceFrom: 899,
    priceTo: 2499,
    qualifiers: ['Quick-Dry', 'Ribbed', 'Printed', 'Textured', 'Classic'],
    materials: ['Nylon', 'Recycled Polyester', 'Lycra Blend'],
    colors: [...BRIGHTS.slice(0, 3), ...NEUTRALS.slice(0, 2)],
    brands: [...BASICS, ...SPORT.slice(0, 3)],
    occasion: ['beach'],
  },
  outerwear: {
    sizeKind: 'letter',
    priceFrom: 2499,
    priceTo: 8999,
    qualifiers: ['Padded', 'Lightweight', 'Longline', 'Quilted', 'Structured'],
    materials: ['Nylon', 'Wool Blend', 'Cotton Twill', 'Fleece-Lined'],
    colors: NEUTRALS,
    brands: OUTER,
    occasion: ['travel', 'office'],
  },
  shoes: {
    sizeKind: 'shoe',
    priceFrom: 1499,
    priceTo: 6999,
    qualifiers: ['Low-Top', 'Cushioned', 'Classic', 'Chunky', 'Everyday'],
    materials: ['Leather', 'Canvas', 'Suede', 'Knit'],
    colors: [...NEUTRALS.slice(0, 3), ...LEATHER_TONES.slice(0, 2)],
    brands: SNEAKER,
    occasion: ['streetwear', 'travel'],
  },
  bags: {
    sizeKind: 'one',
    priceFrom: 999,
    priceTo: 5999,
    qualifiers: ['Structured', 'Slouchy', 'Compact', 'Roomy', 'Everyday'],
    materials: ['Pebbled Leather', 'Canvas', 'Vegan Leather', 'Nylon'],
    colors: LEATHER_TONES,
    brands: [...LEATHER, ...BASICS.slice(0, 2)],
    occasion: ['brunch', 'travel'],
  },
  accessories: {
    sizeKind: 'one',
    priceFrom: 499,
    priceTo: 2999,
    qualifiers: ['Classic', 'Minimal', 'Textured', 'Everyday', 'Woven'],
    materials: ['Leather', 'Cotton', 'Acetate', 'Metal'],
    colors: [...NEUTRALS.slice(0, 3), ...LEATHER_TONES.slice(0, 2)],
    brands: [...LEATHER, ...BASICS.slice(0, 2)],
    occasion: ['streetwear'],
  },
  'her-jewelry': {
    sizeKind: 'one',
    priceFrom: 599,
    priceTo: 3999,
    qualifiers: ['Dainty', 'Statement', 'Layered', 'Minimal', 'Hammered'],
    materials: ['Gold-Plated', 'Sterling Silver', 'Rose Gold', 'Oxidised Silver'],
    colors: METALS,
    brands: ['biba', 'w', 'house-of-closetx'],
    occasion: ['party', 'wedding'],
  },
  beauty: {
    sizeKind: 'one',
    priceFrom: 399,
    priceTo: 2499,
    // Beauty has no fabric, so `materials` is empty and the name omits that slot.
    qualifiers: ['Matte', 'Hydrating', 'Long-Wear', 'Velvet', 'Everyday'],
    materials: [],
    colors: SHADES,
    brands: BEAUTY_BRANDS,
    occasion: ['date', 'party'],
  },
  'him-ethnic': {
    sizeKind: 'letter',
    priceFrom: 1999,
    priceTo: 6999,
    qualifiers: ['Straight-Fit', 'Embroidered', 'Handloom', 'Slim-Fit', 'Printed'],
    materials: ['Cotton', 'Silk Blend', 'Linen', 'Chanderi'],
    colors: FESTIVE,
    brands: ETHNIC,
    occasion: ['wedding', 'formal'],
  },
  'him-formal': {
    sizeKind: 'letter',
    priceFrom: 2999,
    priceTo: 9999,
    qualifiers: ['Slim-Fit', 'Regular-Fit', 'Structured', 'Tailored', 'Textured'],
    materials: ['Wool Blend', 'Cotton Poplin', 'Twill', 'Linen Blend'],
    colors: [...NEUTRALS.slice(0, 4), { name: 'Charcoal', hex: '#36454F' }],
    brands: [...PREMIUM, 'manyavar'],
    occasion: ['formal', 'office'],
  },
};

// ---------------------------------------------------------------------------
// Leaf specs, keyed by leaf slug. Only what differs from the parent.
// ---------------------------------------------------------------------------
const LEAVES: Record<string, LeafOverride> = {
  // --- tops -----------------------------------------------------------------
  'tops-tshirts': { noun: 'T-Shirt', query: 'plain cotton t-shirt product' },
  'tops-blouses': { noun: 'Blouse', query: 'womens blouse top' },
  'tops-shirts': { noun: 'Shirt', query: 'button down shirt' },
  'tops-polos': { noun: 'Polo Shirt', query: 'mens polo shirt' },
  'tops-tank-tops': { noun: 'Tank Top', query: 'womens tank top' },
  'tops-camis': { noun: 'Cami', query: 'satin camisole top' },
  'tops-crop-tops': { noun: 'Crop Top', query: 'womens crop top' },
  'tops-bodysuits': { noun: 'Bodysuit', query: 'womens bodysuit top' },
  'tops-vests': { noun: 'Vest', query: 'mens vest tank' },
  'tops-sweatshirts': { noun: 'Sweatshirt', query: 'plain sweatshirt' },
  'tops-hoodies': { noun: 'Hoodie', query: 'hoodie sweatshirt' },
  'tops-sweaters': {
    noun: 'Sweater',
    query: 'knit sweater',
    materials: ['Wool Blend', 'Merino', 'Cotton Knit', 'Cashmere Blend'],
  },
  'tops-cardigans': {
    noun: 'Cardigan',
    query: 'womens cardigan knit',
    materials: ['Wool Blend', 'Cotton Knit', 'Merino', 'Chunky Knit'],
  },

  // --- her-dresses ----------------------------------------------------------
  'her-dresses-mini': { noun: 'Mini Dress', query: 'mini dress' },
  'her-dresses-midi': { noun: 'Midi Dress', query: 'midi dress' },
  'her-dresses-maxi': { noun: 'Maxi Dress', query: 'maxi dress' },
  'her-dresses-bodycon': { noun: 'Bodycon Dress', query: 'bodycon dress' },
  'her-dresses-party': { noun: 'Party Dress', query: 'party dress evening' },
  'her-dresses-casual': { noun: 'Casual Dress', query: 'casual day dress' },

  // --- her-coords -----------------------------------------------------------
  'her-coords-two-piece': { noun: 'Two-Piece Set', query: 'two piece co-ord set women' },
  'her-coords-matching': { noun: 'Matching Set', query: 'matching co-ord set women' },
  'her-coords-skirt-sets': { noun: 'Skirt Set', query: 'skirt and top co-ord set' },
  'her-coords-pant-sets': { noun: 'Pant Set', query: 'pant co-ord set women' },

  // --- bottoms --------------------------------------------------------------
  'bottoms-pants': { noun: 'Pants', sizeKind: 'letter', query: 'womens trousers pants' },
  'bottoms-jeans': { noun: 'Jeans', materials: ['Stretch Denim', 'Rigid Denim'], colors: INDIGO, query: 'mens jeans' },
  'bottoms-trousers': { noun: 'Trousers', query: 'formal trousers' },
  'bottoms-skirts': { noun: 'Skirt', sizeKind: 'letter', query: 'womens skirt' },
  'bottoms-shorts': { noun: 'Shorts', query: 'casual shorts' },
  'bottoms-joggers': { noun: 'Joggers', sizeKind: 'letter', query: 'mens joggers' },
  'bottoms-leggings': { noun: 'Leggings', sizeKind: 'letter', query: 'womens leggings' },
  'bottoms-wide-leg': { noun: 'Wide-Leg Pants', sizeKind: 'letter', query: 'wide leg trousers women' },
  'bottoms-chinos': { noun: 'Chinos', query: 'mens chinos' },
  'bottoms-cargos': { noun: 'Cargo Pants', query: 'cargo pants' },

  // --- denim ----------------------------------------------------------------
  'denim-jeans': { noun: 'Jeans', query: 'blue jeans denim' },
  'denim-skinny': { noun: 'Skinny Jeans', query: 'skinny jeans women' },
  'denim-wide-leg': { noun: 'Wide-Leg Jeans', query: 'wide leg jeans women' },
  'denim-slim': { noun: 'Slim Jeans', query: 'slim fit jeans men' },
  'denim-baggy': { noun: 'Baggy Jeans', query: 'baggy jeans' },
  'denim-jackets': { noun: 'Denim Jacket', sizeKind: 'letter', query: 'denim jacket' },
  'denim-shorts': { noun: 'Denim Shorts', query: 'denim shorts' },

  // --- lounge ---------------------------------------------------------------
  'lounge-pajamas': { noun: 'Pajama Set', query: 'pajama set sleepwear' },
  'lounge-vests': { noun: 'Vest', query: 'mens innerwear vest' },
  'lounge-robes': { noun: 'Robe', query: 'bath robe women' },
  'lounge-boxers': { noun: 'Boxers', query: 'mens boxer shorts underwear' },
  'lounge-bras': { noun: 'Bra', query: 'womens bra lingerie' },
  'lounge-briefs': { noun: 'Briefs', query: 'mens briefs underwear' },
  'lounge-bralettes': { noun: 'Bralette', query: 'bralette bra top women' },
  'lounge-shapewear': { noun: 'Shapewear', query: 'shapewear bodysuit' },
  'lounge-lounge-pants': { noun: 'Lounge Pants', query: 'mens pyjama pants sleepwear' },
  'lounge-sets': { noun: 'Loungewear Set', query: 'loungewear set women' },

  // --- active ---------------------------------------------------------------
  'active-sports-bras': { noun: 'Sports Bra', query: 'sports bra' },
  'active-gym-tees': { noun: 'Gym T-Shirt', query: 'mens gym t-shirt' },
  'active-gym-leggings': { noun: 'Gym Leggings', query: 'gym leggings women' },
  'active-track-pants': { noun: 'Track Pants', query: 'track pants' },
  'active-shorts': { noun: 'Gym Shorts', query: 'mens gym shorts' },
  'active-workout-tops': { noun: 'Workout Top', query: 'womens workout top' },
  'active-tanks': { noun: 'Tank', query: 'mens gym tank top' },
  'active-windbreakers': { noun: 'Windbreaker', query: 'windbreaker jacket' },

  // --- swim -----------------------------------------------------------------
  'swim-bikinis': { noun: 'Bikini', query: 'bikini swimwear' },
  'swim-swim-shorts': { noun: 'Swim Shorts', query: 'mens swim shorts trunks' },
  'swim-one-pieces': { noun: 'One-Piece Swimsuit', query: 'one piece swimsuit' },
  'swim-beach-shirts': { noun: 'Beach Shirt', query: 'mens beach shirt' },
  'swim-cover-ups': { noun: 'Cover-Up', query: 'beach cover up women' },
  'swim-beach-dresses': { noun: 'Beach Dress', query: 'beach dress summer' },

  // --- outerwear ------------------------------------------------------------
  'outerwear-jackets': { noun: 'Jacket', query: 'casual jacket' },
  'outerwear-blazers': { noun: 'Blazer', query: 'womens blazer' },
  'outerwear-coats': { noun: 'Coat', query: 'wool coat' },
  'outerwear-puffers': { noun: 'Puffer Jacket', query: 'puffer jacket' },
  'outerwear-trench': { noun: 'Trench Coat', query: 'trench coat' },
  'outerwear-overshirts': { noun: 'Overshirt', query: 'mens overshirt shacket' },
  'outerwear-bombers': { noun: 'Bomber Jacket', query: 'bomber jacket' },

  // --- shoes ----------------------------------------------------------------
  'shoes-sneakers': { noun: 'Sneakers', query: 'sneakers shoes' },
  'shoes-heels': {
    noun: 'Heels',
    query: 'high heels shoes women',
    brands: ['zara', 'hm', 'gucci', 'prada'],
  },
  'shoes-formal': {
    noun: 'Formal Shoes',
    query: 'mens formal leather shoes',
    brands: ['hidesign', 'ralph-lauren', 'hugo-boss'],
  },
  'shoes-boots': { noun: 'Boots', query: 'leather boots' },
  'shoes-flats': { noun: 'Flats', query: 'ballet flats shoes women', brands: ['zara', 'hm', 'hidesign'] },
  'shoes-sandals': { noun: 'Sandals', query: 'sandals footwear' },
  'shoes-loafers': { noun: 'Loafers', query: 'loafers shoes' },

  // --- bags -----------------------------------------------------------------
  'bags-totes': { noun: 'Tote Bag', query: 'tote bag' },
  'bags-backpacks': { noun: 'Backpack', query: 'backpack bag' },
  'bags-crossbody': { noun: 'Crossbody Bag', query: 'crossbody bag women' },
  'bags-duffles': { noun: 'Duffle Bag', query: 'duffle bag travel' },
  'bags-shoulder': { noun: 'Shoulder Bag', query: 'shoulder bag women' },
  'bags-slings': { noun: 'Sling Bag', query: 'sling bag crossbody men' },
  'bags-clutches': { noun: 'Clutch', query: 'clutch bag evening' },
  'bags-laptop': { noun: 'Laptop Bag', query: 'laptop bag briefcase' },
  'bags-mini': { noun: 'Mini Bag', query: 'mini handbag' },

  // --- accessories ----------------------------------------------------------
  'accessories-belts': { noun: 'Belt', sizeKind: 'waist', query: 'leather belt' },
  'accessories-hats': { noun: 'Hat', query: 'womens hat' },
  'accessories-caps': { noun: 'Cap', query: 'baseball cap' },
  'accessories-sunglasses': {
    noun: 'Sunglasses',
    query: 'sunglasses',
    materials: ['Acetate', 'Metal', 'Polarised'],
  },
  'accessories-watches': {
    noun: 'Watch',
    query: 'wrist watch',
    materials: ['Stainless Steel', 'Leather Strap', 'Mesh'],
    brands: ['titan', 'tommy', 'calvin-klein'],
  },
  'accessories-scarves': {
    noun: 'Scarf',
    query: 'scarf womens',
    materials: ['Silk', 'Wool Blend', 'Cotton', 'Modal'],
  },
  'accessories-wallets': { noun: 'Wallet', query: 'leather wallet' },
  'accessories-hair': {
    noun: 'Hair Clip',
    query: 'hair accessories clips',
    materials: ['Resin', 'Metal', 'Fabric'],
  },
  'accessories-socks': {
    noun: 'Socks',
    query: 'socks pair',
    materials: ['Cotton', 'Bamboo', 'Wool Blend'],
    brands: [...BASICS, 'nike', 'puma'],
  },
  'accessories-tights': {
    noun: 'Tights',
    sizeKind: 'letter',
    query: 'womens tights hosiery',
    materials: ['Nylon', 'Opaque Knit', 'Sheer'],
  },

  // --- her-jewelry ----------------------------------------------------------
  'her-jewelry-earrings': { noun: 'Earrings', query: 'earrings jewelry' },
  'her-jewelry-necklaces': { noun: 'Necklace', query: 'necklace jewelry' },
  'her-jewelry-rings': { noun: 'Ring', query: 'ring jewelry' },
  'her-jewelry-bracelets': { noun: 'Bracelet', query: 'bracelet jewelry' },
  'her-jewelry-anklets': { noun: 'Anklet', query: 'anklet jewelry' },

  // --- beauty ---------------------------------------------------------------
  'beauty-makeup': { noun: 'Lipstick', query: 'lipstick makeup product' },
  'beauty-fragrance': {
    noun: 'Eau de Parfum',
    query: 'perfume bottle',
    qualifiers: ['Woody', 'Citrus', 'Floral', 'Amber', 'Fresh'],
    colors: [{ name: '50 ml', hex: '#C9A227' }, { name: '100 ml', hex: '#8B7355' }],
  },
  'beauty-beard': {
    noun: 'Beard Oil',
    query: 'beard oil grooming product',
    qualifiers: ['Nourishing', 'Softening', 'Everyday', 'Sandalwood'],
    colors: [{ name: '30 ml', hex: '#5C3A21' }, { name: '50 ml', hex: '#3E2723' }],
    brands: GROOMING,
  },
  'beauty-skincare': {
    noun: 'Face Serum',
    query: 'skincare serum bottle',
    qualifiers: ['Hydrating', 'Brightening', 'Soothing', 'Everyday'],
    colors: [{ name: '30 ml', hex: '#2E5339' }, { name: '50 ml', hex: '#7A9E7E' }],
  },
  'beauty-nails': {
    noun: 'Nail Polish',
    query: 'nail polish bottle',
    qualifiers: ['Glossy', 'Matte', 'Quick-Dry', 'Sheer'],
  },
  'beauty-hair': {
    noun: 'Hair Pomade',
    query: 'hair styling product men',
    qualifiers: ['Strong-Hold', 'Matte', 'Light-Hold', 'Everyday'],
    colors: [{ name: '50 g', hex: '#1C1C1C' }, { name: '100 g', hex: '#4A4A4A' }],
    brands: GROOMING,
  },

  // --- him-ethnic -----------------------------------------------------------
  'him-ethnic-kurtas': { noun: 'Kurta', query: 'mens kurta ethnic wear india' },
  'him-ethnic-kurta-sets': { noun: 'Kurta Set', query: 'mens kurta pyjama set india' },
  'him-ethnic-nehru-jackets': { noun: 'Nehru Jacket', query: 'nehru jacket mens india' },
  'him-ethnic-sherwanis': {
    noun: 'Sherwani',
    priceFrom: 8999,
    priceTo: 24999,
    query: 'sherwani groom indian wedding',
    brands: ['manyavar', 'fabindia'],
  },
  'him-ethnic-pathani': { noun: 'Pathani Suit', query: 'pathani suit mens' },

  // --- him-formal -----------------------------------------------------------
  'him-formal-blazers': { noun: 'Blazer', query: 'mens blazer suit jacket' },
  'him-formal-suits': { noun: 'Suit', priceFrom: 8999, priceTo: 19999, query: 'mens two piece suit' },
  'him-formal-shirts': { noun: 'Formal Shirt', priceFrom: 1299, priceTo: 3499, query: 'mens formal shirt' },
  'him-formal-trousers': { noun: 'Formal Trousers', sizeKind: 'waist', query: 'mens formal trousers' },
  'him-formal-waistcoats': { noun: 'Waistcoat', query: 'mens waistcoat vest formal' },
};

/**
 * All 118 leaves, resolved parent-defaults-then-override, in taxonomy declaration
 * order. Order is load-bearing: the distribution in seed.ts indexes this array.
 */
export const LEAF_SPECS: LeafSpec[] = TAXONOMY.flatMap((parent) => {
  const pSlug = parent.gender === 'unisex' ? parent.key : `${parent.gender}-${parent.key}`;
  const defaults = PARENTS[pSlug];
  if (!defaults) throw new Error(`No parent defaults for "${pSlug}"`);

  return parent.leaves.map((leaf): LeafSpec => {
    const slug = leafSlug(parent, leaf.key);
    const override = LEAVES[slug];
    if (!override) throw new Error(`No leaf spec for "${slug}"`);
    return {
      ...defaults,
      ...override,
      slug,
      parentSlug: pSlug,
      // Leaf gender falls back to the parent's, exactly as category-taxonomy.ts seeds it.
      gender: leaf.gender ?? parent.gender,
    };
  });
});

/** Name for product `k` of a leaf. Distinct qualifiers per k keep names unique. */
export function productName(spec: LeafSpec, k: number): string {
  const qualifier = spec.qualifiers[k % spec.qualifiers.length]!;
  const material = spec.materials.length
    ? spec.materials[(k * 2) % spec.materials.length]!
    : null;
  return [qualifier, material, spec.noun].filter(Boolean).join(' ');
}

/** Straight-line price across the leaf's band, so the 3-4 products differ sensibly. */
export function productPrice(spec: LeafSpec, k: number, count: number): number {
  if (count <= 1) return spec.priceFrom;
  return (
    spec.priceFrom + Math.round(((spec.priceTo - spec.priceFrom) * k) / (count - 1))
  );
}

/** Two colourways per product, offset by k so a leaf's products are not identical. */
export function productColors(spec: LeafSpec, k: number): Colorway[] {
  const n = spec.colors.length;
  return [spec.colors[(k * 2) % n]!, spec.colors[(k * 2 + 1) % n]!];
}

if (LEAF_SPECS.length !== 118) {
  throw new Error(`Expected 118 leaf specs, built ${LEAF_SPECS.length}`);
}
