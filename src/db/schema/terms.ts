import { relations, sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { retailerStores } from './store.js';

/**
 * Admin-published Retailer Terms versions. Each admin edit inserts a new row; the
 * CURRENT terms = the most recently created row (`createdAt` desc). Acceptances/declines
 * key on the version string (`retailer_terms.id`, or the bootstrap constant when no row exists).
 */
export const retailerTerms = pgTable('retailer_terms', {
  id: text('id').primaryKey(),
  label: text('label').notNull(), // human version label, e.g. "v3" / a date
  shortText: text('short_text').notNull(),
  createdByAdminId: text('created_by_admin_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * Per-version accept/decline decisions — the legal audit trail. One accepted row per
 * (store, version) (partial unique index); declines are appended freely (a retailer can
 * decline repeatedly). `ipAddress` + `userAgent` + `decidedAt` capture the event.
 */
export const retailerTermsAcceptances = pgTable(
  'retailer_terms_acceptances',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    acceptedByAccountId: text('accepted_by_account_id').notNull(),
    termsVersion: text('terms_version').notNull(),
    decision: text('decision').notNull().default('accepted'), // 'accepted' | 'declined'
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One ACCEPT per (store, version); declines are unconstrained (append-only log).
    acceptedIdx: uniqueIndex('retailer_terms_acceptances_store_version_idx')
      .on(t.storeId, t.termsVersion)
      .where(sql`${t.decision} = 'accepted'`),
  }),
);

export const retailerTermsAcceptancesRelations = relations(retailerTermsAcceptances, ({ one }) => ({
  store: one(retailerStores, {
    fields: [retailerTermsAcceptances.storeId],
    references: [retailerStores.id],
  }),
}));
