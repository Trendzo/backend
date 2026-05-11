import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  pauseVisibility,
  retailerAccountStatus,
  retailerStoreStatus,
  retailerSubRole,
} from './enums.js';

/**
 * Physical store. Carries platform fee + retailer-set fees (delivery override, handling, convenience)
 * which are bound to the store itself; admin-controlled via Delegation Modes (deferred for MVP).
 */
export const retailerStores = pgTable(
  'retailer_stores',
  {
    id: text('id').primaryKey(),
    legalEntityId: text('legal_entity_id').notNull(),
    legalName: text('legal_name').notNull(),
    gstin: text('gstin').notNull(),
    pan: text('pan'),
    address: text('address').notNull(),
    stateCode: text('state_code').notNull(), // for GST place-of-supply
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    openingHours: jsonb('opening_hours').$type<Record<string, { open: string; close: string }[]>>(),

    status: retailerStoreStatus('status').notNull().default('onboarding'),
    pauseVisibility: pauseVisibility('pause_visibility'),
    pauseReason: text('pause_reason'),
    pauseUntil: timestamp('pause_until', { withTimezone: true, mode: 'date' }),

    platformFeeBp: integer('platform_fee_bp').notNull(), // basis points
    deliveryOverridePaise: integer('delivery_override_paise'),
    handlingFeePaise: integer('handling_fee_paise').notNull().default(0),
    convenienceFeePaise: integer('convenience_fee_paise').notNull().default(0),
    payoutCadenceDays: integer('payout_cadence_days').notNull().default(7),
    delegationModeEnabled: boolean('delegation_mode_enabled').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('retailer_stores_status_idx').on(t.status),
    legalEntityIdx: index('retailer_stores_legal_entity_idx').on(t.legalEntityId),
    // pause_* fields are only meaningful when status='paused' — ERD CONSTRAINTS rule
    pauseGuard: check(
      'retailer_stores_pause_guard',
      sql`${t.status} = 'paused' OR (${t.pauseVisibility} IS NULL AND ${t.pauseReason} IS NULL AND ${t.pauseUntil} IS NULL)`,
    ),
  }),
);

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    accountNumber: text('account_number').notNull(),
    ifsc: text('ifsc').notNull(),
    legalName: text('legal_name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    // Only one default bank account per store. Partial unique index.
    defaultIdx: uniqueIndex('bank_accounts_default_per_store_idx')
      .on(t.storeId)
      .where(sql`${t.isDefault} = true`),
  }),
);

/**
 * Retailer accounts. Colocated with retailer_stores so the FK is a real DB constraint
 * without needing a circular ESM import (identity.ts can't both import from store.ts and
 * export retailer_accounts that store.ts imports back).
 *
 * MVP: signup happens before store creation, so `storeId` is nullable and gets set when
 * the retailer creates their (single) store. KYC is auto-accepted at signup, so `gstin`
 * is captured in the same call — no separate KYC table for MVP.
 */
export const retailerAccounts = pgTable(
  'retailer_accounts',
  {
    id: text('id').primaryKey(),
    // Nullable: account exists before the retailer creates a store. Wired up at store creation.
    storeId: text('store_id').references(() => retailerStores.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(), // bcrypt
    legalName: text('legal_name').notNull(), // owner / contact person legal name
    phone: text('phone').notNull(),
    gstin: text('gstin').notNull(), // captured at signup (KYC auto-accepted in MVP)
    subRole: retailerSubRole('sub_role').notNull().default('owner'),
    status: retailerAccountStatus('status').notNull().default('pending_approval'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('retailer_accounts_email_idx').on(t.email),
  }),
);

// ===== Relations =====

export const retailerStoresRelations = relations(retailerStores, ({ many }) => ({
  accounts: many(retailerAccounts),
  bankAccounts: many(bankAccounts),
}));

export const retailerAccountsRelations = relations(retailerAccounts, ({ one }) => ({
  store: one(retailerStores, {
    fields: [retailerAccounts.storeId],
    references: [retailerStores.id],
  }),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one }) => ({
  store: one(retailerStores, {
    fields: [bankAccounts.storeId],
    references: [retailerStores.id],
  }),
}));
