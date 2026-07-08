import { desc, relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  actorType,
  deliveryAttemptOutcome,
  deliveryMethod,
  listingPolicy,
  orderGroupStatus,
  orderItemOutcome,
  orderStatus,
  paymentMethod,
  paymentStatus,
  taxSplitKind,
} from './enums.js';
import { consumers, deliveryAgents } from './identity.js';
import { retailerStores } from './store.js';
import { productListings, variants } from './products.js';

/**
 * Saved consumer addresses. Used as the source for an order's address_*_snap fields at
 * placement time; deletion of an address never affects placed orders.
 */
export const addresses = pgTable(
  'addresses',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    label: text('label'), // e.g. "home", "office"
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    pincode: text('pincode').notNull(),
    stateCode: text('state_code').notNull(), // for GST place-of-supply on the order
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerIdx: index('addresses_consumer_idx').on(t.consumerId),
    // At most one default address per consumer.
    consumerDefaultIdx: uniqueIndex('addresses_consumer_default_idx')
      .on(t.consumerId)
      .where(sql`${t.isDefault} = true`),
  }),
);

/**
 * Order group: rollup over the per-store orders that came out of one checkout. Even
 * single-store checkouts get a group of one — keeps the consumer-facing view uniform.
 */
export const orderGroups = pgTable(
  'order_groups',
  {
    id: text('id').primaryKey(),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    status: orderGroupStatus('status').notNull().default('in_flight'),
    // Sum of child orders' grandTotalPaise. Written at placement; future multi-store
    // checkouts (one group → N orders across stores) aggregate here so consumers see
    // a single combined total without recomputing on read.
    combinedTotalPaise: integer('combined_total_paise').notNull().default(0),
    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    consumerIdx: index('order_groups_consumer_idx').on(t.consumerId),
  }),
);

/**
 * One order per (group, fulfilling store). Carries the full snapshot bag so the order
 * is self-contained even after upstream entities mutate or get scrubbed.
 *
 * PII fields (consumer_*_snap) are scrubbed by the PII helper on consumer deletion;
 * non-PII snaps (store_*_snap, address_*_snap city/pincode/etc.) remain intact.
 * Invoice PII is held separately on the invoice row (legal hold) and is NOT touched.
 */
