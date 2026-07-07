/**
 * Retailer-side order management. Scoped to the authenticated retailer's storeId.
 */
import { and, asc, eq, desc, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  customerIssues,
  deliveryAttempts,
  heldItems,
  orderItems,
  orderTransitions,
  orders,
  payments,
  payoutHolds,
  refundDisbursements,
  refunds,
  retailerAccounts,
  returns,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { logTransitionMarker, transitionOrder } from '@/shared/orders/transition.js';
import { rerouteOrder } from '@/shared/orders/routing.js';
import { notifyOffersChanged } from '@/shared/orders/offers-bus.js';
import { finalizeReturnedOrder } from '@/shared/orders/finalize-return.js';
import { recordUndelivered } from '@/shared/orders/undelivered.js';
import { type OrderStatus, transitionsFrom } from '@/shared/orders/state-machine.js';
import { closeDoor, extendDoor, openDoor } from '@/shared/orders/door-visit.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  DoorCloseBody,
  DoorExtendBody,
  HandoverBody,
  ListQuery,
  MarkDeliveredBody,
  MarkUndeliveredBody,
  PickupHandoverBody,
  RequestCancelBody,
} from './orders.validators.js';

type Auth = AccessTokenPayload;

async function getOwnStoreId(auth: Auth): Promise<string> {
  const sub = auth.sub;
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, sub),
    columns: { id: true, storeId: true, status: true },
  });
  if (!retailer) throw AppError.unauthorized('Retailer account not found');
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.NotOwner, 'No store linked to this retailer account');
  }
  // `terminated` passes through: those accounts keep read-only access to their
  // historical orders. Mutating verbs never reach this controller — they are
  // rejected centrally in requireAuth (shared/auth/middleware.ts).
  if (retailer.status !== 'active' && retailer.status !== 'terminated') {
    throw new AppError(
      403,
      ErrorCode.RetailerNotApproved,
      `Retailer account is ${retailer.status}`,
    );
  }
  return retailer.storeId;
}

async function loadOwnedOrder(orderId: string, storeId: string) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.storeId, storeId)),
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, `Order ${orderId} not found for your store`);
  }
  return order;
}

const ACTIVE_STATUSES: OrderStatus[] = ['pending', 'routing', 'accepted', 'packed', 'picked_up'];

export async function listOrders(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const storeId = await getOwnStoreId(input.auth);
  const conds: SQL[] = [eq(orders.storeId, storeId)];
  const requestedStatuses: OrderStatus[] = [];
  if (input.query.status) {
    conds.push(eq(orders.status, input.query.status));
    requestedStatuses.push(input.query.status);
  }
  if (input.query.statusIn) {
    const statuses = input.query.statusIn
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as OrderStatus[];
    if (statuses.length > 0) {
      conds.push(inArray(orders.status, statuses));
      requestedStatuses.push(...statuses);
    }
  }
  const where = conds.length === 1 ? conds[0] : and(...conds);
  const oldestFirst =
    requestedStatuses.length === 0 || requestedStatuses.some((s) => ACTIVE_STATUSES.includes(s));
  const rows = await db.query.orders.findMany({
    ...(where && { where }),
    orderBy: oldestFirst ? asc(orders.placedAt) : desc(orders.placedAt),
    limit: input.query.limit,
    with: { items: { columns: { id: true, listingNameSnap: true, qty: true, listingId: true } } },
  });

  // Which of these orders have a return awaiting the store's decision — so the
  // board/sheet can surface accept/decline-return actions without a per-row fetch.
  const allItemIds = rows.flatMap((r) => r.items.map((i) => i.id));
  const pendingReturnOrderIds = new Set<string>();
  if (allItemIds.length > 0) {
    const pend = await db.query.returns.findMany({
      where: and(inArray(returns.orderItemId, allItemIds), eq(returns.storeDecision, 'pending')),
      columns: { orderItemId: true },
    });
    const itemToOrder = new Map(rows.flatMap((r) => r.items.map((i) => [i.id, r.id] as const)));
    for (const p of pend) {
      const oid = itemToOrder.get(p.orderItemId);
      if (oid) pendingReturnOrderIds.add(oid);
    }
  }

  return ok(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      consumerName: r.consumerNameSnap,
      consumerPhone: r.consumerPhoneSnap,
      deliveryMethod: r.deliveryMethod,
      paymentMethod: r.paymentMethod,
      itemCount: r.items.length,
      // Compact line-item preview for board/history cards (capped).
      items: r.items.slice(0, 4).map((i) => ({ name: i.listingNameSnap, qty: i.qty, listingId: i.listingId })),
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
      hasPendingReturn: pendingReturnOrderIds.has(r.id),
    })),
  );
}

