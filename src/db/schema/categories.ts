import { relations } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { gender } from './enums.js';

/**
 * Catalog category — structured entity referenced by product_listings via FK.
 *
 * The consumer app navigates by category and segments them by gender (per
 * `frontend/src/data/mockData.ts:157-178` — 8 HER categories + 8 HIM categories,
 * disjoint sets). The same `gender` enum used on listings classifies the category
 * (her/him/unisex).
 *
 * Self-FK on `parentId` supports a tree (e.g. Apparel → Tops → Crop Tops). Top-level
 * categories have parentId = null. Slug is globally unique for URL/routing stability.
 */
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(), // URL-stable identifier
    label: text('label').notNull(), // display name
    parentId: text('parent_id'),
    iconName: text('icon_name'), // ionicons name used by the consumer app
    tintColor: text('tint_color'), // hex; consumer app card theming
    imageUrl: text('image_url'),
    gender: gender('gender').notNull().default('unisex'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => ({
    slugIdx: uniqueIndex('categories_slug_idx').on(t.slug),
    genderActiveIdx: index('categories_gender_active_idx').on(t.gender, t.isActive),
    parentIdx: index('categories_parent_idx').on(t.parentId),
    parentFk: foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'categories_parent_id_fk',
    }),
  }),
);

// ===== Relations =====

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'categoryHierarchy',
  }),
  children: many(categories, { relationName: 'categoryHierarchy' }),
}));
