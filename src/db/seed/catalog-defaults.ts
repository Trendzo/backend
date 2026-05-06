/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Seed default brands + top-level categories so retailer onboarding has a non-empty pick-list
 * out of the box. Idempotent via slug — re-runs are safe.
 */

import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { brands, categories } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type SeedBrand = {
  slug: string;
  name: string;
  tintColor?: string;
};

type SeedCategory = {
  slug: string;
  label: string;
  gender: 'her' | 'him' | 'unisex';
  iconName?: string;
  tintColor?: string;
  sortOrder: number;
};

const BRAND_DEFAULTS: readonly SeedBrand[] = [
  { slug: 'generic', name: 'Generic', tintColor: '#8E8E93' },
  { slug: 'house-of-closetx', name: 'House of ClosetX', tintColor: '#1C1C1E' },
];

const CATEGORY_DEFAULTS: readonly SeedCategory[] = [
  // Unisex top-level
  { slug: 'apparel', label: 'Apparel', gender: 'unisex', iconName: 'shirt-outline', sortOrder: 10 },
  { slug: 'footwear', label: 'Footwear', gender: 'unisex', iconName: 'footsteps-outline', sortOrder: 20 },
  { slug: 'accessories', label: 'Accessories', gender: 'unisex', iconName: 'glasses-outline', sortOrder: 30 },
  // HER
  { slug: 'her-tops', label: 'Tops', gender: 'her', iconName: 'shirt-outline', sortOrder: 100 },
  { slug: 'her-dresses', label: 'Dresses', gender: 'her', iconName: 'woman-outline', sortOrder: 110 },
  { slug: 'her-bottoms', label: 'Bottoms', gender: 'her', iconName: 'walk-outline', sortOrder: 120 },
  // HIM
  { slug: 'him-shirts', label: 'Shirts', gender: 'him', iconName: 'shirt-outline', sortOrder: 200 },
  { slug: 'him-tshirts', label: 'T-Shirts', gender: 'him', iconName: 'shirt-outline', sortOrder: 210 },
  { slug: 'him-bottoms', label: 'Bottoms', gender: 'him', iconName: 'walk-outline', sortOrder: 220 },
];

export async function seedCatalogDefaults(database: typeof Db): Promise<void> {
  for (const b of BRAND_DEFAULTS) {
    const existing = await database.query.brands.findFirst({ where: eq(brands.slug, b.slug) });
    if (existing) continue;
    await database.insert(brands).values({
      id: newId(IdPrefix.Brand),
      slug: b.slug,
      name: b.name,
      ...(b.tintColor !== undefined && { tintColor: b.tintColor }),
      isActive: true,
    });
    console.log(`  → seeded brand '${b.slug}'`);
  }

  for (const c of CATEGORY_DEFAULTS) {
    const existing = await database.query.categories.findFirst({
      where: eq(categories.slug, c.slug),
    });
    if (existing) continue;
    await database.insert(categories).values({
      id: newId(IdPrefix.Category),
      slug: c.slug,
      label: c.label,
      gender: c.gender,
      ...(c.iconName !== undefined && { iconName: c.iconName }),
      ...(c.tintColor !== undefined && { tintColor: c.tintColor }),
      sortOrder: c.sortOrder,
      isActive: true,
    });
    console.log(`  → seeded category '${c.slug}'`);
  }
}