export async function getOrder(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.id), eq(orders.storeId, storeId)),
    with: {
      group: true,
      items: true,
      payments: { orderBy: asc(payments.initiatedAt) },
      transitions: { orderBy: asc(orderTransitions.at) },
      deliveryAttempts: { orderBy: asc(deliveryAttempts.attemptedAt) },
    },
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found for your store');
  }
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

  // Disputes on this order (open AND decided/closed), linked via orderId or one
  // of the order's returns. A return-decline dispute links via returnId (its
  // orderId is null), so match both. Direct per-order query — no platform-wide
  // scan. `heldAmountPaise` is the still-active payout hold for an open dispute
  // (funds withheld from the retailer until an admin decides).
  const OPEN_ISSUE_STATUSES = ['open', 'requested_evidence', 'escalated'] as const;
  const issueRows = await db.query.customerIssues.findMany({
    where: returnIds.length
      ? or(eq(customerIssues.orderId, order.id), inArray(customerIssues.returnId, returnIds))
      : eq(customerIssues.orderId, order.id),
    columns: {
      id: true,
      status: true,
      subject: true,
      description: true,
      openedByActorType: true,
      createdAt: true,
      decision: true,
      decisionNote: true,
      decidedAt: true,
      returnId: true,
    },
    orderBy: desc(customerIssues.createdAt),
  });
  const issueIds = issueRows.map((i) => i.id);
  const activeHolds = issueIds.length
    ? await db.query.payoutHolds.findMany({
        where: and(inArray(payoutHolds.disputeId, issueIds), eq(payoutHolds.status, 'active')),
        columns: { disputeId: true, amountPaise: true },
      })
    : [];
  const heldByDispute = new Map<string, number>();
  for (const h of activeHolds) {
    heldByDispute.set(h.disputeId, (heldByDispute.get(h.disputeId) ?? 0) + Number(h.amountPaise));
  }
  const disputes = issueRows.map((i) => ({
    id: i.id,
    status: i.status,
    subject: i.subject,
    description: i.description,
    openedByActorType: i.openedByActorType,
    createdAt: i.createdAt,
    decision: i.decision,
    decisionNote: i.decisionNote,
    decidedAt: i.decidedAt,
    returnId: i.returnId,
    heldAmountPaise: heldByDispute.get(i.id) ?? null,
  }));
  // Thin open-dispute summary kept for action gating (hides raise-dispute /
  // request-refund while a dispute is live).
  const open = disputes.find((d) => (OPEN_ISSUE_STATUSES as readonly string[]).includes(d.status));
  const openDispute = open ? { id: open.id, status: open.status } : null;

  // Never expose the store→agent handoff code to the retailer — it must be read off
  // the assigned agent's app at the physical handover (that is the whole point of it).
  const { agentHandoffCode: _agentHandoffCode, ...orderSafe } = order;
  return ok({
    ...orderSafe,
    returns: returnsRows,
    refunds: refundsRows,
    heldItems: heldRows,
    disputes,
    openDispute,
    availableTransitions: transitionsFrom(order.status as OrderStatus),
  });
}

/** Retailer marks returned goods physically received → returned_to_store, then
 *  auto-finalizes the order if every return is resolved. */
