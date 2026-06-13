/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Consumer catalog seed — rich browse data for the consumer app: 24 real brands,
 * image-bearing categories (8 HER + 8 HIM + 3 unisex), ~66 product listings with
 * color/size variants, and outfit/occasion/drop collections.
 *
 * Idempotent: brands/categories skip-or-backfill by slug; the listings + collections
 * block is skipped entirely when the sentinel collection 'her-brunch-goddess' exists.
 *
 * Run standalone: npx tsx src/db/seed/consumer-catalog.ts
 * Or via orchestrator: npm run db:seed
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import type { db as Db } from '@/db/client.js';
import {
  brands,
  categories,
  collectionListings,
  collections,
  productListings,
  retailerStores,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const SENTINEL_COLLECTION_SLUG = 'her-brunch-goddess';

// Same image sources the app's mock data uses — known-good hotlinks.
const u = (id: string, w = 600) =>
  `https://images.unsplash.com/${id}?w=${w}&q=80&auto=format&fit=crop`;
const png = (cat: string, n: number | string) =>
  `https://pngimg.com/uploads/${cat}/${cat}_PNG${n}.png`;

function paise(rupees: number): number {
  return Math.round(rupees * 100);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** "S,M,L" → size rows with deterministic stock variation. */
function sz(names: string, stock = 12): { size: string; stock: number }[] {
  return names.split(',').map((s, i) => ({ size: s.trim(), stock: stock + ((i * 3) % 7) }));
}

// ── Brands ────────────────────────────────────────────────────────────────────

const wm = (path: string) => `https://upload.wikimedia.org/wikipedia/commons/thumb/${path}`;

type BrandSpec = { slug: string; name: string; tint: string; logo: string; domain: string };
const BRAND_SPECS: BrandSpec[] = [
  { slug: 'nike', name: 'Nike', tint: '#111111', logo: wm('a/a6/Logo_NIKE.svg/500px-Logo_NIKE.svg.png'), domain: 'nike.com' },
  { slug: 'adidas', name: 'Adidas', tint: '#000000', logo: wm('2/20/Adidas_Logo.svg/500px-Adidas_Logo.svg.png'), domain: 'adidas.com' },
  { slug: 'zara', name: 'Zara', tint: '#1a1a1a', logo: wm('f/fd/Zara_Logo.svg/500px-Zara_Logo.svg.png'), domain: 'zara.com' },
  { slug: 'hm', name: 'H&M', tint: '#e50010', logo: wm('5/53/H%26M-Logo.svg/500px-H%26M-Logo.svg.png'), domain: 'hm.com' },
  { slug: 'uniqlo', name: 'Uniqlo', tint: '#ff0000', logo: wm('9/92/UNIQLO_logo.svg/500px-UNIQLO_logo.svg.png'), domain: 'uniqlo.com' },
  { slug: 'puma', name: 'Puma', tint: '#000000', logo: wm('a/ae/Puma-logo-%28text%29.svg/500px-Puma-logo-%28text%29.svg.png'), domain: 'puma.com' },
  { slug: 'gucci', name: 'Gucci', tint: '#1a1a1a', logo: wm('7/79/1960s_Gucci_Logo.svg/500px-1960s_Gucci_Logo.svg.png'), domain: 'gucci.com' },
  { slug: 'levis', name: "Levi's", tint: '#c41230', logo: wm('7/75/Levi%27s_logo.svg/500px-Levi%27s_logo.svg.png'), domain: 'levi.com' },
  { slug: 'calvin-klein', name: 'Calvin Klein', tint: '#000000', logo: wm('e/e2/Calvin_klein_logo.svg/500px-Calvin_klein_logo.svg.png'), domain: 'calvinklein.com' },
  { slug: 'tommy', name: 'Tommy Hilfiger', tint: '#002d72', logo: wm('9/9d/Tommy_Hilfiger_logo.svg/500px-Tommy_Hilfiger_logo.svg.png'), domain: 'tommy.com' },
  { slug: 'ralph-lauren', name: 'Ralph Lauren', tint: '#1a1a1a', logo: wm('7/72/Ralph_Lauren_logo.svg/500px-Ralph_Lauren_logo.svg.png'), domain: 'ralphlauren.com' },
  { slug: 'new-balance', name: 'New Balance', tint: '#cf0a2c', logo: wm('e/ea/New_Balance_logo.svg/500px-New_Balance_logo.svg.png'), domain: 'newbalance.com' },
  { slug: 'fila', name: 'Fila', tint: '#c81533', logo: wm('7/7f/Fila_logo.svg/500px-Fila_logo.svg.png'), domain: 'fila.com' },
  { slug: 'reebok', name: 'Reebok', tint: '#e41837', logo: wm('5/53/Reebok_2019_logo.svg/500px-Reebok_2019_logo.svg.png'), domain: 'reebok.com' },
  { slug: 'converse', name: 'Converse', tint: '#000000', logo: wm('3/30/Converse_logo.svg/500px-Converse_logo.svg.png'), domain: 'converse.com' },
  { slug: 'vans', name: 'Vans', tint: '#c3002f', logo: wm('9/91/Vans-logo.svg/500px-Vans-logo.svg.png'), domain: 'vans.com' },
  { slug: 'under-armour', name: 'Under Armour', tint: '#000000', logo: wm('4/44/Under_armour_logo.svg/500px-Under_armour_logo.svg.png'), domain: 'underarmour.com' },
  { slug: 'diesel', name: 'Diesel', tint: '#000000', logo: wm('a/a1/Diesel_logo.svg/500px-Diesel_logo.svg.png'), domain: 'diesel.com' },
  { slug: 'hugo-boss', name: 'Hugo Boss', tint: '#000000', logo: wm('7/73/Hugo-Boss-Logo.svg/500px-Hugo-Boss-Logo.svg.png'), domain: 'hugoboss.com' },
  { slug: 'versace', name: 'Versace', tint: '#000000', logo: wm('4/4c/Versace_old_logo.svg/500px-Versace_old_logo.svg.png'), domain: 'versace.com' },
  { slug: 'prada', name: 'Prada', tint: '#000000', logo: wm('b/b8/Prada-Logo.svg/500px-Prada-Logo.svg.png'), domain: 'prada.com' },
  { slug: 'champion', name: 'Champion', tint: '#002d72', logo: wm('6/6f/Champion_USA_logo.svg/500px-Champion_USA_logo.svg.png'), domain: 'champion.com' },
  { slug: 'burberry', name: 'Burberry', tint: '#1a1a1a', logo: wm('d/df/Burberry_Logo.svg/500px-Burberry_Logo.svg.png'), domain: 'burberry.com' },
  { slug: 'north-face', name: 'The North Face', tint: '#000000', logo: wm('8/89/TheNorthFace_logo.svg/500px-TheNorthFace_logo.svg.png'), domain: 'thenorthface.com' },
];

// ── Categories ────────────────────────────────────────────────────────────────

type CategorySpec = {
  slug: string;
  label: string;
  gender: 'her' | 'him' | 'unisex';
  iconName: string;
  tintColor: string;
  imageUrl: string;
  sortOrder: number;
};

const CATEGORY_SPECS: CategorySpec[] = [
  // Unisex (existing — backfilled)
  { slug: 'apparel', label: 'Apparel', gender: 'unisex', iconName: 'shirt-outline', tintColor: '#FFE66D', imageUrl: png('tshirt', 5452), sortOrder: 10 },
  { slug: 'footwear', label: 'Footwear', gender: 'unisex', iconName: 'footsteps-outline', tintColor: '#4ECDC4', imageUrl: png('women_shoes', 7472), sortOrder: 20 },
  { slug: 'accessories', label: 'Accessories', gender: 'unisex', iconName: 'glasses-outline', tintColor: '#A78BFA', imageUrl: png('women_bag', 6427), sortOrder: 30 },
  // HER (first 3 existing — backfilled; rest new)
  { slug: 'her-tops', label: 'Tops', gender: 'her', iconName: 'shirt-outline', tintColor: '#A78BFA', imageUrl: png('tshirt', 5452), sortOrder: 100 },
  { slug: 'her-dresses', label: 'Dresses', gender: 'her', iconName: 'woman-outline', tintColor: '#FFAFBD', imageUrl: png('dress', 197), sortOrder: 110 },
  { slug: 'her-bottoms', label: 'Bottoms', gender: 'her', iconName: 'walk-outline', tintColor: '#FECA57', imageUrl: png('jeans', 5778), sortOrder: 120 },
  { slug: 'her-heels', label: 'Heels', gender: 'her', iconName: 'trending-up-outline', tintColor: '#A8E6CF', imageUrl: png('women_shoes', 7473), sortOrder: 130 },
  { slug: 'her-bags', label: 'Bags', gender: 'her', iconName: 'bag-handle-outline', tintColor: '#5D4037', imageUrl: png('women_bag', 6428), sortOrder: 140 },
  { slug: 'her-beauty', label: 'Beauty', gender: 'her', iconName: 'color-palette-outline', tintColor: '#FF6B9D', imageUrl: png('lipstick', 76278), sortOrder: 150 },
  { slug: 'her-coats', label: 'Coats', gender: 'her', iconName: 'cloud-outline', tintColor: '#F5E6D3', imageUrl: png('coat', 79), sortOrder: 160 },
  { slug: 'her-maxi', label: 'Maxi', gender: 'her', iconName: 'flower-outline', tintColor: '#FFC3A0', imageUrl: png('dress', 196), sortOrder: 170 },
  // HIM (first 3 existing — backfilled; rest new)
  { slug: 'him-shirts', label: 'Shirts', gender: 'him', iconName: 'shirt-outline', tintColor: '#2C3E50', imageUrl: png('tshirt', 5453), sortOrder: 200 },
  { slug: 'him-tshirts', label: 'Tees', gender: 'him', iconName: 'shirt-outline', tintColor: '#1A1A1A', imageUrl: png('tshirt', 5454), sortOrder: 210 },
  { slug: 'him-bottoms', label: 'Jeans', gender: 'him', iconName: 'walk-outline', tintColor: '#3A3A3A', imageUrl: png('jeans', 5779), sortOrder: 220 },
  { slug: 'him-jackets', label: 'Jackets', gender: 'him', iconName: 'shield-outline', tintColor: '#111111', imageUrl: png('jacket', 8059), sortOrder: 230 },
  { slug: 'him-sneakers', label: 'Sneakers', gender: 'him', iconName: 'footsteps-outline', tintColor: '#FFFFFF', imageUrl: png('women_shoes', 7472), sortOrder: 240 },
  { slug: 'him-watches', label: 'Watches', gender: 'him', iconName: 'time-outline', tintColor: '#2C3E50', imageUrl: png('watches', 101457), sortOrder: 250 },
  { slug: 'him-coats', label: 'Coats', gender: 'him', iconName: 'cloud-outline', tintColor: '#5D4037', imageUrl: png('coat', 80), sortOrder: 260 },
  { slug: 'him-eyewear', label: 'Shades', gender: 'him', iconName: 'glasses-outline', tintColor: '#3E2723', imageUrl: png('sunglasses', 155), sortOrder: 270 },
];

// ── Products ──────────────────────────────────────────────────────────────────

type ColorSpec = {
  name: string;
  hex: string;
  img: string;
  sizes: { size: string; stock: number }[];
  priceRs: number;
  compareRs?: number;
};

type ProductSpec = {
  name: string;
  gender: 'her' | 'him' | 'unisex';
  cat: string; // category slug
  brand: string; // brand slug
  occ: string[];
  rating: string; // numeric(3,2) — string
  ratingCount: number;
  gallery: string[];
  colors: ColorSpec[];
};

const ONE_SIZE = [{ size: 'One Size', stock: 25 }];
const SHOE_RUN = sz('UK 6,UK 7,UK 8,UK 9,UK 10', 8);

const PRODUCT_SPECS: ProductSpec[] = [
  // ═══ HER — Dresses (5) ═══
  { name: 'Silk Slip Dress', gender: 'her', cat: 'her-dresses', brand: 'zara', occ: ['party', 'date'], rating: '4.70', ratingCount: 412, gallery: [u('photo-1539109136881-3be0616acf4b')], colors: [{ name: 'Blush', hex: '#ffafbd', img: png('dress', 197), sizes: sz('XS,S,M,L'), priceRs: 2799, compareRs: 3999 }] },
  { name: 'Floral Maxi Dress', gender: 'her', cat: 'her-dresses', brand: 'hm', occ: ['brunch', 'beach'], rating: '4.80', ratingCount: 633, gallery: [u('photo-1496747611176-843222e1e57c')], colors: [{ name: 'Coral', hex: '#ff6b9d', img: png('dress', 196), sizes: sz('S,M,L,XL'), priceRs: 3299, compareRs: 4499 }] },
  { name: 'Elegant Mini Dress', gender: 'her', cat: 'her-dresses', brand: 'zara', occ: ['party', 'date'], rating: '4.50', ratingCount: 287, gallery: [u('photo-1483985988355-763728e1935b')], colors: [{ name: 'Champagne', hex: '#f5e6d3', img: png('dress', 194), sizes: sz('XS,S,M'), priceRs: 1799, compareRs: 2499 }] },
  { name: 'Satin Wrap Dress', gender: 'her', cat: 'her-dresses', brand: 'versace', occ: ['wedding', 'party'], rating: '4.90', ratingCount: 198, gallery: [u('photo-1469334031218-e382a71b716b')], colors: [{ name: 'Emerald', hex: '#10B981', img: png('dress', 197), sizes: sz('S,M,L'), priceRs: 6999, compareRs: 9499 }] },
  { name: 'Pleated Midi Dress', gender: 'her', cat: 'her-dresses', brand: 'uniqlo', occ: ['brunch'], rating: '4.40', ratingCount: 351, gallery: [u('photo-1485518882345-15568b007407')], colors: [{ name: 'Sage', hex: '#a8e6cf', img: png('dress', 196), sizes: sz('S,M,L,XL'), priceRs: 2199, compareRs: 2999 }] },

  // ═══ HER — Maxi (3) ═══
  { name: 'Boho Maxi Dress', gender: 'her', cat: 'her-maxi', brand: 'hm', occ: ['beach', 'brunch'], rating: '4.60', ratingCount: 274, gallery: [u('photo-1583496661160-fb5886a0aaaa')], colors: [{ name: 'Terracotta', hex: '#c9a87c', img: png('dress', 196), sizes: sz('S,M,L'), priceRs: 2899, compareRs: 3799 }] },
  { name: 'Sunset Tiered Maxi', gender: 'her', cat: 'her-maxi', brand: 'zara', occ: ['beach'], rating: '4.50', ratingCount: 166, gallery: [u('photo-1583496661160-fb5886a0aaaa')], colors: [{ name: 'Amber', hex: '#feca57', img: png('dress', 194), sizes: sz('XS,S,M,L'), priceRs: 3499, compareRs: 4299 }] },
  { name: 'Cotton Slub Maxi', gender: 'her', cat: 'her-maxi', brand: 'uniqlo', occ: ['brunch'], rating: '4.30', ratingCount: 142, gallery: [u('photo-1496747611176-843222e1e57c')], colors: [{ name: 'Ivory', hex: '#fff5e1', img: png('dress', 197), sizes: sz('S,M,L,XL'), priceRs: 1999, compareRs: 2599 }] },

  // ═══ HER — Tops (4) ═══
  { name: 'Crop Top', gender: 'her', cat: 'her-tops', brand: 'hm', occ: ['party'], rating: '4.70', ratingCount: 524, gallery: [u('photo-1485518882345-15568b007407')], colors: [{ name: 'Pink', hex: '#ff6b9d', img: png('tshirt', 5453), sizes: sz('XS,S,M,L'), priceRs: 1599, compareRs: 2199 }] },
  { name: 'Silk Camisole', gender: 'her', cat: 'her-tops', brand: 'zara', occ: ['date'], rating: '4.60', ratingCount: 233, gallery: [u('photo-1539109136881-3be0616acf4b')], colors: [{ name: 'Pearl', hex: '#f3f3f3', img: png('tshirt', 5452), sizes: sz('XS,S,M'), priceRs: 1899, compareRs: 2499 }] },
  { name: 'Ribbed Knit Top', gender: 'her', cat: 'her-tops', brand: 'uniqlo', occ: ['brunch'], rating: '4.50', ratingCount: 389, gallery: [u('photo-1496747611176-843222e1e57c')], colors: [{ name: 'Butter', hex: '#FFE66D', img: png('tshirt', 5453), sizes: sz('S,M,L,XL'), priceRs: 999, compareRs: 1499 }, { name: 'Lilac', hex: '#a78bfa', img: png('tshirt', 5452), sizes: sz('S,M,L'), priceRs: 999, compareRs: 1499 }] },
  { name: 'Off-Shoulder Blouse', gender: 'her', cat: 'her-tops', brand: 'zara', occ: ['date', 'party'], rating: '4.40', ratingCount: 178, gallery: [u('photo-1503342217505-b0a15ec3261c')], colors: [{ name: 'White', hex: '#ffffff', img: png('tshirt', 5452), sizes: sz('S,M,L'), priceRs: 1699, compareRs: 2299 }] },

  // ═══ HER — Bottoms (3) ═══
  { name: 'High-Waist Skinny Jeans', gender: 'her', cat: 'her-bottoms', brand: 'levis', occ: ['brunch'], rating: '4.60', ratingCount: 702, gallery: [u('photo-1542272604-787c3835535d')], colors: [{ name: 'Indigo', hex: '#2980b9', img: png('jeans', 5778), sizes: sz('26,28,30,32'), priceRs: 2499, compareRs: 3599 }] },
  { name: 'Pleated Mini Skirt', gender: 'her', cat: 'her-bottoms', brand: 'hm', occ: ['party'], rating: '4.30', ratingCount: 211, gallery: [u('photo-1503342217505-b0a15ec3261c')], colors: [{ name: 'Black', hex: '#1a1a1a', img: png('jeans', 5779), sizes: sz('XS,S,M,L'), priceRs: 1299, compareRs: 1799 }] },
  { name: 'Wide-Leg Trousers', gender: 'her', cat: 'her-bottoms', brand: 'calvin-klein', occ: ['brunch'], rating: '4.70', ratingCount: 318, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'Camel', hex: '#c9a87c', img: png('jeans', 5778), sizes: sz('S,M,L'), priceRs: 3299, compareRs: 4199 }] },

  // ═══ HER — Heels (3) ═══
  { name: 'Block Heels', gender: 'her', cat: 'her-heels', brand: 'zara', occ: ['party', 'wedding'], rating: '4.60', ratingCount: 445, gallery: [u('photo-1483985988355-763728e1935b')], colors: [{ name: 'Mint', hex: '#a8e6cf', img: png('women_shoes', 7473), sizes: SHOE_RUN, priceRs: 3199, compareRs: 4299 }] },
  { name: 'Strappy Stilettos', gender: 'her', cat: 'her-heels', brand: 'versace', occ: ['party', 'date'], rating: '4.80', ratingCount: 167, gallery: [u('photo-1539109136881-3be0616acf4b')], colors: [{ name: 'Gold', hex: '#feca57', img: png('women_shoes', 7473), sizes: sz('UK 5,UK 6,UK 7,UK 8', 6), priceRs: 7499, compareRs: 9999 }] },
  { name: 'Nude Pumps', gender: 'her', cat: 'her-heels', brand: 'prada', occ: ['wedding'], rating: '4.70', ratingCount: 209, gallery: [u('photo-1469334031218-e382a71b716b')], colors: [{ name: 'Nude', hex: '#ffc3a0', img: png('women_shoes', 7473), sizes: sz('UK 5,UK 6,UK 7', 7), priceRs: 8999, compareRs: 11999 }] },

  // ═══ HER — Bags (3) ═══
  { name: 'Designer Tote', gender: 'her', cat: 'her-bags', brand: 'gucci', occ: ['brunch'], rating: '4.90', ratingCount: 521, gallery: [u('photo-1483985988355-763728e1935b')], colors: [{ name: 'Cognac', hex: '#5d4037', img: png('women_bag', 6428), sizes: ONE_SIZE, priceRs: 4299, compareRs: 5499 }] },
  { name: 'Quilted Shoulder Bag', gender: 'her', cat: 'her-bags', brand: 'prada', occ: ['party', 'date'], rating: '4.80', ratingCount: 296, gallery: [u('photo-1503342217505-b0a15ec3261c')], colors: [{ name: 'Black', hex: '#1a1a1a', img: png('women_bag', 6427), sizes: ONE_SIZE, priceRs: 6499, compareRs: 8499 }] },
  { name: 'Mini Crossbody', gender: 'her', cat: 'her-bags', brand: 'hm', occ: ['brunch', 'beach'], rating: '4.40', ratingCount: 374, gallery: [u('photo-1496747611176-843222e1e57c')], colors: [{ name: 'Blush', hex: '#ffafbd', img: png('women_bag', 6428), sizes: ONE_SIZE, priceRs: 1499, compareRs: 1999 }] },

  // ═══ HER — Beauty (2) ═══
  { name: 'Velvet Matte Lipstick', gender: 'her', cat: 'her-beauty', brand: 'gucci', occ: ['party', 'date'], rating: '4.80', ratingCount: 812, gallery: [u('photo-1581044777550-4cfa60707c03')], colors: [{ name: 'Ruby', hex: '#c41230', img: png('lipstick', 76278), sizes: ONE_SIZE, priceRs: 899, compareRs: 1499 }] },
  { name: 'Rose Glow Palette', gender: 'her', cat: 'her-beauty', brand: 'versace', occ: ['wedding'], rating: '4.60', ratingCount: 433, gallery: [u('photo-1581044777550-4cfa60707c03')], colors: [{ name: 'Rose', hex: '#ff6b9d', img: png('lipstick', 76278), sizes: ONE_SIZE, priceRs: 1799, compareRs: 2399 }] },

  // ═══ HER — Coats (3) ═══
  { name: 'Oversized Wool Coat', gender: 'her', cat: 'her-coats', brand: 'burberry', occ: ['brunch'], rating: '4.80', ratingCount: 384, gallery: [u('photo-1539109136881-3be0616acf4b')], colors: [{ name: 'Oat', hex: '#f5e6d3', img: png('coat', 79), sizes: sz('S,M,L'), priceRs: 7499, compareRs: 9999 }] },
  { name: 'Belted Trench Coat', gender: 'her', cat: 'her-coats', brand: 'burberry', occ: ['brunch'], rating: '4.90', ratingCount: 256, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'Khaki', hex: '#c9a87c', img: png('coat', 80), sizes: sz('S,M,L,XL'), priceRs: 8499, compareRs: 10999 }] },
  { name: 'Faux Fur Coat', gender: 'her', cat: 'her-coats', brand: 'prada', occ: ['party'], rating: '4.50', ratingCount: 148, gallery: [u('photo-1485518882345-15568b007407')], colors: [{ name: 'Mocha', hex: '#8d6e63', img: png('coat', 79), sizes: sz('S,M,L'), priceRs: 5999, compareRs: 7999 }] },

  // ═══ HIM — Shirts (4) ═══
  { name: 'Slim Fit Oxford Shirt', gender: 'him', cat: 'him-shirts', brand: 'ralph-lauren', occ: ['office', 'formal'], rating: '4.70', ratingCount: 689, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'White', hex: '#ffffff', img: png('tshirt', 5453), sizes: sz('S,M,L,XL'), priceRs: 2499, compareRs: 3299 }, { name: 'Light Blue', hex: '#c5cae9', img: png('tshirt', 5452), sizes: sz('M,L,XL'), priceRs: 2499, compareRs: 3299 }] },
  { name: 'Linen Summer Shirt', gender: 'him', cat: 'him-shirts', brand: 'zara', occ: ['travel'], rating: '4.50', ratingCount: 312, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Ecru', hex: '#fff5e1', img: png('tshirt', 5453), sizes: sz('M,L,XL'), priceRs: 1799, compareRs: 2399 }] },
  { name: 'Flannel Check Shirt', gender: 'him', cat: 'him-shirts', brand: 'tommy', occ: ['streetwear'], rating: '4.40', ratingCount: 257, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'Red Check', hex: '#c41230', img: png('tshirt', 5454), sizes: sz('S,M,L,XL'), priceRs: 2199, compareRs: 2899 }] },
  { name: 'Black Dress Shirt', gender: 'him', cat: 'him-shirts', brand: 'hugo-boss', occ: ['formal'], rating: '4.80', ratingCount: 195, gallery: [u('photo-1507003211169-0a1dd7228f2d')], colors: [{ name: 'Black', hex: '#1a1a1a', img: png('tshirt', 5454), sizes: sz('S,M,L,XL'), priceRs: 3999, compareRs: 5299 }] },

  // ═══ HIM — Tees (4) ═══
  { name: 'Graphic Oversized Tee', gender: 'him', cat: 'him-tshirts', brand: 'nike', occ: ['streetwear'], rating: '4.50', ratingCount: 845, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'Vintage Wash', hex: '#3a3a3a', img: png('tshirt', 5454), sizes: sz('S,M,L,XL', 20), priceRs: 1299, compareRs: 1999 }] },
  { name: 'Essential Crew Tee', gender: 'him', cat: 'him-tshirts', brand: 'uniqlo', occ: ['travel'], rating: '4.60', ratingCount: 1023, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'White', hex: '#ffffff', img: png('tshirt', 5452), sizes: sz('S,M,L,XL', 25), priceRs: 699, compareRs: 999 }, { name: 'Black', hex: '#111111', img: png('tshirt', 5454), sizes: sz('S,M,L,XL', 25), priceRs: 699, compareRs: 999 }] },
  { name: 'Classic Polo Shirt', gender: 'him', cat: 'him-tshirts', brand: 'ralph-lauren', occ: ['office'], rating: '4.70', ratingCount: 534, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'Navy', hex: '#2c3e50', img: png('tshirt', 5453), sizes: sz('S,M,L,XL'), priceRs: 1899, compareRs: 2599 }] },
  { name: 'Dry-Fit Training Tee', gender: 'him', cat: 'him-tshirts', brand: 'under-armour', occ: ['gym'], rating: '4.60', ratingCount: 718, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Charcoal', hex: '#3a3a3a', img: png('tshirt', 5454), sizes: sz('S,M,L,XL', 18), priceRs: 1199, compareRs: 1699 }] },

  // ═══ HIM — Jeans/Bottoms (4) ═══
  { name: 'Slim Wash Denim', gender: 'him', cat: 'him-bottoms', brand: 'levis', occ: ['streetwear'], rating: '4.60', ratingCount: 922, gallery: [u('photo-1542272604-787c3835535d')], colors: [{ name: 'Mid Wash', hex: '#2980b9', img: png('jeans', 5779), sizes: sz('30,32,34,36'), priceRs: 1899, compareRs: 2999 }] },
  { name: 'Cargo Joggers', gender: 'him', cat: 'him-bottoms', brand: 'puma', occ: ['gym', 'streetwear'], rating: '4.40', ratingCount: 463, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Olive', hex: '#5d6e3a', img: png('jeans', 5778), sizes: sz('S,M,L,XL', 15), priceRs: 1599, compareRs: 2199 }] },
  { name: 'Tailored Chinos', gender: 'him', cat: 'him-bottoms', brand: 'tommy', occ: ['office'], rating: '4.70', ratingCount: 387, gallery: [u('photo-1507003211169-0a1dd7228f2d')], colors: [{ name: 'Stone', hex: '#c9a87c', img: png('jeans', 5778), sizes: sz('30,32,34,36'), priceRs: 2299, compareRs: 2999 }] },
  { name: 'Track Pants', gender: 'him', cat: 'him-bottoms', brand: 'adidas', occ: ['gym'], rating: '4.50', ratingCount: 651, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Black', hex: '#111111', img: png('jeans', 5779), sizes: sz('S,M,L,XL', 20), priceRs: 1399, compareRs: 1899 }] },

  // ═══ HIM — Jackets (4) ═══
  { name: 'Bomber Jacket', gender: 'him', cat: 'him-jackets', brand: 'diesel', occ: ['streetwear'], rating: '4.60', ratingCount: 358, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'Olive', hex: '#5d6e3a', img: png('jacket', 8059), sizes: sz('M,L,XL'), priceRs: 2199, compareRs: 3299 }] },
  { name: 'Denim Trucker Jacket', gender: 'him', cat: 'him-jackets', brand: 'levis', occ: ['streetwear', 'travel'], rating: '4.70', ratingCount: 524, gallery: [u('photo-1542272604-787c3835535d')], colors: [{ name: 'Indigo', hex: '#2980b9', img: png('jacket', 8058), sizes: sz('S,M,L,XL'), priceRs: 3499, compareRs: 4499 }] },
  { name: 'Puffer Jacket', gender: 'him', cat: 'him-jackets', brand: 'north-face', occ: ['travel'], rating: '4.80', ratingCount: 287, gallery: [u('photo-1539109136881-3be0616acf4b')], colors: [{ name: 'Black', hex: '#111111', img: png('jacket', 8059), sizes: sz('M,L,XL'), priceRs: 5999, compareRs: 7999 }] },
  { name: 'Leather Biker Jacket', gender: 'him', cat: 'him-jackets', brand: 'diesel', occ: ['streetwear'], rating: '4.50', ratingCount: 142, gallery: [u('photo-1507003211169-0a1dd7228f2d')], colors: [{ name: 'Black', hex: '#1a1a1a', img: png('jacket', 8058), sizes: sz('M,L,XL', 5), priceRs: 7999, compareRs: 10999 }] },

  // ═══ HIM — Sneakers (4) ═══
  { name: 'Court Sneaker', gender: 'him', cat: 'him-sneakers', brand: 'nike', occ: ['streetwear'], rating: '4.90', ratingCount: 1247, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'White', hex: '#ffffff', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 3499, compareRs: 5499 }] },
  { name: 'Air Max Runner', gender: 'him', cat: 'him-sneakers', brand: 'nike', occ: ['gym'], rating: '4.80', ratingCount: 873, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Triple Black', hex: '#111111', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 4999, compareRs: 6499 }] },
  { name: 'Retro Suede Sneaker', gender: 'him', cat: 'him-sneakers', brand: 'puma', occ: ['streetwear'], rating: '4.50', ratingCount: 419, gallery: [u('photo-1542272604-787c3835535d')], colors: [{ name: 'Suede Blue', hex: '#2980b9', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 2999, compareRs: 3999 }] },
  { name: 'Classic White Sneaker', gender: 'him', cat: 'him-sneakers', brand: 'adidas', occ: ['travel'], rating: '4.70', ratingCount: 956, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Cloud White', hex: '#f3f3f3', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 3299, compareRs: 4299 }] },

  // ═══ HIM — Watches (3) ═══
  { name: 'Chrono Steel Watch', gender: 'him', cat: 'him-watches', brand: 'hugo-boss', occ: ['formal', 'office'], rating: '4.70', ratingCount: 231, gallery: [u('photo-1507003211169-0a1dd7228f2d')], colors: [{ name: 'Silver', hex: '#bdc3c7', img: png('watches', 101457), sizes: ONE_SIZE, priceRs: 8999, compareRs: 11999 }] },
  { name: 'Minimal Leather Watch', gender: 'him', cat: 'him-watches', brand: 'calvin-klein', occ: ['office'], rating: '4.60', ratingCount: 318, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'Tan', hex: '#c9a87c', img: png('watches', 101456), sizes: ONE_SIZE, priceRs: 5499, compareRs: 6999 }] },
  { name: 'Sport Digital Watch', gender: 'him', cat: 'him-watches', brand: 'puma', occ: ['gym'], rating: '4.40', ratingCount: 487, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Black', hex: '#111111', img: png('watches', 101457), sizes: ONE_SIZE, priceRs: 2499, compareRs: 3299 }] },

  // ═══ HIM — Coats (2) ═══
  { name: 'Wool Overcoat', gender: 'him', cat: 'him-coats', brand: 'hugo-boss', occ: ['formal'], rating: '4.80', ratingCount: 176, gallery: [u('photo-1507003211169-0a1dd7228f2d')], colors: [{ name: 'Charcoal', hex: '#3a3a3a', img: png('coat', 80), sizes: sz('M,L,XL'), priceRs: 9999, compareRs: 13999 }] },
  { name: 'Mac Trench Coat', gender: 'him', cat: 'him-coats', brand: 'burberry', occ: ['office'], rating: '4.70', ratingCount: 134, gallery: [u('photo-1591047139829-d91aecb6caea')], colors: [{ name: 'Sand', hex: '#c9a87c', img: png('coat', 80), sizes: sz('M,L,XL', 6), priceRs: 8499, compareRs: 11499 }] },

  // ═══ HIM — Eyewear (1) ═══
  { name: 'Aviator Sunglasses', gender: 'him', cat: 'him-eyewear', brand: 'prada', occ: ['travel'], rating: '4.40', ratingCount: 392, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Gunmetal', hex: '#3e2723', img: png('sunglasses', 155), sizes: ONE_SIZE, priceRs: 1599, compareRs: 2499 }] },

  // ═══ UNISEX — Apparel (6) ═══
  { name: 'Cotton Jogger Pants', gender: 'unisex', cat: 'apparel', brand: 'champion', occ: ['gym'], rating: '4.50', ratingCount: 689, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Charcoal', hex: '#3a3a3a', img: png('jeans', 5778), sizes: sz('S,M,L,XL', 22), priceRs: 899, compareRs: 1299 }] },
  { name: 'Printed Oversized Tee', gender: 'unisex', cat: 'apparel', brand: 'vans', occ: ['streetwear'], rating: '4.40', ratingCount: 834, gallery: [u('photo-1445205170230-053b83016050')], colors: [{ name: 'Vintage Wash', hex: '#bdc3c7', img: png('tshirt', 5454), sizes: sz('S,M,L,XL', 30), priceRs: 699, compareRs: 999 }] },
  { name: 'Fleece Hoodie', gender: 'unisex', cat: 'apparel', brand: 'champion', occ: ['streetwear'], rating: '4.70', ratingCount: 1102, gallery: [u('photo-1558618666-fcd25c85f82e')], colors: [{ name: 'Heather Grey', hex: '#bdc3c7', img: u('photo-1556821840-3a63f95609a7', 600), sizes: sz('S,M,L,XL', 18), priceRs: 1799, compareRs: 2499 }, { name: 'Black', hex: '#111111', img: u('photo-1509942774463-acf339cf87d5', 600), sizes: sz('S,M,L,XL', 15), priceRs: 1799, compareRs: 2499 }] },
  { name: 'Zip-Up Track Jacket', gender: 'unisex', cat: 'apparel', brand: 'adidas', occ: ['gym'], rating: '4.60', ratingCount: 512, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'Navy', hex: '#2c3e50', img: png('jacket', 8058), sizes: sz('S,M,L,XL', 16), priceRs: 2299, compareRs: 2999 }] },
  { name: 'Relaxed Sweatshirt', gender: 'unisex', cat: 'apparel', brand: 'hm', occ: ['travel'], rating: '4.30', ratingCount: 467, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Oat', hex: '#f5e6d3', img: u('photo-1556821840-3a63f95609a7', 600), sizes: sz('S,M,L,XL', 20), priceRs: 1299, compareRs: 1799 }] },
  { name: 'Raw Denim Jeans', gender: 'unisex', cat: 'apparel', brand: 'diesel', occ: ['streetwear'], rating: '4.60', ratingCount: 298, gallery: [u('photo-1542272604-787c3835535d')], colors: [{ name: 'Raw Indigo', hex: '#1a2a4a', img: png('jeans', 5779), sizes: sz('28,30,32,34,36'), priceRs: 4499, compareRs: 5999 }] },

  // ═══ UNISEX — Footwear (4) ═══
  { name: 'Canvas High-Top', gender: 'unisex', cat: 'footwear', brand: 'converse', occ: ['streetwear'], rating: '4.70', ratingCount: 1456, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'Black', hex: '#111111', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 2499, compareRs: 3299 }, { name: 'Off White', hex: '#f3f3f3', img: png('women_shoes', 7473), sizes: SHOE_RUN, priceRs: 2499, compareRs: 3299 }] },
  { name: 'Skate Classic', gender: 'unisex', cat: 'footwear', brand: 'vans', occ: ['streetwear'], rating: '4.60', ratingCount: 987, gallery: [u('photo-1445205170230-053b83016050')], colors: [{ name: 'Checker', hex: '#1a1a1a', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 2799, compareRs: 3499 }] },
  { name: '574 Core Runner', gender: 'unisex', cat: 'footwear', brand: 'new-balance', occ: ['travel', 'gym'], rating: '4.80', ratingCount: 765, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Grey', hex: '#bdc3c7', img: png('women_shoes', 7472), sizes: SHOE_RUN, priceRs: 4499, compareRs: 5499 }] },
  { name: 'Slip-On Sneaker', gender: 'unisex', cat: 'footwear', brand: 'vans', occ: ['travel'], rating: '4.50', ratingCount: 654, gallery: [u('photo-1445205170230-053b83016050')], colors: [{ name: 'Canvas White', hex: '#ffffff', img: png('women_shoes', 7473), sizes: SHOE_RUN, priceRs: 2299, compareRs: 2999 }] },

  // ═══ UNISEX — Accessories (4) ═══
  { name: 'Canvas Tote', gender: 'unisex', cat: 'accessories', brand: 'uniqlo', occ: ['travel'], rating: '4.40', ratingCount: 521, gallery: [u('photo-1483985988355-763728e1935b')], colors: [{ name: 'Natural', hex: '#f5e6d3', img: png('women_bag', 6427), sizes: ONE_SIZE, priceRs: 799, compareRs: 1199 }] },
  { name: 'Baseball Cap', gender: 'unisex', cat: 'accessories', brand: 'nike', occ: ['streetwear'], rating: '4.50', ratingCount: 876, gallery: [u('photo-1490481651871-ab68de25d43d')], colors: [{ name: 'Black', hex: '#111111', img: u('photo-1588850561407-ed78c282e89b', 600), sizes: ONE_SIZE, priceRs: 999, compareRs: 1399 }] },
  { name: 'Sport Socks 3-Pack', gender: 'unisex', cat: 'accessories', brand: 'puma', occ: ['gym'], rating: '4.30', ratingCount: 1203, gallery: [u('photo-1517836357463-d25dfeac3438')], colors: [{ name: 'White', hex: '#ffffff', img: u('photo-1586350977771-b3b0abd50c82', 600), sizes: sz('S,M,L', 30), priceRs: 499, compareRs: 699 }] },
  { name: 'Classic Backpack', gender: 'unisex', cat: 'accessories', brand: 'north-face', occ: ['travel'], rating: '4.70', ratingCount: 689, gallery: [u('photo-1525507119028-ed4c629a60a3')], colors: [{ name: 'Black', hex: '#111111', img: u('photo-1553062407-98eeb64c6a62', 600), sizes: ONE_SIZE, priceRs: 3299, compareRs: 4299 }] },
];

