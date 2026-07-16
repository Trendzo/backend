/**
 * §2 Retailer Onboarding & Lifecycle — schema additions.
 *
 * Existing `retailerAccounts` (in store.ts) and `retailerStores` cover the
 * provisioned account + store. Onboarding adds the *application* lifecycle
 * that precedes provisioning: a public form, document slots, GSTIN/PAN/bank
 * verification checks, and a clarification thread between admin and the
 * applicant.
 */

import { relations, sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  applicationDocumentKind,
  applicationStatus,
  verificationCheckKind,
  verificationCheckStatus,
} from './enums.js';
import { retailerAccounts, retailerStores } from './store.js';

/**
 * Public onboarding application — captured before any account exists. On
 * approval the row is reconciled with a freshly-created `retailerAccounts`
 * record (`retailerAccountId` populated, status flipped to 'approved').
 */
export const retailerApplications = pgTable(
  'retailer_applications',
  {
    id: text('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    storeName: text('store_name'),
    gstin: text('gstin').notNull(),
    pan: text('pan'),
    ownerName: text('owner_name').notNull(),
    ownerEmail: text('owner_email').notNull(),
    ownerPhone: text('owner_phone').notNull(),
    addressLine: text('address_line').notNull(),
    pincode: text('pincode').notNull(),
    stateCode: text('state_code').notNull(),
    lat: text('lat'),
    lng: text('lng'),
    // Hours, categories, brands, sample SKUs land as flexible JSON; rigid
    // structure deferred until the public app form solidifies.
    hours: jsonb('hours').$type<Record<string, unknown>>(),
    categories: jsonb('categories').$type<string[]>(),
    brands: jsonb('brands').$type<string[]>(),
    sampleSkus: jsonb('sample_skus').$type<unknown[]>(),
    contactPhone: text('contact_phone'),
    managerName: text('manager_name'),
    bankLegalName: text('bank_legal_name'),
    bankAccountNumber: text('bank_account_number'),
    bankIfsc: text('bank_ifsc'),
    // Password set by applicant during signup; used when admin provisions the account.
    passwordHash: text('password_hash'),
    // Legal consent given ON THE SIGNUP FORM (T&C + Privacy Policy) — the versions that
    // were current at submit time. Approval seeds retailer_terms_acceptances from these,
    // so the retailer is only re-prompted post-login if a NEWER version shipped since.
    legalConsentAt: timestamp('legal_consent_at', { withTimezone: true, mode: 'date' }),
    consentTermsVersion: text('consent_terms_version'),
    consentPrivacyVersion: text('consent_privacy_version'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    status: applicationStatus('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByAccountId: text('decided_by_account_id'),
    decisionReason: text('decision_reason'),
    // Document kinds the admin flagged as "must be re-uploaded" when rejecting.
    // Cleared on resubmit. Each entry is an `applicationDocumentKind` enum value.
    mustReuploadDocKinds: jsonb('must_reupload_doc_kinds')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Bumped on each retailer resubmission so admins can spot repeat applicants at a glance.
    resubmissionCount: integer('resubmission_count').notNull().default(0),
    // Set when admin approves and we provision a real account.
    provisionedRetailerAccountId: text('provisioned_retailer_account_id').references(
      () => retailerAccounts.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => ({
    statusIdx: uniqueIndex('retailer_applications_status_id_idx').on(t.status, t.id),
  }),
);

export const retailerApplicationsRelations = relations(retailerApplications, ({ many, one }) => ({
  documents: many(applicationDocuments),
  checks: many(applicationVerificationChecks),
  messages: many(applicationMessages),
  provisioned: one(retailerAccounts, {
    fields: [retailerApplications.provisionedRetailerAccountId],
    references: [retailerAccounts.id],
  }),
}));

/**
 * Files uploaded during the application — one row per document slot. Stored
 * as a URL because the bytes live in the upload service / S3-equivalent.
 */
export const applicationDocuments = pgTable('application_documents', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => retailerApplications.id, { onDelete: 'cascade' }),
  kind: applicationDocumentKind('kind').notNull(),
  url: text('url').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  reviewerNote: text('reviewer_note'),
});

export const applicationDocumentsRelations = relations(applicationDocuments, ({ one }) => ({
  application: one(retailerApplications, {
    fields: [applicationDocuments.applicationId],
    references: [retailerApplications.id],
  }),
}));

/**
 * GSTIN/PAN/bank verification outcomes per application. Multiple rows per
 * application as repeated checks land (e.g. failed penny drop → retry).
 */
export const applicationVerificationChecks = pgTable('application_verification_checks', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => retailerApplications.id, { onDelete: 'cascade' }),
  kind: verificationCheckKind('kind').notNull(),
  status: verificationCheckStatus('status').notNull().default('pending'),
  // Free-form provider response payload (GST API JSON, penny-drop result).
  rawResponse: jsonb('raw_response').$type<Record<string, unknown>>(),
  errorCode: text('error_code'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
});

export const applicationVerificationChecksRelations = relations(
  applicationVerificationChecks,
  ({ one }) => ({
    application: one(retailerApplications, {
      fields: [applicationVerificationChecks.applicationId],
      references: [retailerApplications.id],
    }),
  }),
);

/**
 * Clarification thread between admin and applicant. Every reply is one row;
 * thread order is by `at`. The applicant has no account yet, so messages
 * authored by the applicant carry only `applicantEmail` for reply-to.
 */
export const applicationMessages = pgTable('application_messages', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => retailerApplications.id, { onDelete: 'cascade' }),
  // 'admin' or 'applicant' — kept as text not enum so the same table can
  // grow to support automation / system messages later without migration.
  authorKind: text('author_kind').notNull(),
  authorAccountId: text('author_account_id'),
  applicantEmail: text('applicant_email'),
  body: text('body').notNull(),
  attachmentUrls: jsonb('attachment_urls').$type<string[]>(),
  // Optional field/doc this message is about (e.g. 'gstin', 'address', 'pan') so the
  // clarification thread can tag which part of the application the admin is asking about.
  fieldKey: text('field_key'),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const applicationMessagesRelations = relations(applicationMessages, ({ one }) => ({
  application: one(retailerApplications, {
    fields: [applicationMessages.applicationId],
    references: [retailerApplications.id],
  }),
}));

/**
 * Appeal/clarification thread for a suspended or terminated store. Unlike the
 * onboarding thread (pre-account, keyed by application), this is keyed by store —
 * the retailer already has an account and signs in read-only, so they can appeal a
 * suspension/termination and the admin can respond in-band before lifting or upholding.
 */
export const accountAppealMessages = pgTable('account_appeal_messages', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => retailerStores.id, { onDelete: 'cascade' }),
  // 'admin' | 'retailer' | 'system' — text (not enum) for the same forward-compat reason.
  authorKind: text('author_kind').notNull(),
  authorAccountId: text('author_account_id'),
  body: text('body').notNull(),
  attachmentUrls: jsonb('attachment_urls').$type<string[]>(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const accountAppealMessagesRelations = relations(accountAppealMessages, ({ one }) => ({
  store: one(retailerStores, {
    fields: [accountAppealMessages.storeId],
    references: [retailerStores.id],
  }),
}));
