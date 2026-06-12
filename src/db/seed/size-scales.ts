/**
 * Platform size scales for the system color → size variant flow. Idempotent by
 * name — re-runs are safe. `categorySlugs: []` = universal (every category).
 *
 * Apparel-ish slugs get letter + numeric scales, footwear gets UK/US/EU,
 * accessories get inch/weight scales. Free-typed sizes are always accepted on
 * top of these pick-lists.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { sizeScales } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const APPAREL = [
  'apparel',
  'her-tops',
  'her-dresses',
  'her-bottoms',
  'him-shirts',
  'him-tshirts',
  'him-bottoms',
];
const BOTTOMS = ['apparel', 'her-bottoms', 'him-bottoms'];
const FOOTWEAR = ['footwear'];
const ACCESSORIES = ['accessories'];

type Scale = { name: string; values: string[]; categorySlugs: string[]; sortOrder: number };

export const SIZE_SCALE_DEFAULTS: readonly Scale[] = [
  // Apparel
  { name: 'Letter sizes', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'], categorySlugs: APPAREL, sortOrder: 10 },
  { name: 'Waist (in)', values: ['26', '28', '30', '32', '34', '36', '38', '40', '42', '44'], categorySlugs: BOTTOMS, sortOrder: 20 },
  { name: 'Kids age', values: ['0-3M', '3-6M', '6-12M', '1-2Y', '2-4Y', '4-6Y', '6-8Y', '8-10Y', '10-12Y'], categorySlugs: APPAREL, sortOrder: 30 },
  // Footwear
  { name: 'UK', values: ['UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'], categorySlugs: FOOTWEAR, sortOrder: 10 },
  { name: 'US', values: ['US 4', 'US 5', 'US 6', 'US 7', 'US 8', 'US 9', 'US 10', 'US 11', 'US 12', 'US 13'], categorySlugs: FOOTWEAR, sortOrder: 20 },
  { name: 'EU', values: ['EU 35', 'EU 36', 'EU 37', 'EU 38', 'EU 39', 'EU 40', 'EU 41', 'EU 42', 'EU 43', 'EU 44', 'EU 45'], categorySlugs: FOOTWEAR, sortOrder: 30 },
  // Accessories
  { name: 'Belt (in)', values: ['28', '30', '32', '34', '36', '38', '40', '42', '44'], categorySlugs: ACCESSORIES, sortOrder: 10 },
  { name: 'Length (in)', values: ['6', '8', '10', '12', '16', '18', '20', '24', '30', '36'], categorySlugs: ACCESSORIES, sortOrder: 20 },
  { name: 'Weight (g)', values: ['2', '5', '10', '20', '50', '100', '250', '500'], categorySlugs: ACCESSORIES, sortOrder: 30 },
  // Universal
  { name: 'One size', values: ['Free Size'], categorySlugs: [], sortOrder: 90 },
];

export async function seedSizeScales(db: typeof Db): Promise<void> {
  for (const scale of SIZE_SCALE_DEFAULTS) {
    const existing = await db.query.sizeScales.findFirst({
      where: eq(sizeScales.name, scale.name),
    });
    if (existing) continue;
    await db.insert(sizeScales).values({ id: newId(IdPrefix.SizeScale), ...scale });
    console.log(`  → seeded size scale '${scale.name}'`);
  }
}
