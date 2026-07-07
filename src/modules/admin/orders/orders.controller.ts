/**
 * Admin order management. Test-order placement, list, detail, cancellation.
 *
 * Test-order placement bypasses any real payment gateway — the admin chooses the
 * payment outcome on the form so the team can exercise the failure-retry chain
 * without integrating Razorpay yet.
 */
import { and, asc, desc, eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAttempts,
  disputes,
  heldItems,
  invoices,
  orderItems,
  orderTransitions,
  orders,
  payments,
  platformConfig,
  productListings,
  refundDisbursements,
  refunds,
  retailerAccounts,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId, IdPrefix } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { cancelOrder as cancelOrderShared } from '@/shared/orders/cancel.js';
import { closeDoor, extendDoor, openDoor } from '@/shared/orders/door-visit.js';
import { placeOrder } from '@/shared/orders/place-order.js';
import { logTransitionMarker } from '@/shared/orders/transition.js';
import { findExpiredAcceptances, rerouteOrder } from '@/shared/orders/routing.js';
import { type OrderStatus, transitionsFrom } from '@/shared/orders/state-machine.js';
import type {
  CancelBody,
  DismissCancelBody,
  DoorCloseBody,
  FeeOverrideBody,
  ListOrdersQuery,
  PlaceTestOrderBody,
  RerouteBody,
} from './orders.validators.js';
import type { CancelRequestMarker } from './orders.types.js';

export async function placeTestOrder(input: {
  adminId: string;
  body: z.infer<typeof PlaceTestOrderBody>;
}) {
  const { adminId, body } = input;
  const idempotencyKey =
    body.idempotencyKey ?? newId(IdPrefix.Order).replace(/^ord_/, 'ik_');
  const result = await placeOrder(db, {
    consumerId: body.consumerId,
    storeId: body.storeId,
    items: body.items,
    deliveryMethod: body.deliveryMethod,
    paymentMethod: body.paymentMethod,
    paymentOutcome: body.paymentOutcome,
    ...(body.addressId !== undefined && { addressId: body.addressId }),
    ...(body.couponCode !== undefined && { couponCode: body.couponCode }),
    ...(body.voucherCode !== undefined && { voucherCode: body.voucherCode }),
    ...(body.pointsToRedeem !== undefined && { pointsToRedeem: body.pointsToRedeem }),
    ...(body.applyWallet !== undefined && { applyWallet: body.applyWallet }),
    idempotencyKey,
    placedByActorType: 'admin',
    placedByActorId: adminId,
  });
  return ok(result);
}

