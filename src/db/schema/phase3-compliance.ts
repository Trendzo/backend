/**
 * §3 KYC & Compliance — schema additions.
 *
 * Annual KYC re-verification, verified-field change requests, the unified
 * compliance queue (KYC due + floor breaches + change requests + data
 * exports + deletions), policy enforcement ladder, and the GDPR data export
 * + account deletion staging tables. Audit retention policy is intentionally
 * config-driven (lives in `platform_config` rather than its own table).
 */

import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import {
  accountDeletionStatus,
  changeRequestField,
  changeRequestStatus,
  dataExportStatus,
  enforcementBreachKind,
  enforcementStep,
  kycDocumentStatus,
  kycReverificationStatus,
} from './enums.js';
import { consumers } from './identity.js';
import { retailerStores } from './store.js';

/**
 * Annual KYC re-verification cycle. One row per cycle per retailer; the
 * `dueAt` + `gracePeriodEndsAt` decide when the gate flips to overdue.
 */
export const kycReverifications = pgTable('kyc_reverifications', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id, { onDelete: 'cascade' }),
  status: kycReverificationStatus('status').notNull().default('pending'),
  dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
  gracePeriodEndsAt: timestamp('grace_period_ends_at', { withTimezone: true, mode: 'date' })
    .notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  decidedByAccountId: text('decided_by_account_id'),
  decisionReason: text('decision_reason'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
});

export const kycReverificationsRelations = relations(kycReverifications, ({ many, one }) => ({
  documents: many(kycDocuments),
  store: one(retailerStores, {
    fields: [kycReverifications.storeId],
    references: [retailerStores.id],
  }),
}));

export const kycDocuments = pgTable('kyc_documents', {
  id: text('id').primaryKey(),
  reverificationId: text('reverification_id')
    .notNull()
    .references(() => kycReverifications.id, { onDelete: 'cascade' }),
  // 'pan' | 'gstin' | 'address_proof' | 'storefront_photo' | 'bank_proof' | …
  // Free-form key so additions don't require a migration.
  kind: text('kind').notNull(),
  url: text('url'),
  status: kycDocumentStatus('status').notNull().default('missing'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  reviewerNote: text('reviewer_note'),
});

export const kycDocumentsRelations = relations(kycDocuments, ({ one }) => ({
  reverification: one(kycReverifications, {
    fields: [kycDocuments.reverificationId],
    references: [kycReverifications.id],
  }),
}));

/**
 * Verified-field change request. The retailer submits the proposed value;
 * an admin approves or rejects. Approval triggers a downstream update on
 * the corresponding `retailer_accounts` / `retailer_stores` / `bank_accounts`
 * row in the route handler.
 */
export const changeRequests = pgTable('change_requests', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id, { onDelete: 'cascade' }),
  field: changeRequestField('field').notNull(),
  currentValue: text('current_value').notNull(),
  requestedValue: text('requested_value').notNull(),
  status: changeRequestStatus('status').notNull().default('pending'),
  submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  decidedByAccountId: text('decided_by_account_id'),
  decisionNote: text('decision_note'),
  // Supporting attachment (e.g. updated bank passbook scan).
  evidenceUrl: text('evidence_url'),
});

export const changeRequestsRelations = relations(changeRequests, ({ one }) => ({
  store: one(retailerStores, {
    fields: [changeRequests.storeId],
    references: [retailerStores.id],
  }),
}));

/**
 * Policy enforcement ladder per store. One row per ladder step issued; the
 * store's *current* position is the most recent non-`lifted` row.
 */
export const policyEnforcementActions = pgTable('policy_enforcement_actions', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id, { onDelete: 'cascade' }),
  step: enforcementStep('step').notNull(),
  breachKind: enforcementBreachKind('breach_kind').notNull(),
  // Snapshot of the metric value that triggered the step (e.g. acceptance
  // rate dropped to 0.62, floor=0.80). Free JSON so the structure can grow.
  metric: jsonb('metric').$type<Record<string, unknown>>(),
  actedAt: timestamp('acted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  actedByAccountId: text('acted_by_account_id'),
  reason: text('reason'),
  // For 'lifted' rows: which prior step was lifted.
  liftsActionId: text('lifts_action_id'),
});

export const policyEnforcementActionsRelations = relations(
  policyEnforcementActions,
  ({ one }) => ({
    store: one(retailerStores, {
      fields: [policyEnforcementActions.storeId],
      references: [retailerStores.id],
    }),
  }),
);

/**
 * GDPR consumer data export. The build job is async; once complete the
 * `downloadUrl` is set + `expiresAt` ticks down for retention compliance.
 */
export const dataExportRequests = pgTable('data_export_requests', {
  id: text('id').primaryKey(),
  consumerId: text('consumer_id')
    .notNull()
    .references(() => consumers.id, { onDelete: 'cascade' }),
  status: dataExportStatus('status').notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true, mode: 'date' }),
  downloadUrl: text('download_url'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  failureReason: text('failure_reason'),
});

export const dataExportRequestsRelations = relations(dataExportRequests, ({ one }) => ({
  consumer: one(consumers, {
    fields: [dataExportRequests.consumerId],
    references: [consumers.id],
  }),
}));

/**
 * Consumer-initiated account deletion. Honoured after the configured grace
 * window (`scheduledFor`) unless the consumer cancels. Wallet escheat fires
 * inside the same job that flips status to 'completed'.
 */
export const accountDeletionRequests = pgTable('account_deletion_requests', {
  id: text('id').primaryKey(),
  consumerId: text('consumer_id')
    .notNull()
    .references(() => consumers.id, { onDelete: 'cascade' }),
  status: accountDeletionStatus('status').notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  reason: text('reason'),
});

export const accountDeletionRequestsRelations = relations(accountDeletionRequests, ({ one }) => ({
  consumer: one(consumers, {
    fields: [accountDeletionRequests.consumerId],
    references: [consumers.id],
  }),
}));
