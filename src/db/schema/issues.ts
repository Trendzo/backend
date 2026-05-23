/**
 * §19 — Unified customer issues (queries, complaints, disputes). One entity, identical behaviour
 * regardless of `kind` (kind is informational only). Replaces the split between supportTickets
 * (queries) and disputes (adjudicated cases) for all new writes.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import {
  actorType,
  awaitingParty,
  disputeDecision,
  disputeStatus,
  issueKind,
  supportSenderType,
} from './enums.js';
import { adminAccounts } from './identity.js';
import { orders } from './orders.js';
import { returns } from './returns.js';
import { retailerStores } from './store.js';

export const customerIssues = pgTable(
  'customer_issues',
  {
    id: text('id').primaryKey(),
    kind: issueKind('kind').notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    orderId: text('order_id').references(() => orders.id),
    returnId: text('return_id').references(() => returns.id),
    openedByActorType: actorType('opened_by_actor_type').notNull(),
    openedByActorId: text('opened_by_actor_id').notNull(),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    evidence: jsonb('evidence').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: disputeStatus('status').notNull().default('open'),
    assignedAdminId: text('assigned_admin_id').references(() => adminAccounts.id),
    awaitingParty: awaitingParty('awaiting_party').notNull().default('admin'),
    decision: disputeDecision('decision'),
    decisionNote: text('decision_note'),
    decidedByAdminId: text('decided_by_admin_id').references(() => adminAccounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    payoutAdjustmentPaise: bigint('payout_adjustment_paise', { mode: 'bigint' }),
    linkedHoldId: text('linked_hold_id'),
    linkedAdjustmentId: text('linked_adjustment_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    storeStatusIdx: index('customer_issues_store_status_idx').on(t.storeId, t.status),
    openerIdx: index('customer_issues_opener_idx').on(t.openedByActorType, t.openedByActorId),
    awaitingIdx: index('customer_issues_awaiting_idx').on(t.awaitingParty),
    orderIdx: index('customer_issues_order_idx').on(t.orderId),
    returnIdx: index('customer_issues_return_idx').on(t.returnId),
    // At least one of (orderId, returnId) must be set.
    targetPresent: check(
      'customer_issues_target_present',
      sql`${t.orderId} IS NOT NULL OR ${t.returnId} IS NOT NULL`,
    ),
    // Decision fields move together.
    decisionGuard: check(
      'customer_issues_decision_guard',
      sql`(${t.status} = 'decided'
            AND ${t.decision} IS NOT NULL
            AND ${t.decidedAt} IS NOT NULL
            AND ${t.decidedByAdminId} IS NOT NULL)
        OR (${t.status} <> 'decided'
            AND ${t.decision} IS NULL
            AND ${t.decidedAt} IS NULL
            AND ${t.decidedByAdminId} IS NULL)`,
    ),
  }),
);

export const customerIssueMessages = pgTable(
  'customer_issue_messages',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => customerIssues.id, { onDelete: 'cascade' }),
    senderType: supportSenderType('sender_type').notNull(),
    senderId: text('sender_id').notNull(),
    body: text('body').notNull(),
    attachments: jsonb('attachments').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    issueAtIdx: index('customer_issue_messages_issue_at_idx').on(t.issueId, t.at),
  }),
);

export const customerIssueTransitions = pgTable(
  'customer_issue_transitions',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => customerIssues.id, { onDelete: 'cascade' }),
    fromStatus: disputeStatus('from_status'),
    toStatus: disputeStatus('to_status').notNull(),
    awaitingPartyTo: awaitingParty('awaiting_party_to'),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    issueAtIdx: index('customer_issue_transitions_issue_at_idx').on(t.issueId, t.at),
  }),
);

export const customerIssuesRelations = relations(customerIssues, ({ one, many }) => ({
  store: one(retailerStores, {
    fields: [customerIssues.storeId],
    references: [retailerStores.id],
  }),
  order: one(orders, {
    fields: [customerIssues.orderId],
    references: [orders.id],
  }),
  return: one(returns, {
    fields: [customerIssues.returnId],
    references: [returns.id],
  }),
  assignedAdmin: one(adminAccounts, {
    fields: [customerIssues.assignedAdminId],
    references: [adminAccounts.id],
  }),
  decidedByAdmin: one(adminAccounts, {
    fields: [customerIssues.decidedByAdminId],
    references: [adminAccounts.id],
  }),
  messages: many(customerIssueMessages),
  transitions: many(customerIssueTransitions),
}));

export const customerIssueMessagesRelations = relations(customerIssueMessages, ({ one }) => ({
  issue: one(customerIssues, {
    fields: [customerIssueMessages.issueId],
    references: [customerIssues.id],
  }),
}));

export const customerIssueTransitionsRelations = relations(customerIssueTransitions, ({ one }) => ({
  issue: one(customerIssues, {
    fields: [customerIssueTransitions.issueId],
    references: [customerIssues.id],
  }),
}));
