import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Brand — structured entity referenced by product_listings via FK.
 *
 * The consumer app expects brands as first-class entities with logo + tint
 * (per `frontend/src/data/mockData.ts:60-85` — 24 brands with logo URLs and theme colors).
 * Modelling brand as a free-text string on listings would force the app to derive
 * logo/tint from a brand-name lookup, which the existing app does not do.
 *
 * Slug is globally unique. `domain` is captured for future deep-linking / verification
 * but not displayed in the consumer app today.
 */
export const brands = pgTable(
  'brands',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    tintColor: text('tint_color'),
    logoUrl: text('logo_url'),
    domain: text('domain'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({
    slugIdx: uniqueIndex('brands_slug_idx').on(t.slug),
    // Case-insensitive uniqueness on display name. Without this PUMA / Puma / puma
    // would all collide as separate rows in the picker. Enforced at the DB level so
    // the retailer self-serve path can't race past a check-then-insert window.
    nameLowerIdx: uniqueIndex('brands_name_lower_idx').on(sql`lower(${t.name})`),
    activeIdx: index('brands_active_idx').on(t.isActive),
  }),
);
