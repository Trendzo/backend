/**
 * Retailer-side order management. Scoped to the authenticated retailer's storeId.
 */
import { and, asc, eq, desc, inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAttempts,
  heldItems,
  orderItems,
  orderTransitions,
  orders,
  payments,
  platformConfig,
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
  if (retailer.status !== 'active') {
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
    with: { items: { columns: { id: true } } },
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
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
      pickupSlotStart: r.pickupSlotStart,
      pickupSlotEnd: r.pickupSlotEnd,
      pickupCode: r.pickupCode,
      doorWindowExpiresAt: r.doorWindowExpiresAt,
      doorWindowExtendedAt: r.doorWindowExtendedAt,
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
  return ok({
    ...order,
    returns: returnsRows,
    refunds: refundsRows,
    heldItems: heldRows,
    availableTransitions: transitionsFrom(order.status as OrderStatus),
  });
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

export async function handover(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof HandoverBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  await loadOwnedOrder(input.id, storeId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'picked_up',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: 'agent_handover',
    metadata: {
      ...input.body,
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

  const cfg = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'undelivered_retry_budget'),
  });
  const retryBudget = cfg && typeof cfg.value === 'number' ? (cfg.value as number) : 1;

  const existingAttempts = await db
    .select({ attemptNumber: deliveryAttempts.attemptNumber })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.orderId, input.id));
  const attemptsSoFar = existingAttempts.length;
  const nextAttempt =
    existingAttempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;

  await db.insert(deliveryAttempts).values({
    id: newId(IdPrefix.DeliveryAttempt),
    orderId: input.id,
    deliveryAgentId: null,
    attemptNumber: nextAttempt,
    outcome: 'undelivered',
    notes: input.body.reason,
    proofPhotos: [],
  });

  await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'undelivered',
    actorType: 'retailer',
    actorId: input.auth.sub,
    reason: input.body.reason,
    metadata: {
      attemptNumber: nextAttempt,
      ...(input.auth.impersonating
        ? { impersonatingAdminSessionId: input.auth.impersonating.sessionId }
        : {}),
    },
  });

  const totalAttemptsAfterThis = attemptsSoFar + 1;
  if (totalAttemptsAfterThis < 1 + retryBudget) {
    const retry = await transitionOrder(db, {
      orderId: input.id,
      toStatus: 'out_for_delivery',
      actorType: 'system',
      actorId: 'system',
      reason: 'retry_within_budget',
      metadata: { retryNumber: totalAttemptsAfterThis + 1 },
    });
    return ok({ ...retry, retryWithinBudget: true });
  }
  const final = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'returning_to_store',
    actorType: 'system',
    actorId: 'system',
    reason: 'retry_budget_exhausted',
    metadata: { totalAttempts: totalAttemptsAfterThis },
  });
  return ok({ ...final, retryWithinBudget: false });
}

export async function requestCancel(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof RequestCancelBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const order = await loadOwnedOrder(input.id, storeId);
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