export async function listOrders(input: { query: z.infer<typeof ListOrdersQuery> }) {
  const { query } = input;
  const conds: SQL[] = [];
  if (query.status) conds.push(eq(orders.status, query.status));
  if (query.storeId) conds.push(eq(orders.storeId, query.storeId));
  if (query.consumerId) conds.push(eq(orders.consumerId, query.consumerId));
  if (query.paymentMethod) conds.push(eq(orders.paymentMethod, query.paymentMethod));
  if (query.deliveryMethod) conds.push(eq(orders.deliveryMethod, query.deliveryMethod));
  if (query.ageHours) {
    const cutoff = new Date(Date.now() - query.ageHours * 3_600_000);
    conds.push(lt(orders.placedAt, cutoff));
  }
  // Payment-state filter — use a correlated EXISTS so it works even when
  // multiple payment rows exist per order (retry chain).
  if (query.paymentState) {
    const targetStatus =
      query.paymentState === 'paid'
        ? 'succeeded'
        : query.paymentState === 'unpaid'
          ? 'pending'
          : 'failed';
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${payments} p WHERE p.order_id = ${orders.id} AND p.status = ${targetStatus})`,
    );
  }
  if (query.disputeFlag === 'open') {
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${disputes} d WHERE d.order_id = ${orders.id} AND d.status <> 'decided')`,
    );
  } else if (query.disputeFlag === 'none') {
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM ${disputes} d WHERE d.order_id = ${orders.id} AND d.status <> 'decided')`,
    );
  }
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  const { page, pageSize } = query;
  const offset = (page - 1) * pageSize;

  // COUNT query — same predicates, no ORDER BY / LIMIT / joins, so the
  // pagination metadata reflects the full filtered set.
  const totalResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(where ?? sql`true`);
  const total = totalResult[0]?.count ?? 0;

  const rows = await db.query.orders.findMany({
    ...(where && { where }),
    orderBy: desc(orders.placedAt),
    limit: pageSize,
    offset,
    with: {
      store: { columns: { id: true, legalName: true, contactPhone: true } },
      items: { columns: { id: true } },
    },
  });

  // Bulk-fetch open disputes for these orders so the dashboard can render a
  // "has open dispute" pill without a per-row query.
  const orderIds = rows.map((r) => r.id);
  const openDisputeOrderIds =
    orderIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ orderId: disputes.orderId })
              .from(disputes)
              .where(and(sql`${disputes.orderId} IS NOT NULL`, ne(disputes.status, 'decided')))
          )
            .map((d) => d.orderId)
            .filter((v): v is string => !!v && orderIds.includes(v)),
        );

  // Resolve a single payment status per order from the (possibly multi-row)
  // payment retry chain: a succeeded payment wins, else pending, else failed,
  // else superseded. Mirrors the paymentState filter's "any succeeded = paid".
  const PAYMENT_STATUS_RANK: Record<string, number> = {
    succeeded: 4,
    pending: 3,
    failed: 2,
    superseded: 1,
  };
  const paymentStatusByOrder = new Map<string, string>();
  if (orderIds.length > 0) {
    const paymentRows = await db
      .select({ orderId: payments.orderId, status: payments.status })
      .from(payments)
      .where(inArray(payments.orderId, orderIds));
    for (const p of paymentRows) {
      if (!p.orderId) continue;
      const prev = paymentStatusByOrder.get(p.orderId);
      if (!prev || (PAYMENT_STATUS_RANK[p.status] ?? 0) > (PAYMENT_STATUS_RANK[prev] ?? 0)) {
        paymentStatusByOrder.set(p.orderId, p.status);
      }
    }
  }

  // Owner phone per store — fallback for the Store column when the store has no
  // contact phone set. One bulk query keyed by storeId.
  const storeIds = [...new Set(rows.map((r) => r.storeId).filter((v): v is string => !!v))];
  const ownerPhoneByStore = new Map<string, string>();
  if (storeIds.length > 0) {
    const owners = await db
      .select({ storeId: retailerAccounts.storeId, phone: retailerAccounts.phone })
      .from(retailerAccounts)
      .where(and(inArray(retailerAccounts.storeId, storeIds), eq(retailerAccounts.subRole, 'owner')));
    for (const o of owners) {
      if (o.storeId && !ownerPhoneByStore.has(o.storeId)) ownerPhoneByStore.set(o.storeId, o.phone);
    }
  }

  return ok({
    rows: rows.map((r) => ({
      id: r.id,
      groupId: r.groupId,
      status: r.status,
      storeId: r.storeId,
      storeName: r.storeNameSnap,
      storePhone: r.store?.contactPhone ?? (r.storeId ? ownerPhoneByStore.get(r.storeId) ?? null : null),
      consumerId: r.consumerId,
      consumerName: r.consumerNameSnap,
      consumerPhone: r.consumerPhoneSnap,
      deliveryMethod: r.deliveryMethod,
      paymentMethod: r.paymentMethod,
      paymentStatus: paymentStatusByOrder.get(r.id) ?? null,
      itemCount: r.items.length,
      grandTotalPaise: r.grandTotalPaise,
      placedAt: r.placedAt,
      acceptedAt: r.acceptedAt,
      deliveredAt: r.deliveredAt,
      acceptanceDeadlineAt: r.acceptanceDeadlineAt,
      pickupSlotStart: r.pickupSlotStart,
      pickupSlotEnd: r.pickupSlotEnd,
      pickupCode: r.pickupCode,
      doorWindowExpiresAt: r.doorWindowExpiresAt,
      doorWindowExtendedAt: r.doorWindowExtendedAt,
      hasOpenDispute: openDisputeOrderIds.has(r.id),
    })),
    total,
    page,
    pageSize,
  });
}

export async function getOrderDetail(orderId: string) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: {
      group: true,
      items: true,
      payments: { orderBy: asc(payments.initiatedAt) },
      transitions: { orderBy: asc(orderTransitions.at) },
      deliveryAttempts: { orderBy: asc(deliveryAttempts.attemptedAt) },
    },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  // Pull related returns, refunds, held-items so the detail page can render them in-line.
  const itemIds = order.items.map((i) => i.id);
  const returnsRows =
    itemIds.length === 0
      ? []
      : await db.query.returns.findMany({
          where: inArray(returns.orderItemId, itemIds),
          orderBy: asc(returns.openedAt),
        });
  const refundsRows = await db.query.refunds.findMany({
    where: eq(refunds.orderId, order.id),
    with: {
      lines: true,
      disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
    },
    orderBy: asc(refunds.createdAt),
  });
  const returnIds = returnsRows.map((r) => r.id);
  const heldRows =
    returnIds.length === 0
      ? []
      : await db.query.heldItems.findMany({
          where: inArray(heldItems.returnId, returnIds),
          orderBy: asc(heldItems.holdingWindowExpiresAt),
        });

  const siblingRows = await db.query.orders.findMany({
    where: and(eq(orders.groupId, order.groupId), ne(orders.id, order.id)),
    with: { items: { columns: { id: true } } },
    orderBy: asc(orders.placedAt),
  });
  const siblingOrders = siblingRows.map((r) => ({
    id: r.id,
    groupId: r.groupId,
    status: r.status,
    storeId: r.storeId,
    storeName: r.storeNameSnap,
    consumerId: r.consumerId,
    consumerName: r.consumerNameSnap,
    consumerPhone: r.consumerPhoneSnap,
    deliveryMethod: r.deliveryMethod,
    paymentMethod: r.paymentMethod,
    itemCount: r.items.length,
    grandTotalPaise: r.grandTotalPaise,
    placedAt: r.placedAt,
    acceptedAt: r.acceptedAt,
    deliveredAt: r.deliveredAt,
    acceptanceDeadlineAt: r.acceptanceDeadlineAt,
  }));

  // Never expose the store→driver handoff code — it must be read off the driver's
  // screen at the physical handover (admin mints it via dispatch but must not see it).
  const { agentHandoffCode: _agentHandoffCode, ...orderSafe } = order;
  return ok({
    ...orderSafe,
    group: { ...order.group, siblingOrders },
    returns: returnsRows,
    refunds: refundsRows,
    heldItems: heldRows,
    availableTransitions: transitionsFrom(order.status as OrderStatus),
  });
}

export async function listCancellationRequests() {
  const markers = await db
    .select({
      id: orderTransitions.id,
      orderId: orderTransitions.orderId,
      reason: orderTransitions.reason,
      metadata: orderTransitions.metadata,
      actorId: orderTransitions.actorId,
      at: orderTransitions.at,
    })
    .from(orderTransitions)
    .where(
      inArray(orderTransitions.reason, [
        'cancel_requested',
        'cancel_dismissed',
        'cancel_approved',
      ]),
    )
    .orderBy(asc(orderTransitions.at));

  // Walk markers per order; track the latest *open* request (one that has
  // no superseding dismiss/approve after it).
  const latestOpen = new Map<string, CancelRequestMarker>();
  for (const m of markers) {
    if (m.reason === 'cancel_requested') {
      latestOpen.set(m.orderId, m as CancelRequestMarker);
    } else {
      latestOpen.delete(m.orderId);
    }
  }
  if (latestOpen.size === 0) return ok([]);

  const orderIds = [...latestOpen.keys()];
  const orderRows = await db.query.orders.findMany({
    where: and(
      inArray(orders.id, orderIds),
      // Already-cancelled / closed orders can't be requested for cancellation
      // — filter to live orders so the admin queue stays actionable.
      ne(orders.status, 'cancelled'),
    ),
  });
  const byId = new Map(orderRows.map((o) => [o.id, o]));

  return ok(
    orderRows
      .map((o) => {
        const marker = latestOpen.get(o.id)!;
        const meta = (marker.metadata ?? {}) as { requestedReason?: string };
        return {
          transitionId: marker.id,
          orderId: o.id,
          storeId: o.storeId,
          storeName: o.storeNameSnap,
          consumerName: o.consumerNameSnap,
          consumerPhone: o.consumerPhoneSnap,
          currentStatus: o.status,
          grandTotalPaise: o.grandTotalPaise,
          placedAt: o.placedAt,
          requestedReason: meta.requestedReason ?? null,
          requestedAt: marker.at,
          retailerActorId: marker.actorId,
        };
      })
      .filter((r) => byId.has(r.orderId)),
  );
}

export async function dismissCancelRequest(input: {
  orderId: string;
  adminId: string;
  body: z.infer<typeof DismissCancelBody>;
}) {
  const { orderId, adminId, body } = input;
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  const result = await logTransitionMarker(db, {
    orderId,
    // No status change — informational marker only.
    toStatus: order.status as OrderStatus,
    actorType: 'admin',
    actorId: adminId,
    reason: 'cancel_dismissed',
    ...(body?.note ? { metadata: { note: body.note } } : {}),
  });
  return ok(result);
}

export async function cancelOrderHandler(input: {
  orderId: string;
  adminId: string;
  body: z.infer<typeof CancelBody>;
}) {
  const { orderId, adminId, body } = input;
  const result = await cancelOrderShared(db, {
    orderId,
    actorType: 'admin',
    actorId: adminId,
    reason: body.reason,
  });
  // Symmetric audit marker so the cancellation-requests queue can detect
  // that this order's pending request was resolved by approval. No-throw
  // because the marker is informational — the cancel above already wrote
  // the actual status transition.
  try {
    await logTransitionMarker(db, {
      orderId,
      toStatus: 'cancelled',
      actorType: 'admin',
      actorId: adminId,
      reason: 'cancel_approved',
      metadata: { approvedReason: body.reason },
    });
  } catch {
    /* marker is auxiliary; cancellation itself succeeded */
  }
  return ok(result);
}

export async function setFeeOverride(input: {
  orderId: string;
  adminId: string;
  body: z.infer<typeof FeeOverrideBody>;
  requestId: string;
}) {
  const { orderId, adminId, body, requestId } = input;
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: {
      id: true,
      platformFeeOverridePaise: true,
      platformFeeOverrideReason: true,
    },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

  const [updated] = await db
    .update(orders)
    .set({
      platformFeeOverridePaise: body.overridePaise,
      platformFeeOverrideReason: body.reason,
    })
    .where(eq(orders.id, orderId))
    .returning({
      id: orders.id,
      platformFeeOverridePaise: orders.platformFeeOverridePaise,
      platformFeeOverrideReason: orders.platformFeeOverrideReason,
    });

  await recordAudit({
    actor: { kind: 'admin', sub: adminId },
    action: 'order.fee_override',
    resourceKind: 'order',
    resourceId: orderId,
    before: {
      platformFeeOverridePaise: order.platformFeeOverridePaise,
      platformFeeOverrideReason: order.platformFeeOverrideReason,
    },
    after: {
      platformFeeOverridePaise: body.overridePaise,
      platformFeeOverrideReason: body.reason,
    },
    note: body.reason,
    requestId,
  });

  return ok(updated);
}

export async function openDoorVisit(input: { orderId: string; adminId: string }) {
  const r = await openDoor(db, input.orderId, { type: 'admin', id: input.adminId });
  return ok(r);
}

export async function extendDoorVisit(input: {
  orderId: string;
  adminId: string;
  reason: string;
}) {
  const r = await extendDoor(
    db,
    input.orderId,
    { type: 'admin', id: input.adminId },
    input.reason,
  );
  return ok(r);
}

export async function closeDoorVisit(input: {
  orderId: string;
  adminId: string;
  items: z.infer<typeof DoorCloseBody>['items'];
}) {
  const r = await closeDoor(
    db,
    input.orderId,
    { type: 'admin', id: input.adminId },
    input.items,
  );
  return ok(r);
}

export async function getStoreCatalog(storeId: string) {
  const rows = await db.query.productListings.findMany({
    where: and(
      eq(productListings.storeId, storeId),
      eq(productListings.status, 'active'),
    ),
    orderBy: asc(productListings.name),
    with: { variants: true },
  });
  return ok(rows);
}

export async function getPriceSnapshot(orderId: string) {
  const items = await db.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
    with: { variant: true },
  });
  return ok(
    items.map((it) => ({
      variantId: it.variantId,
      listingNameSnap: it.listingNameSnap,
      snapshotPaise: it.unitPricePaise,
      currentPaise: it.variant?.pricePaise ?? it.unitPricePaise,
    })),
  );
}

export async function listAcceptanceTimeout() {
  const expired = await findExpiredAcceptances();
  // Read the platform-wide max-attempts so the dashboard can render
  // "Attempt N of M" + a "M-N left" remaining-tries chip per row.
  const maxAttemptsRow = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'routing_max_attempts'),
  });
  const maxAttempts =
    typeof maxAttemptsRow?.value === 'number' ? (maxAttemptsRow.value as number) : 3;
  if (expired.length === 0) return ok([]);
  const orderIds = expired.map((e) => e.id);
  const rows = await db.query.orders.findMany({
    where: inArray(orders.id, orderIds),
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ok(
    expired
      .filter((e) => byId.has(e.id))
      .map((e) => {
        const r = byId.get(e.id)!;
        const remainingAttempts = Math.max(0, maxAttempts - e.routingAttempts);
        return {
          orderId: e.id,
          storeId: e.storeId,
          storeName: r.storeNameSnap,
          consumerName: r.consumerNameSnap,
          consumerPhone: r.consumerPhoneSnap,
          currentStatus: r.status,
          grandTotalPaise: r.grandTotalPaise,
          placedAt: r.placedAt,
          attempts: e.routingAttempts,
          maxAttempts,
          remainingAttempts,
          deadlineAt: e.acceptanceDeadlineAt.toISOString(),
        };
      }),
  );
}

export async function rerouteOrderHandler(input: {
  orderId: string;
  adminId: string;
  body: z.infer<typeof RerouteBody>;
}) {
  const result = await rerouteOrder(input.orderId, input.body.reason, input.adminId);
  return ok(result);
}

export async function listInvoices(orderId: string) {
  const rows = await db.query.invoices.findMany({
    where: eq(invoices.orderId, orderId),
    orderBy: asc(invoices.createdAt),
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      number: r.invoiceNumber,
      kind: r.kind,
      status: r.status,
      totalPaise: r.grandTotalPaise,
      pdfUrl: r.pdfUrl,
      issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}
