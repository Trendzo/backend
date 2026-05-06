import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { adminAccounts } from './identity.js';

/**
 * Tunable platform constants. One row per knob; value is JSONB to accommodate scalars,
 * tables, and per-method maps (see PRODUCT_SPEC §"Seed Data" for the 26 default keys).
 *
 * Audit columns (`prior_value`, `last_changed_admin_id`, `last_changed_at`) let the admin
 * UI render an edit history without a separate audit table for this entity.
 */
export const platformConfig = pgTable('platform_config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  priorValue: jsonb('prior_value'),
  lastChangedAdminId: text('last_changed_admin_id').references(() => adminAccounts.id),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

// ===== Relations =====

export const platformConfigRelations = relations(platformConfig, ({ one }) => ({
  lastChangedBy: one(adminAccounts, {
    fields: [platformConfig.lastChangedAdminId],
    references: [adminAccounts.id],
  }),
}));
