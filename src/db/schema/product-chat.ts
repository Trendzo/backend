import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { retailerAccounts, retailerStores } from './store.js';
import { productListings } from './products.js';
import { bulkMockupJobs } from './bulk-mockups.js';

export type ProductChatMessage = { role: 'user' | 'assistant'; text: string; at: string };

export const productChatSessions = pgTable('product_chat_sessions', {
  id: text('id').primaryKey(),
  retailerId: text('retailer_id').notNull().references(() => retailerAccounts.id),
  storeId: text('store_id').notNull().references(() => retailerStores.id),
  listingId: text('listing_id').references(() => productListings.id, { onDelete: 'set null' }),
  mockupJobId: text('mockup_job_id').references(() => bulkMockupJobs.id, { onDelete: 'set null' }),
  messages: jsonb('messages').$type<ProductChatMessage[]>().notNull().default([]),
  // Set while a chat turn is running (extract -> save). A short lease, not a row lock, so no
  // DB connection is held across the model call; expires on its own if the server dies mid-turn.
  turnLockedUntil: timestamp('turn_locked_until', { withTimezone: true, mode: 'date' }),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, table => ({ ownerIdx: index('product_chat_sessions_owner_idx').on(table.retailerId, table.updatedAt) }));