export async function confirmReturnReceived(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  await finalizeReturnedOrder(db, input.id, { type: 'retailer', id: input.auth.sub });
  return ok({ id: input.id });
}

export async function acceptOrder(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'accepted',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'retailer_accepted',
    ...(input.auth.impersonating
      ? { metadata: { impersonatingAdminSessionId: input.auth.impersonating.sessionId } }
      : {}),
  });
  return ok(result);
}

/**
 * Retailer declines an incoming order within the acceptance window. Same effect as
 * letting the window lapse (the sweeper's `timeout` path) but driven by the retailer
 * explicitly: mark this candidate `rejected`, then reroute to the next store — or
 * cancel the order if routing attempts are exhausted. Only valid while unaccepted.
 */
export async function rejectOrder(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await loadOwnedOrder(input.id, storeId);
  if (order.status !== 'routing' && order.status !== 'pending') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order is ${order.status} — only an unaccepted order can be rejected`,
    );
  }
  const result = await rerouteOrder(input.id, 'rejected', input.auth.sub);
  return ok(result);
}

export async function packOrder(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'packed',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'retailer_packed',
    ...(input.auth.impersonating
      ? { metadata: { impersonatingAdminSessionId: input.auth.impersonating.sessionId } }
      : {}),
  });
  // A packed order is now broadcast to all drivers — wake parked offer long-polls.
  notifyOffersChanged();
  return ok(result);
}

export async function pickupHandover(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PickupHandoverBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await loadOwnedOrder(input.id, storeId);
  if (order.deliveryMethod !== 'pickup') {
    throw new AppError(
      400,
      ErrorCode.PickupCodeNotApplicable,
      'Pickup handover only applies to pickup orders',
    );
  }
  if (!order.pickupCode) {
    throw new AppError(500, ErrorCode.InternalError, 'Pickup order is missing its handover code');
  }
  const submitted = input.body.pickupCode.trim().toUpperCase();
  if (submitted !== order.pickupCode) {
    throw new AppError(400, ErrorCode.InvalidPickupCode, 'Incorrect pickup code');
  }
  const result = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'delivered',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'pickup_handover',
    metadata: {
      ...(input.auth.impersonating
        ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
        : {}),
    },
  });
  return ok(result);
}

// Driver assignment moved to the admin dispatch desk (`/admin/dispatch/orders/:id/assign`)
// when drivers were decoupled into a standalone identity. Retailers no longer assign; they
// only verify the handoff code at `handover()` (Path A) or hand to an external courier (Path B).

export async function handover(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof HandoverBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await loadOwnedOrder(input.id, storeId);

  // Path A — in-house agent already assigned: verify the code the agent reads off
  // their app before releasing the parcel. Guards against handing to the wrong agent.
  // Skipped when the retailer supplies external-courier details (Path B override).
  if (order.assignedAgentId && order.agentHandoffCode && !input.body.agentName) {
    const submitted = input.body.handoffCode?.trim().toUpperCase();
    if (!submitted) {
      throw new AppError(
        400,
        ErrorCode.InvalidPickupCode,
        'Enter the handoff code shown in the delivery agent’s app to complete the handover',
      );
    }
    if (submitted !== order.agentHandoffCode) {
      throw new AppError(
        400,
        ErrorCode.InvalidPickupCode,
        'Incorrect handoff code — verify you are handing to the assigned agent',
      );
    }
    await db.update(orders).set({ agentHandoffCode: null }).where(eq(orders.id, input.id));
    const result = await transitionOrder(db, {
      orderId: input.id,
      toStatus: 'picked_up',
      actorType: 'retailer',
      actorId: input.auth.sub,
      reason: 'agent_handover',
      metadata: {
        assignedAgentId: order.assignedAgentId,
        ...(input.auth.impersonating
          ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
          : {}),
      },
    });
    return ok(result);
  }

  // Path B — external courier with no account/app: direct handover with a free-text
  // name/phone snapshot and no code.
  if (!input.body.agentName || !input.body.agentPhone) {
    throw new AppError(
      422,
      ErrorCode.InvalidState,
      'Assign an in-house delivery agent first, or provide external courier name and phone',
    );
  }
  // Clear any stale in-house assignment/code so the previously-assigned agent no
  // longer sees this order once it goes to an external courier.
  if (order.assignedAgentId || order.agentHandoffCode) {
    await db
      .update(orders)
      .set({ assignedAgentId: null, agentHandoffCode: null })
      .where(eq(orders.id, input.id));
  }
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'picked_up',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'agent_handover',
    metadata: {
      agentName: input.body.agentName,
      agentPhone: input.body.agentPhone,
      ...(input.auth.impersonating
        ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
        : {}),
    },
  });
  return ok(result);
}

export async function depart(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'out_for_delivery',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'agent_departed',
    ...(input.auth.impersonating
      ? { metadata: { impersonatingAdminSessionId: input.auth.impersonating.sessionId } }
      : {}),
  });
  return ok(result);
}

export async function markDelivered(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof MarkDeliveredBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);

  const result = await db.transaction(async (tx) => {
    const items = await tx
      .select({ variantId: orderItems.variantId, qty: orderItems.qty })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.id));
    for (const it of items) {
      await tx
        .update(variants)
        .set({
          stock: sql`${variants.stock} - ${it.qty}`,
          reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)`,
        })
        .where(eq(variants.id, it.variantId));
    }

    const existingAttempts = await tx
      .select({ attemptNumber: deliveryAttempts.attemptNumber })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.orderId, input.id));
    const nextAttempt =
      existingAttempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;
    await tx.insert(deliveryAttempts).values({
      id: newId(IdPrefix.DeliveryAttempt),
      orderId: input.id,
      deliveryAgentId: null,
      attemptNumber: nextAttempt,
      outcome: 'delivered',
      notes: input.body.note ?? null,
      proofPhotos: input.body.proofPhotoUrl ? [input.body.proofPhotoUrl] : [],
    });
    return { nextAttempt };
  });

  const transition = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'delivered',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'delivery_confirmed',
    metadata: {
      attemptNumber: result.nextAttempt,
      ...(input.auth.impersonating
        ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
        : {}),
    },
  });
  return ok(transition);
}

