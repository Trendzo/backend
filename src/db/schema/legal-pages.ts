import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The apps that ship their OWN privacy policy. Each collects different data
 * (shoppers vs retailers vs delivery partners), so Google Play wants a distinct,
 * accurate policy per app rather than one shared document.
 */
export const PRIVACY_APPS = ['customer', 'retailer', 'driver'] as const;
export type PrivacyApp = (typeof PRIVACY_APPS)[number];

/**
 * Per-app privacy policy — one editable row per app, rendered as public HTML at
 * `/privacy/:app`. Edited individually from the admin CMS. Deliberately separate
 * from `retailer_terms` (the short in-app acceptance digest) and from the shared
 * static fallback in `shared/privacy-policy.ts`: a missing row falls back to the
 * built-in default, so the public URL is never blank even before an admin edits it.
 */
export const appPrivacyPolicies = pgTable(
  'app_privacy_policies',
  {
    id: text('id').primaryKey(),
    /** One of PRIVACY_APPS. Unique — one live policy per app. */
    app: text('app').notNull(),
    title: text('title').notNull(),
    /** Sanitized rich-text HTML (headings, paragraphs, lists, links). */
    bodyHtml: text('body_html').notNull(),
    /** Human "Effective <date>" string shown on the page. */
    effectiveDate: text('effective_date').notNull(),
    /** admin_accounts.id of the last editor (soft ref, no FK to keep this table standalone). */
    updatedByAdminId: text('updated_by_admin_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appIdx: uniqueIndex('app_privacy_policies_app_idx').on(t.app),
  }),
);
