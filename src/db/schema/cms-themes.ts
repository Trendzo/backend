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
import type { ThemeChrome, ThemeCopy, ThemeDecor, ThemePlatform, ThemeTokens } from '../../shared/cms/theme-schema.js';
import { adminAccounts } from './identity.js';

/**
 * Festival themes — server-driven skins for the consumer app.
 *
 * Same editing model as the Home CMS (see ./cms.ts): the `cms_themes` rows ARE the draft,
 * admin mutates them freely, and Publishing freezes every ENABLED row into an immutable
 * `cms_theme_publications` snapshot. `GET /cms/theme` serves only the latest snapshot,
 * resolving exactly one winner per request — scheduling, city, platform and app-version
 * targeting are applied when the snapshot is READ, not when it is written, so a Diwali
 * theme published on Monday lights up at midnight Friday on its own.
 *
 * Deliberately a sibling of `cms_publications` rather than a `resource_type` column on it:
 * the Home CMS publish path is hot and battle-tested, and retrofitting a composite unique
 * (resource_type, version) under it buys nothing a 5-column twin table doesn't.
 *
 * `platforms`/`cities` are jsonb like `cms_items.cities`, with the same semantics: NULL
 * means unrestricted, `[]` means nobody, and a request missing the context fails closed.
 */
export const cmsThemes = pgTable(
  'cms_themes',
  {
    id: text('id').primaryKey(),
    /** Stable public identifier, e.g. `diwali-2026`. Editable in the draft; unique. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Publish snapshots only enabled rows; disable-now flips this AND republishes. */
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Resolver sort key — higher wins. See shared/cms/theme-render.ts for full precedence. */
    priority: integer('priority').notNull().default(0),
    /** Live window. Both null = always on while enabled. Applied at read time. */
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    /** City allow-list. NULL = everywhere; [] = nowhere; unknown caller city fails closed. */
    cities: jsonb('cities').$type<string[]>(),
    /** Platform allow-list. NULL = both; a request without x-app-platform fails closed. */
    platforms: jsonb('platforms').$type<ThemePlatform[]>(),
    /** Semver floor ("1.0.7"). NULL = no gate; unparseable client versions fail closed. */
    minAppVersion: text('min_app_version'),
    /** Allowlisted palette overrides — see shared/cms/theme-schema.ts REMOTE_THEME_TOKENS. */
    tokens: jsonb('tokens').$type<ThemeTokens>().notNull().default(sql`'{}'::jsonb`),
    chrome: jsonb('chrome').$type<ThemeChrome>().notNull(),
    decor: jsonb('decor').$type<ThemeDecor>().notNull(),
    copy: jsonb('copy').$type<ThemeCopy>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdByAdminId: text('created_by_admin_id').references(() => adminAccounts.id),
    updatedByAdminId: text('updated_by_admin_id').references(() => adminAccounts.id),
  },
  (t) => ({
    slugIdx: uniqueIndex('cms_themes_slug_idx').on(t.slug),
    enabledIdx: index('cms_themes_enabled_idx').on(t.isEnabled),
    windowGuard: check(
      'cms_themes_window_guard',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
  }),
);

/**
 * An immutable render of every enabled theme at one moment. The public endpoint reads only
 * the highest `version`; disable-now inserts a new version by SUBTRACTING one slug from the
 * latest payload (never by re-rendering the draft — the kill switch must not depend on
 * unrelated drafts being valid). Restore copies a payload back over the draft rows.
 */
export const cmsThemePublications = pgTable(
  'cms_theme_publications',
  {
    id: text('id').primaryKey(),
    /** Monotonic. Allocated as max(version)+1 under a pg advisory xact lock. */
    version: integer('version').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    note: text('note'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    publishedByAdminId: text('published_by_admin_id').references(() => adminAccounts.id),
  },
  (t) => ({
    versionIdx: uniqueIndex('cms_theme_publications_version_idx').on(t.version),
    publishedAtIdx: index('cms_theme_publications_published_at_idx').on(t.publishedAt),
  }),
);

// ===== Relations =====

export const cmsThemesRelations = relations(cmsThemes, ({ one }) => ({
  createdBy: one(adminAccounts, {
    fields: [cmsThemes.createdByAdminId],
    references: [adminAccounts.id],
    relationName: 'cms_themes_created_by',
  }),
  updatedBy: one(adminAccounts, {
    fields: [cmsThemes.updatedByAdminId],
    references: [adminAccounts.id],
    relationName: 'cms_themes_updated_by',
  }),
}));

export const cmsThemePublicationsRelations = relations(cmsThemePublications, ({ one }) => ({
  publishedBy: one(adminAccounts, {
    fields: [cmsThemePublications.publishedByAdminId],
    references: [adminAccounts.id],
  }),
}));