// ── Collections ───────────────────────────────────────────────────────────────

type CollectionSpec = {
  slug: string;
  name: string;
  kind: 'outfit' | 'occasion' | 'drop';
  gender: 'her' | 'him' | 'unisex';
  hero: string;
  accent: string[];
  sortOrder: number;
  isFeatured?: boolean;
  occasionTag?: string;
  startsAt?: Date;
  members?: string[]; // product names (must match PRODUCT_SPECS entries)
};

const COLLECTION_SPECS: CollectionSpec[] = [
  // Outfit bundles — HER
  { slug: 'her-date-night-glam', name: 'Date Night Glam', kind: 'outfit', gender: 'her', hero: u('photo-1539109136881-3be0616acf4b', 500), accent: ['#ff6b9d', '#a78bfa', '#feca57'], sortOrder: 10, members: ['Silk Slip Dress', 'Strappy Stilettos', 'Quilted Shoulder Bag'] },
  { slug: 'her-office-chic', name: 'Office Chic', kind: 'outfit', gender: 'her', hero: u('photo-1496747611176-843222e1e57c', 500), accent: ['#ffffff', '#f3f3f3', '#ffafbd'], sortOrder: 20, members: ['Wide-Leg Trousers', 'Silk Camisole', 'Belted Trench Coat', 'Nude Pumps'] },
  // Outfit bundles — HIM
  { slug: 'him-street-uniform', name: 'Street Uniform', kind: 'outfit', gender: 'him', hero: u('photo-1490481651871-ab68de25d43d', 500), accent: ['#000000', '#222222', '#333333'], sortOrder: 30, members: ['Graphic Oversized Tee', 'Slim Wash Denim', 'Court Sneaker', 'Baseball Cap'] },
  { slug: 'him-office-power', name: 'Office Power', kind: 'outfit', gender: 'him', hero: u('photo-1591047139829-d91aecb6caea', 500), accent: ['#1a1a1a', '#3a3a3a', '#5d4037'], sortOrder: 40, members: ['Slim Fit Oxford Shirt', 'Tailored Chinos', 'Chrono Steel Watch'] },
  { slug: 'him-weekend-drip', name: 'Weekend Drip', kind: 'outfit', gender: 'him', hero: u('photo-1507003211169-0a1dd7228f2d', 500), accent: ['#222222', '#5d4037', '#888888'], sortOrder: 50, members: ['Flannel Check Shirt', 'Cargo Joggers', 'Retro Suede Sneaker', 'Classic Backpack'] },

  // Occasions — HER (auto-resolve via occasionTag)
  { slug: 'her-occasion-brunch', name: 'Brunch', kind: 'occasion', gender: 'her', hero: u('photo-1496747611176-843222e1e57c', 400), accent: ['#fff5e1', '#ffe0b2'], sortOrder: 10, occasionTag: 'brunch' },
  { slug: 'her-occasion-date', name: 'Date', kind: 'occasion', gender: 'her', hero: u('photo-1539109136881-3be0616acf4b', 400), accent: ['#ff6b9d', '#feca57'], sortOrder: 20, occasionTag: 'date' },
  { slug: 'her-occasion-beach', name: 'Beach', kind: 'occasion', gender: 'her', hero: u('photo-1583496661160-fb5886a0aaaa', 400), accent: ['#a8e6cf', '#dcedc1'], sortOrder: 30, occasionTag: 'beach' },
  { slug: 'her-occasion-wedding', name: 'Wedding', kind: 'occasion', gender: 'her', hero: u('photo-1469334031218-e382a71b716b', 400), accent: ['#f5e6d3', '#c9a87c'], sortOrder: 40, occasionTag: 'wedding' },
  { slug: 'her-occasion-party', name: 'Party', kind: 'occasion', gender: 'her', hero: u('photo-1503342217505-b0a15ec3261c', 400), accent: ['#a78bfa', '#ff6b9d'], sortOrder: 50, occasionTag: 'party' },
  // Occasions — HIM
  { slug: 'him-occasion-office', name: 'Office', kind: 'occasion', gender: 'him', hero: u('photo-1591047139829-d91aecb6caea', 400), accent: ['#1a1a1a', '#5d4037'], sortOrder: 60, occasionTag: 'office' },
  { slug: 'him-occasion-streetwear', name: 'Streetwear', kind: 'occasion', gender: 'him', hero: u('photo-1490481651871-ab68de25d43d', 400), accent: ['#000000', '#333333'], sortOrder: 70, occasionTag: 'streetwear' },
  { slug: 'him-occasion-gym', name: 'Gym', kind: 'occasion', gender: 'him', hero: u('photo-1517836357463-d25dfeac3438', 400), accent: ['#222222', '#666666'], sortOrder: 80, occasionTag: 'gym' },
  { slug: 'him-occasion-formal', name: 'Formal', kind: 'occasion', gender: 'him', hero: u('photo-1507003211169-0a1dd7228f2d', 400), accent: ['#1a1a1a', '#3a3a3a'], sortOrder: 90, occasionTag: 'formal' },
  { slug: 'him-occasion-travel', name: 'Travel', kind: 'occasion', gender: 'him', hero: u('photo-1525507119028-ed4c629a60a3', 400), accent: ['#5d4037', '#8d6e63'], sortOrder: 100, occasionTag: 'travel' },

  // Drops
  { slug: 'drop-court-classics', name: 'Court Classics', kind: 'drop', gender: 'unisex', hero: u('photo-1490481651871-ab68de25d43d', 500), accent: ['#ffffff', '#111111', '#c3002f'], sortOrder: 10, isFeatured: true, startsAt: daysAgo(1), members: ['Court Sneaker', 'Canvas High-Top', 'Skate Classic', '574 Core Runner', 'Classic White Sneaker'] },
  { slug: 'drop-monsoon-edit', name: 'Monsoon Edit', kind: 'drop', gender: 'unisex', hero: u('photo-1539109136881-3be0616acf4b', 500), accent: ['#2c3e50', '#7f8c8d', '#1abc9c'], sortOrder: 20, isFeatured: true, startsAt: daysAgo(1), members: ['Puffer Jacket', 'Mac Trench Coat', 'Fleece Hoodie', 'Belted Trench Coat', 'Slip-On Sneaker'] },
  { slug: 'drop-midnight-luxe', name: 'Midnight Luxe', kind: 'drop', gender: 'her', hero: u('photo-1503342217505-b0a15ec3261c', 500), accent: ['#1a1a1a', '#a78bfa', '#feca57'], sortOrder: 30, startsAt: daysAgo(1), members: ['Satin Wrap Dress', 'Strappy Stilettos', 'Faux Fur Coat', 'Quilted Shoulder Bag'] },
  { slug: 'drop-summer-staples', name: 'Summer Staples', kind: 'drop', gender: 'him', hero: u('photo-1525507119028-ed4c629a60a3', 500), accent: ['#fff5e1', '#a8e6cf', '#feca57'], sortOrder: 40, startsAt: daysAgo(1), members: ['Linen Summer Shirt', 'Essential Crew Tee', 'Aviator Sunglasses', 'Canvas Tote'] },
  // Upcoming drop (startsAt in the future) — exercises the app's launch countdown.
  { slug: 'drop-neon-future', name: 'Neon Future', kind: 'drop', gender: 'unisex', hero: u('photo-1496747611176-843222e1e57c', 500), accent: ['#0f0f0f', '#a78bfa', '#feca57'], sortOrder: 50, isFeatured: true, startsAt: daysAgo(-3), members: ['Classic White Sneaker', 'Fleece Hoodie', 'Essential Crew Tee', 'Canvas Tote'] },

  // Sentinel — seeded LAST: its presence implies the whole block completed.
  { slug: SENTINEL_COLLECTION_SLUG, name: 'Brunch Goddess', kind: 'outfit', gender: 'her', hero: u('photo-1483985988355-763728e1935b', 500), accent: ['#ffafbd', '#ffc3a0', '#feca57'], sortOrder: 5, members: ['Floral Maxi Dress', 'Ribbed Knit Top', 'Mini Crossbody', 'Block Heels'] },
];