export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => orderGroups.id),
    consumerId: text('consumer_id')
      .notNull()
      .references(() => consumers.id),
    storeId: text('store_id')
      .notNull()
      .references(() => retailerStores.id),
    addressId: text('address_id').references(() => addresses.id), // nullable for pickup
    // §9 — the standalone delivery driver (`delivery_agents` row) assigned to deliver
    // this order by the admin dispatch desk. Nullable: unassigned, pickup, or an
    // external courier recorded only by name/phone snapshot in the handover marker.
    assignedAgentId: text('assigned_agent_id').references(() => deliveryAgents.id),
    deliveryMethod: deliveryMethod('delivery_method').notNull(),
    paymentMethod: paymentMethod('payment_method').notNull(),
    paymentMethodLabel: text('payment_method_label').notNull(), // human-readable snap, e.g. "UPI · GPay"
    status: orderStatus('status').notNull().default('pending'),

    // Consumer PII snapshot (scrubbed on account deletion → pii_scrubbed_at set)
    consumerNameSnap: text('consumer_name_snap').notNull(),
    consumerEmailSnap: text('consumer_email_snap').notNull(),
    consumerPhoneSnap: text('consumer_phone_snap').notNull(),

    // Address snapshot (line1/line2 are PII-adjacent; city/pincode/state/lat/lng survive scrub)
    addressLine1Snap: text('address_line1_snap'),
    addressLine2Snap: text('address_line2_snap'),
    addressCitySnap: text('address_city_snap'),
    addressPincodeSnap: text('address_pincode_snap'),
    addressStateCodeSnap: text('address_state_code_snap'), // place-of-supply for GST
    addressLatSnap: doublePrecision('address_lat_snap'),
    addressLngSnap: doublePrecision('address_lng_snap'),

    // Store snapshot — non-PII, never scrubbed
    storeNameSnap: text('store_name_snap').notNull(),
    storeAddressSnap: text('store_address_snap').notNull(),
    storeGstinSnap: text('store_gstin_snap').notNull(),
    storeStateCodeSnap: text('store_state_code_snap').notNull(),

    // Pricing snapshot (paise; per spec layered formula)
    itemsSubtotalPaise: integer('items_subtotal_paise').notNull(),
    retailerPromoPaise: integer('retailer_promo_paise').notNull().default(0),
    platformPromoPaise: integer('platform_promo_paise').notNull().default(0),
    couponPaise: integer('coupon_paise').notNull().default(0),
    pointsRedeemedPaise: integer('points_redeemed_paise').notNull().default(0),
    walletAppliedPaise: integer('wallet_applied_paise').notNull().default(0),
    taxPaise: integer('tax_paise').notNull(),
    taxSplitKind: taxSplitKind('tax_split_kind').notNull(),
    cgstPaise: integer('cgst_paise').notNull().default(0),
    sgstPaise: integer('sgst_paise').notNull().default(0),
    igstPaise: integer('igst_paise').notNull().default(0),
    deliveryFeePaise: integer('delivery_fee_paise').notNull().default(0),
    handlingFeePaise: integer('handling_fee_paise').notNull().default(0),
    convenienceFeePaise: integer('convenience_fee_paise').notNull().default(0),
    grandTotalPaise: integer('grand_total_paise').notNull(),

    // Platform fee captured at placement (basis points snap)
    platformFeeBpSnap: integer('platform_fee_bp_snap').notNull(),
    // TCS rate captured at placement so invoices generated later remain reproducible if
    // the platform_config tcs_rate_bp value is edited. Default exists only so the ALTER
    // backfills cleanly — place-order always supplies the live rate.
    tcsRateBpSnap: integer('tcs_rate_bp_snap').notNull().default(100),
    // §12 F3b — admin per-order platform-fee override. Recorded + audited here so the
    // decision is captured even before settlement math reads it. Zero = no override
    // (default fall-through to platformFeeBpSnap-derived amount).
    platformFeeOverridePaise: integer('platform_fee_override_paise').notNull().default(0),
    platformFeeOverrideReason: text('platform_fee_override_reason'),

    // §14 L3 — loyalty points credited on delivery. Set once when the order transitions to
    // 'delivered' (idempotent — re-transition is a no-op). Refund credit-back math reads this
    // to claw back the earned portion for the refunded items.
    loyaltyEarnedPoints: integer('loyalty_earned_points').notNull().default(0),

    // Cash physically collected by the driver at a COD delivery (paise). 0 for prepaid
    // or until collected. Feeds the driver's cash-to-deposit balance.
    codCollectedPaise: integer('cod_collected_paise').notNull().default(0),

    // Consumer-facing handover code for pickup orders only. Generated at placement,
    // verified at the store front during the consumer pickup handover.
    pickupCode: text('pickup_code'),
    // Consumer-facing delivery OTP for door deliveries (express/standard/try-and-buy).
    // Generated at placement; the consumer reads it to the agent who supplies it on
    // door close — proof the handover reached the right person.
    deliveryOtp: text('delivery_otp'),
    // Store→agent handoff code. Generated when the retailer assigns an in-house
    // delivery agent to a packed order; shown ONLY in the assigned agent's app. The
    // retailer verifies it (reading it off the agent's screen) at the physical
    // handover to prove the right agent collected the parcel. Cleared on pickup.
    agentHandoffCode: text('agent_handoff_code'),
    // §9 — pickup orders carry a snap of the consumer-selected slot so config edits
    // on `store_pickup_slots` don't drift the order. NULL on non-pickup orders.
    pickupSlotId: text('pickup_slot_id'),
    pickupSlotStart: timestamp('pickup_slot_start', { withTimezone: true, mode: 'date' }),
    pickupSlotEnd: timestamp('pickup_slot_end', { withTimezone: true, mode: 'date' }),
    // §9 — try-and-buy try-on window. Set by openDoor(), bumped by extendDoor().
    // extended_at acts as the one-shot guard (non-null = extension consumed).
    doorWindowExpiresAt: timestamp('door_window_expires_at', { withTimezone: true, mode: 'date' }),
    doorWindowExtendedAt: timestamp('door_window_extended_at', { withTimezone: true, mode: 'date' }),

    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    // Stamped by transitionOrder on →packed; drives the dispatch-rot + pickup-no-show sweeps.
    packedAt: timestamp('packed_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    piiScrubbedAt: timestamp('pii_scrubbed_at', { withTimezone: true, mode: 'date' }),
    // When the current driver claimed/was assigned this order (cleared on unassign).
    // Drives the stale-claim auto-unassign sweep.
    agentAssignedAt: timestamp('agent_assigned_at', { withTimezone: true, mode: 'date' }),
    // One-shot dedupe for the "packed order unassigned too long" admin alert.
    dispatchAlertNotifiedAt: timestamp('dispatch_alert_notified_at', {
      withTimezone: true,
      mode: 'date',
    }),

    // Routing dispatcher fields (§8). Set when dispatchOrder() runs at placement;
    // rerouteOrder() updates routingAttempts + appends to routingHistory.
    acceptanceDeadlineAt: timestamp('acceptance_deadline_at', { withTimezone: true, mode: 'date' }),
    routingAttempts: integer('routing_attempts').notNull().default(0),
    routingHistory: jsonb('routing_history')
      .$type<Array<{ candidateStoreId: string; decidedAt: string; decision: 'accepted' | 'rejected' | 'timeout' | 'pending'; reason?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Promo ids voided after a partial-return recompute. Read by snapshot diff.
    promoVoidedAfterReturn: jsonb('promo_voided_after_return')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => ({
    storeStatusPlacedIdx: index('orders_store_status_placed_idx').on(
      t.storeId,
      t.status,
      t.placedAt,
    ),
    consumerPlacedIdx: index('orders_consumer_placed_idx').on(t.consumerId, desc(t.placedAt)),
    groupIdx: index('orders_group_idx').on(t.groupId),
    idempotencyIdx: uniqueIndex('orders_idempotency_idx').on(t.idempotencyKey),
    // Pickup is the only delivery method that may omit an address (consumer collects in-store).
    addressPresenceGuard: check(
      'orders_address_presence_guard',
      sql`${t.addressId} IS NOT NULL OR ${t.deliveryMethod} = 'pickup'`,
    ),
    // Delivered orders must record when delivery completed.
    deliveredAtGuard: check(
      'orders_delivered_at_guard',
      sql`${t.status} <> 'delivered' OR ${t.deliveredAt} IS NOT NULL`,
    ),
    // GST split must match jurisdiction: intra-state collects CGST+SGST; inter-state collects IGST.
    gstSplitGuard: check(
      'orders_gst_split_guard',
      sql`(${t.taxSplitKind} = 'intra_state'
            AND ${t.igstPaise} = 0
            AND ${t.cgstPaise} + ${t.sgstPaise} = ${t.taxPaise})
        OR (${t.taxSplitKind} = 'inter_state'
            AND ${t.cgstPaise} = 0
            AND ${t.sgstPaise} = 0
            AND ${t.igstPaise} = ${t.taxPaise})`,
    ),
    // pickup_code is only meaningful for pickup orders.
    pickupCodeMethodGuard: check(
      'orders_pickup_code_method_guard',
      sql`${t.pickupCode} IS NULL OR ${t.deliveryMethod} = 'pickup'`,
    ),
    // delivery_otp is only meaningful for door deliveries.
    deliveryOtpMethodGuard: check(
      'orders_delivery_otp_method_guard',
      sql`${t.deliveryOtp} IS NULL OR ${t.deliveryMethod} <> 'pickup'`,
    ),
    // pickup_slot_* is only meaningful for pickup orders.
    pickupSlotMethodGuard: check(
      'orders_pickup_slot_method_guard',
      sql`${t.pickupSlotStart} IS NULL OR ${t.deliveryMethod} = 'pickup'`,
    ),
    // Collision-free pickup code while the order is still active. Once delivered/cancelled/closed
    // the code is free to reuse for a fresh pickup.
    pickupCodeActiveIdx: uniqueIndex('orders_pickup_code_active_idx')
      .on(t.storeId, t.pickupCode)
      .where(sql`${t.pickupCode} IS NOT NULL AND ${t.status} NOT IN ('cancelled','delivered','closed')`),
    // Lifecycle-sweep scans: packed orders by age, and stale unpaid orders.
    packedSweepIdx: index('orders_packed_sweep_idx')
      .on(t.packedAt)
      .where(sql`${t.status} = 'packed'`),
    paymentSweepIdx: index('orders_payment_sweep_idx')
      .on(t.placedAt)
      .where(sql`${t.status} IN ('pending','payment_failed')`),
  }),
);

/**
 * One row per (order, variant). Carries listing/variant snapshots so renames or price
 * edits never alter what the consumer sees on a placed order.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    listingId: text('listing_id')
      .notNull()
      .references(() => productListings.id),
    variantId: text('variant_id')
      .notNull()
      .references(() => variants.id),

    // Listing/variant snapshot
    listingNameSnap: text('listing_name_snap').notNull(),
    brandSnap: text('brand_snap').notNull(),
    categorySnap: text('category_snap').notNull(),
    hsnSnap: text('hsn_snap'),
    galleryImageSnap: text('gallery_image_snap'),
    attributesLabelSnap: text('attributes_label_snap').notNull(), // "M / Black"
    listingPolicySnap: listingPolicy('listing_policy_snap').notNull(),

    // Per-item pricing breakdown (paise)
    qty: integer('qty').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    lineSubtotalPaise: integer('line_subtotal_paise').notNull(),
    retailerPromoAllocPaise: integer('retailer_promo_alloc_paise').notNull().default(0),
    platformPromoAllocPaise: integer('platform_promo_alloc_paise').notNull().default(0),
    couponAllocPaise: integer('coupon_alloc_paise').notNull().default(0),
    pointsAllocPaise: integer('points_alloc_paise').notNull().default(0),
    gstRateBp: integer('gst_rate_bp').notNull(), // 500 = 5%, 1200 = 12%, 1800 = 18%
    gstAllocPaise: integer('gst_alloc_paise').notNull(),
    netLinePaise: integer('net_line_paise').notNull(), // after discounts + tax

    outcome: orderItemOutcome('outcome').notNull().default('pending_delivery'),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
    variantIdx: index('order_items_variant_idx').on(t.variantId),
    qtyPriceGuard: check(
      'order_items_qty_price_guard',
      sql`${t.qty} > 0 AND ${t.unitPricePaise} > 0`,
    ),
  }),
);

/**
 * Append-only audit log for every order status change. `actorId` is polymorphic
 * (interpreted via actorType), so no FK — system actor uses 'system' literal.
 */
export const orderTransitions = pgTable(
  'order_transitions',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    fromStatus: orderStatus('from_status'), // null on initial 'pending'
    toStatus: orderStatus('to_status').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(), // polymorphic; 'system' for scheduler
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    orderAtIdx: index('order_transitions_order_at_idx').on(t.orderId, t.at),
  }),
);

