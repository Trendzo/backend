import { relations, sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  actorType,
  agentDisposition,
  disputeDecision,
  disputeStatus,
  heldItemDisposition,
  heldItemStatus,
  orderItemOutcome,
  returnKind,
  returnReasonCategory,
  storeReturnDecision,
} from './enums.js';
import { adminAccounts, consumers } from './identity.js';
import { orderItems, orders } from './orders.js';
import { retailerStores } from './store.js';


/**
 * A returned item record. Created either at door (Try-and-Buy) or post-delivery (standard
 * return window). Per spec, refund eligibility/amount is computed downstream — this row
 * just captures the return event itself.
 */
export const returns = pgTable(
  'returns',
  {
    id: text('id').primaryKey(),
    orderItemId: text('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    kind: returnKind('kind').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    reasonText: text('reason_text'),
    // Categorical reason (post-delivery standard returns). Null for door returns.
    reasonCategory: returnReasonCategory('reason_category'),
    photos: jsonb('photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Consumer-submitted photo URLs for standard (post-delivery) returns.
    consumerPhotos: jsonb('consumer_photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Store-side evidence photos uploaded by the retailer when rejecting a return.
    // Empty until storeDecision = 'rejected' and the retailer chooses to attach evidence.
    storeRejectPhotos: jsonb('store_reject_photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    // Door-return only: agent's call at the door
    agentDisposition: agentDisposition('agent_disposition'),

    // Store verification (door-returns and rejected post-delivery returns)
    storeDecision: storeReturnDecision('store_decision').notNull().default('pending'),
    storeDecidedAt: timestamp('store_decided_at', { withTimezone: true, mode: 'date' }),
    /**
     * CUSTODY — the goods are physically at the store, right now.
     *
     * Split out from `verificationWindowExpiresAt`, which used to mean both "the goods
     * arrived" and "the decision clock is running". As one nullable column, a return
     * with no clock looked identical to a return with no goods, so every sweep keyed
     * off it was blind to both: an uncollected pickup stranded the refund forever, and
     * a store could accept + restock + refund goods still in the customer's house.
     */
    goodsReceivedAt: timestamp('goods_received_at', { withTimezone: true, mode: 'date' }),
    /** DEADLINE — the store's decision clock. Only ever set together with custody. */
    verificationWindowExpiresAt: timestamp('verification_window_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** The item's outcome before the return opened, so a withdrawal restores the truth. */
    priorItemOutcome: orderItemOutcome('prior_item_outcome'),
    /** One-shot dedupe for the accepted-but-unrefunded watchdog alert. */
    stuckAlertNotifiedAt: timestamp('stuck_alert_notified_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (t) => ({
    orderItemIdx: index('returns_order_item_idx').on(t.orderItemId),
    storeDecisionIdx: index('returns_store_decision_idx').on(t.storeDecision),
    /**
     * At most one OPEN return per order item. This is the real serializer for two
     * concurrent openReturn calls: the second INSERT blocks on the uncommitted index
     * tuple and then raises 23505, so no snapshot race can produce two returns — and
     * therefore two refunds — for one item.
     */
    openPerOrderItemUniq: uniqueIndex('returns_open_per_order_item_uniq')
      .on(t.orderItemId)
      .where(sql`${t.storeDecision} = 'pending'`),
    verifyWindowSweepIdx: index('returns_verify_window_sweep_idx')
      .on(t.verificationWindowExpiresAt)
      .where(sql`${t.storeDecision} = 'pending' AND ${t.goodsReceivedAt} IS NOT NULL`),
    strandedSweepIdx: index('returns_stranded_sweep_idx')
      .on(t.openedAt)
      .where(sql`${t.storeDecision} = 'pending' AND ${t.goodsReceivedAt} IS NULL`),
    acceptedSweepIdx: index('returns_accepted_sweep_idx')
      .on(t.storeDecidedAt)
      .where(sql`${t.storeDecision} = 'accepted' AND ${t.stuckAlertNotifiedAt} IS NULL`),
    // A decision clock may only run once custody is a fact.
    windowRequiresCustodyGuard: check(
      'returns_window_requires_custody_guard',
      sql`${t.verificationWindowExpiresAt} IS NULL OR ${t.goodsReceivedAt} IS NOT NULL`,
    ),
    // Door returns must record the agent's call; standard returns leave the field NULL.
    doorAgentDispositionGuard: check(
      'returns_door_agent_disposition_guard',
      sql`${t.kind} <> 'door_return' OR ${t.agentDisposition} IS NOT NULL`,
    ),
    // Once the store has decided, the decision timestamp must be set.
    storeDecidedAtGuard: check(
      'returns_store_decided_at_guard',
      sql`${t.storeDecision} = 'pending' OR ${t.storeDecidedAt} IS NOT NULL`,
    ),
  }),
);

/**
 * Created when the store rejects a return on verification. Lifecycle:
 *  holding → resolved (consumer claimed/redelivered) | expired (window ran out)
 *
 * Carries denormalised store_id + consumer_id so the retailer's "held items" dashboard and
 * the consumer's "items at store" view can each filter without joining through return →
 * order_item → order.
 */
export const heldItems = pgTable(
  'held_items',
  {
    id: text('id').primaryKey(),
    returnId: text('return_id')
      .notNull()
      .references(() => returns.id),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    status: heldItemStatus('status').notNull().default('holding'),
    disposition: heldItemDisposition('disposition'),
    holdingWindowExpiresAt: timestamp('holding_window_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    extendedByAdminId: text('extended_by_admin_id').references(() => adminAccounts.id),
    extensionReason: text('extension_reason'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    // Set by the pre-expiry warning sweep so we never double-notify. Reset to NULL when
    // an admin extends the holding window so the new threshold gets a fresh warning.
    warningNotifiedAt: timestamp('warning_notified_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    storeStatusExpiryIdx: index('held_items_store_status_expiry_idx').on(
      t.storeId,
      t.status,
      t.holdingWindowExpiresAt,
    ),
    consumerStatusIdx: index('held_items_consumer_status_idx').on(t.consumerId, t.status),
    returnIdx: index('held_items_return_idx').on(t.returnId),
    warningSweepIdx: index('held_items_warning_sweep_idx')
      .on(t.status, t.holdingWindowExpiresAt)
      .where(sql`${t.warningNotifiedAt} IS NULL`),
    // Resolved held-items must capture how they were disposed and when.
    resolvedGuard: check(
      'held_items_resolved_guard',
      sql`${t.status} <> 'resolved' OR (${t.disposition} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * A formal disagreement about an order or a return (per spec §"Disputes"). Targets exactly
 * one of the two via XOR — order-level disputes (e.g. delivery refused) carry orderId;
 * return-level disputes (e.g. store rejected the return) carry returnId. Admin decides;
 * the financial side-effects are applied automatically by the disputes module (Phase 14).
 */
export const disputes = pgTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').references(() => orders.id),
    returnId: text('return_id').references(() => returns.id),
    openedByActorType: actorType('opened_by_actor_type').notNull(),
    openedByActorId: text('opened_by_actor_id').notNull(), // polymorphic
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    description: text('description').notNull(),
    evidence: jsonb('evidence').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: disputeStatus('status').notNull().default('open'),
    decision: disputeDecision('decision'),
    decisionNote: text('decision_note'),
    decidedByAdminId: text('decided_by_admin_id').references(() => adminAccounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    orderIdx: index('disputes_order_idx').on(t.orderId),
    returnIdx: index('disputes_return_idx').on(t.returnId),
    statusIdx: index('disputes_status_idx').on(t.status),
    // ERD CONSTRAINT: dispute targets exactly one of (order, return)
    targetXor: check(
      'disputes_target_xor',
      sql`(${t.orderId} IS NULL) <> (${t.returnId} IS NULL)`,
    ),
    // Decided disputes must carry decision + admin + timestamp; non-decided must not.
    decisionGuard: check(
      'disputes_decision_guard',
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

// ===== Relations =====

export const returnsRelations = relations(returns, ({ one, many }) => ({
  orderItem: one(orderItems, {
    fields: [returns.orderItemId],
    references: [orderItems.id],
  }),
  heldItems: many(heldItems),
  disputes: many(disputes),
}));

export const heldItemsRelations = relations(heldItems, ({ one }) => ({
  return: one(returns, {
    fields: [heldItems.returnId],
    references: [returns.id],
  }),
  store: one(retailerStores, {
    fields: [heldItems.storeId],
    references: [retailerStores.id],
  }),
  consumer: one(consumers, {
    fields: [heldItems.consumerId],
    references: [consumers.id],
  }),
}));

export const disputesRelations = relations(disputes, ({ one }) => ({
  order: one(orders, {
    fields: [disputes.orderId],
    references: [orders.id],
  }),
  return: one(returns, {
    fields: [disputes.returnId],
    references: [returns.id],
  }),
}));
