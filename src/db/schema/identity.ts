import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  adminAccountStatus,
  adminSubRole,
  consumerStatus,
  deliveryAgentStatus,
  gender,
} from './enums.js';

/**
 * Three completely separate identity domains plus a placeholder for delivery agents.
 * Same email can exist across domains; within a domain, email is unique.
 */

export const consumers = pgTable(
  'consumers',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(), // bcrypt
    // Drives the consumer-app HER/HIM home-feed swap. Nullable until the user picks one;
    // the existing `gender` enum (her|him|unisex) is reused — `unisex` reads as "show all".
    genderPreference: gender('gender_preference'),
    signupAt: timestamp('signup_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: consumerStatus('status').notNull().default('active'),
  },
  (t) => ({
    emailIdx: uniqueIndex('consumers_email_idx').on(t.email),
    phoneIdx: uniqueIndex('consumers_phone_idx').on(t.phone),
  }),
);

export const adminAccounts = pgTable(
  'admin_accounts',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(), // bcrypt
    subRole: adminSubRole('sub_role').notNull(),
    status: adminAccountStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('admin_accounts_email_idx').on(t.email),
  }),
);

export const deliveryAgents = pgTable('delivery_agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  status: deliveryAgentStatus('status').notNull().default('active'),
});

// retailer_accounts lives in store.ts (alongside retailer_stores) — colocated to give
// the table a real DB-level FK to retailer_stores without an ESM circular import.

export const consumersRelations = relations(consumers, () => ({}));
export const adminAccountsRelations = relations(adminAccounts, () => ({}));
export const deliveryAgentsRelations = relations(deliveryAgents, () => ({}));