export async function markUndelivered(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof MarkUndeliveredBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);

  const result = await recordUndelivered(db, {
    orderId: input.id,
    actor: { type: 'retailer', id: input.auth.sub },
    reason: input.body.reason,
    metadata: input.auth.impersonating
      ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
      : {},
  });
  return ok(result);
}

export async function requestCancel(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof RequestCancelBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await loadOwnedOrder(input.id, storeId);
  // A cancellation request only makes sense pre-shipment. Once the order is in
  // transit or coming back as a return, delivery/return decisions govern it —
  // mirror the UI which only offers this on routing/accepted/packed.
  const CANCELLABLE: OrderStatus[] = ['routing', 'accepted', 'packed'];
  if (!CANCELLABLE.includes(order.status as OrderStatus)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot request cancellation once the order is '${order.status}'`,
    );
  }
  const marker = await logTransitionMarker(db, {
    orderId: order.id,
    toStatus: order.status as OrderStatus,
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'cancel_requested',
    metadata: {
      requestedReason: input.body.reason,
      ...(input.auth.impersonating
        ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
        : {}),
    },
  });
  return ok({ orderId: order.id, requestedReason: input.body.reason, ...marker });
}

export async function doorOpen(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const r = await openDoor(db, input.id, { type: 'retailer', id: input.auth.sub });
  return ok(r);
}

export async function doorExtend(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorExtendBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const r = await extendDoor(
    db,
    input.id,
    { type: 'retailer', id: input.auth.sub },
    input.body.reason,
  );
  return ok(r);
}

export async function doorClose(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorCloseBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const r = await closeDoor(
    db,
    input.id,
    { type: 'retailer', id: input.auth.sub },
    input.body.items,
  );
  return ok(r);
}
