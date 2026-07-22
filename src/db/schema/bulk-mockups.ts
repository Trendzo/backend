import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { aiCatalogMode, bulkMockupStatus } from './enums.js';
import { retailerStores } from './store.js';

/**
 * Bulk-mockup generation queue (beta). Each row is one queued generation job for
 * a retailer's product photos. A background claim-worker (FOR UPDATE SKIP LOCKED)
 * picks `queued` jobs, generates the multi-angle set via the shared AI pipeline,
 * and stores the resulting URLs in `outputUrls`. Distinct from `ai_catalog_submissions`
 * (the synchronous flow) — this is the async, non-blocking path.
 */
export const bulkMockupJobs = pgTable(
  'bulk_mockup_jobs',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id, { onDelete: 'cascade' }),
    mode: aiCatalogMode('mode').notNull(),
    prompt: text('prompt'),
    // Full generation input (apparel/back/design/pattern/logo/tag URLs + `only`),
    // shaped like the shared GenerateViewsInput — the worker feeds it straight in.
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    referenceImageUrls: jsonb('reference_image_urls').$type<string[]>().notNull().default([]),
    outputUrls: jsonb('output_urls').$type<string[]>().notNull().default([]),
    status: bulkMockupStatus('status').notNull().default('queued'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    storeStatusIdx: index('bulk_mockup_jobs_store_status_idx').on(t.storeId, t.status, t.createdAt),
  }),
);

export const bulkMockupJobsRelations = relations(bulkMockupJobs, ({ one }) => ({
  store: one(retailerStores, {
    fields: [bulkMockupJobs.storeId],
    references: [retailerStores.id],
  }),
}));
