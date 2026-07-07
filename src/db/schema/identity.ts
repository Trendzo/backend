import { relations } from 'drizzle-orm';
import { doublePrecision, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
    // email/name/passwordHash are nullable: phone-OTP signups start with only a verified
    // phone and fill name/email in later (required before placing an order — snapshots
    // need them). passwordHash stays null for OTP-only consumers.
    email: text('email'),
    phone: text('phone').notNull(),
    name: text('name'),
    passwordHash: text('password_hash'), // bcrypt
    // Optional profile photo, surfaced on community/reels author chips. Nullable —
    // the consumer app falls back to a generated placeholder when absent.
    avatarUrl: text('avatar_url'),

    // Drives the consumer-app HER/HIM home-feed swap. Nullable until the user picks one;
    // the existing `gender` enum (her|him|unisex) is reused — `unisex` reads as "show all".
    genderPreference: gender('gender_preference'),
    // Per-consumer share code for referrals (derived from id at creation; unique).
    referralCode: text('referral_code'),
    signupAt: timestamp('signup_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: consumerStatus('status').notNull().default('active'),
  },
  (t) => ({
    emailIdx: uniqueIndex('consumers_email_idx').on(t.email),
    phoneIdx: uniqueIndex('consumers_phone_idx').on(t.phone),
    referralCodeIdx: uniqueIndex('consumers_referral_code_idx').on(t.referralCode),
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

/**
 * Standalone delivery-driver identity. A driver is its OWN account (JWT `kind:'driver'`,
 * phone-OTP find-or-create, instant-active) — NOT a retailer sub-role. `name` is nullable
 * because an OTP-only signup starts with just a verified phone (mirrors `consumers.name`);
 * the profile (name/vehicle/docs) is filled in later. Orders are assigned to a driver via
 * the admin dispatch desk (`orders.assigned_agent_id` FKs this table).
 */
export const deliveryAgents = pgTable(
  'delivery_agents',
  {
    id: text('id').primaryKey(),
    phone: text('phone').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    vehicleType: text('vehicle_type'),
    vehicleNumber: text('vehicle_number'),
    city: text('city'),
    licenceDocUrl: text('licence_doc_url'),
    rcDocUrl: text('rc_doc_url'),
    insuranceDocUrl: text('insurance_doc_url'),
    // Last-known location (single point, refreshed by the driver-app ping; not a track).
    currentLat: doublePrecision('current_lat'),
    currentLng: doublePrecision('current_lng'),
    lastLocationAt: timestamp('last_location_at', { withTimezone: true, mode: 'date' }),
    status: deliveryAgentStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    phoneIdx: uniqueIndex('delivery_agents_phone_idx').on(t.phone),
  }),
);

// retailer_accounts lives in store.ts (alongside retailer_stores) — colocated to give
// the table a real DB-level FK to retailer_stores without an ESM circular import.

export const consumersRelations = relations(consumers, () => ({}));
export const adminAccountsRelations = relations(adminAccounts, () => ({}));
export const deliveryAgentsRelations = relations(deliveryAgents, () => ({}));