/**
 * Payment attempt against an order. `previousPaymentId` chains retries — a 'failed' attempt
 * followed by a fresh attempt forms the retry chain. `superseded` is set when a late callback
 * resolves a previous attempt that the user had already abandoned in favour of a newer one.
 */
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    method: paymentMethod('method').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    gatewayRef: text('gateway_ref'), // razorpay payment id (set on capture)
    // Razorpay Order id created at placement — the verify endpoint / webhook joins
    // on this to settle the pending row(s). Group checkouts share one across children.
    gatewayOrderId: text('gateway_order_id'),
    previousPaymentId: text('previous_payment_id'), // self-ref for retry chain
    idempotencyKey: text('idempotency_key').notNull(),
    initiatedAt: timestamp('initiated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    // §15 PC2 — capture-failure outreach + inventory release bookkeeping. These are
    // pure admin-action ledgers; set on the failing payment once ops triages it.
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    consumerNotifiedAt: timestamp('consumer_notified_at', { withTimezone: true, mode: 'date' }),
    consumerNotifiedByAdminId: text('consumer_notified_by_admin_id'),
    inventoryReleasedAt: timestamp('inventory_released_at', { withTimezone: true, mode: 'date' }),
    inventoryReleasedByAdminId: text('inventory_released_by_admin_id'),
  },
  (t) => ({
    orderStatusIdx: index('payments_order_status_idx').on(t.orderId, t.status),
    idempotencyIdx: uniqueIndex('payments_idempotency_idx').on(t.idempotencyKey),
    gatewayOrderIdx: index('payments_gateway_order_idx')
      .on(t.gatewayOrderId)
      .where(sql`${t.gatewayOrderId} IS NOT NULL`),
    previousPaymentFk: foreignKey({
      columns: [t.previousPaymentId],
      foreignColumns: [t.id],
      name: 'payments_previous_payment_id_fk',
    }),
    // Settled payments must carry settlement metadata; succeeded payments must carry the
    // gateway reference too. Pending and superseded states have neither.
    settledStatusGuard: check(
      'payments_settled_status_guard',
      sql`(${t.status} IN ('pending','superseded'))
        OR (${t.status} = 'failed' AND ${t.settledAt} IS NOT NULL)
        OR (${t.status} = 'succeeded' AND ${t.settledAt} IS NOT NULL AND ${t.gatewayRef} IS NOT NULL)`,
    ),
  }),
);

