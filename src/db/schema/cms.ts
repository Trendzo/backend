import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { cmsGender, cmsMediaKind } from './enums.js';
import { adminAccounts } from './identity.js';

/**
 * Home CMS — the merchandising content the consumer app renders above its product feed.
 *
 * Everything the app shows on Home (campaign posters, Top Stories, Steals tiles, Shop-by-
 * Occasion cards, the Her/His Edit pages) used to be a module-level `require()` array inside
 * HomeScreen.tsx, so changing a banner meant shipping a build. These tables move that content
 * into the database without moving the *layout*: section order still lives in the app's JSX,
 * and `cms_sections` is a fixed, seeded set of slots the admin edits but cannot create or
 * delete. `sortOrder` is stored anyway so a later server-driven-layout phase is additive.
 *
 * Editing model: `cms_sections` + `cms_items` ARE the draft — admin mutates them freely.
 * Publishing renders them into an immutable `cms_publications` snapshot, and the public
 * endpoint serves the latest snapshot. That gives an atomic publish, a real preview (read the
 * draft instead), one-click rollback, and a single-row read on the hot path.
 *
 * Scheduling and targeting are applied when the snapshot is READ, not when it is written, so
 * a campaign dated for next Friday can be published today and appear on its own.
 */

/** `{ route, params }` — a route name from the app's RootNav stack plus its params. */
export type CmsLink = {
  route: string;
  // `| undefined` spelled out because the backend runs `exactOptionalPropertyTypes`, and a
  // zod-parsed body arrives with `params: undefined` rather than with the key absent.
  params?: Record<string, string | number | boolean> | undefined;
};

/**
 * One fixed content slot, e.g. `home.hero` or `page.edit_her`. Seeded from the app's shipped
 * content file; `key` is the contract between this table, the app's section registry, and the
 * shared section schema that drives admin's form rendering.
 */
export const cmsSections = pgTable(
  'cms_sections',
  {
    id: text('id').primaryKey(),
    /** Stable slot identifier — `home.hero`, `home.steals`, `page.top_stories`, … */
    key: text('key').notNull(),
    /** Widget type; validated against SECTION_SCHEMA in shared/cms/schema.ts. */
    type: text('type').notNull(),
    // Section-level editorial copy. Null means "this section has no such line" — the app
    // hides the element rather than rendering an empty one.
    title: text('title'),
    subtitle: text('subtitle'),
    kicker: text('kicker'),
    ctaLabel: text('cta_label'),
    /** Per-type extras: background assetKey, accent hexes, autoplay ms, and so on. */
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Admin's on/off switch for the whole section. */
    isEnabled: boolean('is_enabled').notNull().default(true),
    /**
     * Stored but NOT read by the app today — section order lives in HomeScreen.tsx's JSX.
     * Here so switching to a server-driven layout later needs no migration.
     */
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedByAdminId: text('updated_by_admin_id').references(() => adminAccounts.id),
  },
  (t) => ({
    keyIdx: uniqueIndex('cms_sections_key_idx').on(t.key),
    orderIdx: index('cms_sections_order_idx').on(t.sortOrder),
  }),
);

/**
 * One card / slide / tile inside a section.
 *
 * Media is deliberately two-headed. `assetKey` names art bundled in the app binary — it costs
 * no network, works offline, and is how every existing tile keeps its current performance.
 * `imageUrl` is art an admin uploaded through POST /uploads. The app prefers `imageUrl` when
 * present and falls back to the bundled asset, so new campaigns need no app release while old
 * ones stay instant.
 *
 * Copy lives in `content` rather than typed columns because each widget type wants a different
 * set of fields (a story has tag/title/blurb/tags[], a steal tile has label/priceLine). The
 * shared section schema is what makes that jsonb safe: it declares the legal fields per type,
 * the backend validates writes against it, and admin renders its form from it.
 */
export const cmsItems = pgTable(
  'cms_items',
  {
    id: text('id').primaryKey(),
    sectionId: text('section_id')
      .notNull()
      .references(() => cmsSections.id, { onDelete: 'cascade' }),
    /** Stable public identifier, unique within the section — the app keys its list on this. */
    key: text('key').notNull(),
    /** Which rail shows it. 'all' renders on both. */
    gender: cmsGender('gender').notNull().default('all'),
    sortOrder: integer('sort_order').notNull().default(0),

    /** Bundled art registry key, e.g. `banners/her-new1`. Null when uploaded art is used. */
    assetKey: text('asset_key'),
    /** Uploaded art. Wins over assetKey when both are set. */
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),

    link: jsonb('link').$type<CmsLink>(),
    content: jsonb('content')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Publish window. Both null = always on. Applied at read time, not publish time. */
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    /**
     * City allow-list. NULL means everywhere — which is not the same as `[]`, and the
     * difference matters: a request that carries no city keeps only unrestricted items, so an
     * empty array would hide the item from everyone rather than from no one.
     */
    cities: jsonb('cities').$type<string[]>(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sectionKeyIdx: uniqueIndex('cms_items_section_key_idx').on(t.sectionId, t.key),
    sectionOrderIdx: index('cms_items_section_order_idx').on(t.sectionId, t.sortOrder),
    sectionGenderIdx: index('cms_items_section_gender_idx').on(t.sectionId, t.gender),
    windowGuard: check(
      'cms_items_window_guard',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

/**
 * An immutable render of the whole draft at one moment. The public endpoint reads only the
 * highest `version`; restoring an older one copies its payload back into the draft tables
 * rather than deleting anything, so history stays intact.
 */
export const cmsPublications = pgTable(
  'cms_publications',
  {
    id: text('id').primaryKey(),
    /** Monotonic. Allocated as max(version) + 1 inside the publish transaction. */
    version: integer('version').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    note: text('note'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedByAdminId: text('published_by_admin_id').references(() => adminAccounts.id),
  },
  (t) => ({
    versionIdx: uniqueIndex('cms_publications_version_idx').on(t.version),
    publishedAtIdx: index('cms_publications_published_at_idx').on(t.publishedAt),
  }),
);

/**
 * Catalogue of the art bundled in the app binary, so the admin picker can list and *preview*
 * assets it cannot otherwise see — the portal is a web page and cannot resolve a React Native
 * `require()`. `previewUrl` points at a copy of the same file in object storage, uploaded once
 * by a seed-time script. The app never reads this table; it resolves `assetKey` locally.
 */
export const cmsAssets = pgTable(
  'cms_assets',
  {
    /** Registry key, e.g. `banners/her-new1` — matches `cms_items.asset_key`. */
    key: text('key').primaryKey(),
    /** Top-level folder (`banners`, `story-posters`, `steals`, …) — the picker's filter. */
    category: text('category').notNull(),
    kind: cmsMediaKind('kind').notNull().default('image'),
    previewUrl: text('preview_url'),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    categoryIdx: index('cms_assets_category_idx').on(t.category),
  }),
);

// ===== Relations =====

export const cmsSectionsRelations = relations(cmsSections, ({ one, many }) => ({
  items: many(cmsItems),
  updatedBy: one(adminAccounts, {
    fields: [cmsSections.updatedByAdminId],
    references: [adminAccounts.id],
  }),
}));

export const cmsItemsRelations = relations(cmsItems, ({ one }) => ({
  section: one(cmsSections, {
    fields: [cmsItems.sectionId],
    references: [cmsSections.id],
  }),
}));

export const cmsPublicationsRelations = relations(cmsPublications, ({ one }) => ({
  publishedBy: one(adminAccounts, {
    fields: [cmsPublications.publishedByAdminId],
    references: [adminAccounts.id],
  }),
}));
