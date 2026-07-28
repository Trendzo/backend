/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Seed default brands so retailer onboarding has a non-empty pick-list out of the box.
 * Idempotent via slug — re-runs are safe.
 *
 * Categories used to be seeded here too, as nine flat rows (`apparel`, `her-tops`,
 * `him-shirts`…). They now come from `category-taxonomy.ts`, which owns the two-level
 * tree; seeding the flat set here as well would just create rows for that seeder to
 * immediately retire.
 */

import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { brands } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type SeedBrand = {
  slug: string;
  name: string;
  tintColor?: string;
};

const BRAND_DEFAULTS: readonly SeedBrand[] = [
  { slug: 'generic', name: 'Generic', tintColor: '#8E8E93' },
  { slug: 'house-of-closetx', name: 'House of ClosetX', tintColor: '#1C1C1E' },
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
}