/**
 * One row per delivery attempt. For Try-and-Buy this also logs the door visit outcome
 * (kept/returned/refused) via the related door-visit detail captured separately.
 */
export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    deliveryAgentId: text('delivery_agent_id').references(() => deliveryAgents.id),
    attemptNumber: integer('attempt_number').notNull(),
    outcome: deliveryAttemptOutcome('outcome').notNull(),
    notes: text('notes'),
    proofPhotos: jsonb('proof_photos').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Optional captured signature (Cloudinary URL) for a proof-of-delivery.
    signatureUrl: text('signature_url'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // UNIQUE so two concurrent writers can't both insert attempt #N for the same order.
    orderAttemptIdx: uniqueIndex('delivery_attempts_order_attempt_idx').on(
      t.orderId,
      t.attemptNumber,
    ),
    attemptNumberGuard: check('delivery_attempts_attempt_guard', sql`${t.attemptNumber} > 0`),
  }),
);

// ===== Relations =====

export const addressesRelations = relations(addresses, ({ one }) => ({
  consumer: one(consumers, {
    fields: [addresses.consumerId],
    references: [consumers.id],
  }),
}));

export const orderGroupsRelations = relations(orderGroups, ({ one, many }) => ({
  consumer: one(consumers, {
    fields: [orderGroups.consumerId],
    references: [consumers.id],
  }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  group: one(orderGroups, { fields: [orders.groupId], references: [orderGroups.id] }),
  consumer: one(consumers, { fields: [orders.consumerId], references: [consumers.id] }),
  store: one(retailerStores, { fields: [orders.storeId], references: [retailerStores.id] }),
  address: one(addresses, { fields: [orders.addressId], references: [addresses.id] }),
  items: many(orderItems),
  transitions: many(orderTransitions),
  payments: many(payments),
  deliveryAttempts: many(deliveryAttempts),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  listing: one(productListings, {
    fields: [orderItems.listingId],
    references: [productListings.id],
  }),
  variant: one(variants, { fields: [orderItems.variantId], references: [variants.id] }),
}));

export const orderTransitionsRelations = relations(orderTransitions, ({ one }) => ({
  order: one(orders, { fields: [orderTransitions.orderId], references: [orders.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  previousPayment: one(payments, {
    fields: [payments.previousPaymentId],
    references: [payments.id],
    relationName: 'paymentRetryChain',
  }),
}));

export const deliveryAttemptsRelations = relations(deliveryAttempts, ({ one }) => ({
  order: one(orders, { fields: [deliveryAttempts.orderId], references: [orders.id] }),
  agent: one(deliveryAgents, {
    fields: [deliveryAttempts.deliveryAgentId],
    references: [deliveryAgents.id],
  }),
}));