// ── Main export ───────────────────────────────────────────────────────────────

export async function seedConsumerCatalog(database: typeof Db): Promise<void> {
  // 1. Brands — skip by slug; onConflictDoNothing guards the lower(name) unique index.
  const brandIdBySlug = new Map<string, string>();
  for (const b of BRAND_SPECS) {
    const existing = await database.query.brands.findFirst({ where: eq(brands.slug, b.slug) });
    if (existing) {
      brandIdBySlug.set(b.slug, existing.id);
      continue;
    }
    const id = newId(IdPrefix.Brand);
    await database
      .insert(brands)
      .values({
        id,
        slug: b.slug,
        name: b.name,
        tintColor: b.tint,
        logoUrl: b.logo,
        domain: b.domain,
        isActive: true,
      })
      .onConflictDoNothing();
    const row = await database.query.brands.findFirst({ where: eq(brands.slug, b.slug) });
    if (row) brandIdBySlug.set(b.slug, row.id);
    console.log(`  → seeded brand '${b.slug}'`);
  }

  // 2. Categories — insert new; backfill image/tint/icon on existing rows missing imageUrl.
  const categoryIdBySlug = new Map<string, string>();
  for (const c of CATEGORY_SPECS) {
    const existing = await database.query.categories.findFirst({
      where: eq(categories.slug, c.slug),
    });
    if (existing) {
      categoryIdBySlug.set(c.slug, existing.id);
      if (!existing.imageUrl) {
        await database
          .update(categories)
          .set({ imageUrl: c.imageUrl, tintColor: c.tintColor, iconName: c.iconName, label: c.label })
          .where(eq(categories.id, existing.id));
        console.log(`  → backfilled category '${c.slug}'`);
      }
      continue;
    }
    const id = newId(IdPrefix.Category);
    await database.insert(categories).values({
      id,
      slug: c.slug,
      label: c.label,
      gender: c.gender,
      iconName: c.iconName,
      tintColor: c.tintColor,
      imageUrl: c.imageUrl,
      sortOrder: c.sortOrder,
      isActive: true,
    });
    categoryIdBySlug.set(c.slug, id);
    console.log(`  → seeded category '${c.slug}'`);
  }

  // 3. Listings + collections — all-or-nothing block guarded by sentinel collection.
  const sentinel = await database.query.collections.findFirst({
    where: eq(collections.slug, SENTINEL_COLLECTION_SLUG),
  });
  if (sentinel) {
    console.log('  → consumer catalog listings already seeded (sentinel found), skipping');
    return;
  }

  // 3a. Store — reuse the demo store; create a standalone one if seeds ran out of order.
  let store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.legalEntityId, 'LE_KAUSH_001'),
  });
  if (!store) {
    const storeId = newId(IdPrefix.Store);
    await database.insert(retailerStores).values({
      id: storeId,
      legalEntityId: 'LE_KAUSH_001',
      legalName: 'Kaushaly Fashion Studio',
      gstin: '27AAFCK1234M1Z5',
      pan: 'AAFCK1234M',
      address: '12, Linking Road, Bandra West, Mumbai, MH 400050',
      stateCode: 'MH',
      lat: 19.0608,
      lng: 72.8362,
      status: 'active',
      platformFeeBp: 200,
      handlingFeePaise: 0,
      convenienceFeePaise: 0,
      payoutCadenceDays: 7,
      delegationModeEnabled: false,
    });
    store = await database.query.retailerStores.findFirst({
      where: eq(retailerStores.id, storeId),
    });
    console.log(`  → seeded store ${storeId}`);
  }
  const storeId = store!.id;

  // 3b. Listings with variant groups + variants.
  const listingIdByName = new Map<string, string>();
  for (const spec of PRODUCT_SPECS) {
    const brandId = brandIdBySlug.get(spec.brand);
    const categoryId = categoryIdBySlug.get(spec.cat);
    if (!brandId || !categoryId) {
      console.warn(`  ! skipping "${spec.name}" — missing brand/category (${spec.brand}/${spec.cat})`);
      continue;
    }
    const listingId = newId(IdPrefix.Listing);
    const galleryUrls = [spec.colors[0]!.img, ...spec.gallery];
    await database.insert(productListings).values({
      id: listingId,
      storeId,
      brandId,
      categoryId,
      name: spec.name,
      description: `${spec.name} — a wardrobe essential, crafted for comfort and built to last.`,
      gender: spec.gender,
      listingPolicy: 'return',
      galleryUrls,
      occasion: spec.occ,
      variantMode: 'color_size',
      status: 'active',
      ratingAvg: spec.rating,
      ratingCount: spec.ratingCount,
    });
    await database.insert(variantGroups).values({
      id: newId(IdPrefix.VariantGroup),
      listingId,
      storeId,
      name: 'Default',
      isDefault: true,
    });
    for (const [i, color] of spec.colors.entries()) {
      const groupId = newId(IdPrefix.VariantGroup);
      await database.insert(variantGroups).values({
        id: groupId,
        listingId,
        storeId,
        name: color.name,
        colorHex: color.hex,
        sortOrder: i,
      });
      for (const s of color.sizes) {
        await database.insert(variants).values({
          id: newId(IdPrefix.Variant),
          listingId,
          storeId,
          groupId,
          attributes: { size: s.size, color: color.name },
          attributesLabel: `${s.size} / ${color.name}`,
          imageUrls: [color.img],
          stock: s.stock,
          reserved: 0,
          pricePaise: paise(color.priceRs),
          ...(color.compareRs !== undefined && { compareAtPrice: paise(color.compareRs) }),
        });
      }
    }
    listingIdByName.set(spec.name, listingId);
  }
  console.log(`  → seeded ${listingIdByName.size} consumer listings`);

  // 3c. Collections + memberships (sentinel last in COLLECTION_SPECS).
  for (const c of COLLECTION_SPECS) {
    const existing = await database.query.collections.findFirst({
      where: eq(collections.slug, c.slug),
    });
    if (existing) {
      console.log(`  → collection '${c.slug}' already exists, skipping`);
      continue;
    }
    const collectionId = newId(IdPrefix.Collection);
    await database.insert(collections).values({
      id: collectionId,
      slug: c.slug,
      name: c.name,
      kind: c.kind,
      gender: c.gender,
      heroImageUrl: c.hero,
      accentColors: c.accent,
      sortOrder: c.sortOrder,
      isFeatured: c.isFeatured ?? false,
      status: 'active',
      ...(c.occasionTag !== undefined && { occasionTag: c.occasionTag }),
      ...(c.startsAt !== undefined && { startsAt: c.startsAt }),
    });
    if (c.members) {
      for (const [i, name] of c.members.entries()) {
        const listingId = listingIdByName.get(name);
        if (!listingId) {
          console.warn(`  ! collection '${c.slug}': member "${name}" not found, skipping`);
          continue;
        }
        await database
          .insert(collectionListings)
          .values({ collectionId, listingId, sortOrder: i })
          .onConflictDoNothing();
      }
    }
    console.log(`  → seeded collection '${c.slug}' (${c.kind})`);
  }

  console.log('  → consumer catalog seed complete');
}

// Standalone entry: npx tsx src/db/seed/consumer-catalog.ts
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('consumer-catalog.ts');
if (isMain) {
  seedConsumerCatalog(db)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
