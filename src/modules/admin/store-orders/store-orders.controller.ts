/**
 * Admin per-store order transitions + bulk.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAttempts,
  orderItems,
  orders,
  platformConfig,
  retailerAccounts,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify, notifySummaryToStoreOwners } from '@/shared/notify.js';
import { logTransitionMarker, transitionOrder } from '@/shared/orders/transition.js';
import type { OrderStatus } from '@/shared/orders/state-machine.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkOrderIdsBody,
  HandoverBody,
  MarkDeliveredBody,
  MarkUndeliveredBody,
  RequestCancelBody,
} from './store-orders.validators.js';

type Auth = AccessTokenPayload;

async function ownedOrderOr404(orderId: string, storeId: string) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.storeId, storeId)),
    columns: { id: true, status: true, storeId: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found for this store');
  return order;
}

async function notifyOwners(
  storeId: string,
  payload: { title: string; body?: string; deepLink?: string },
): Promise<void> {
  const owners = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, storeId),
  });
  await Promise.all(
    owners.map((o) =>
      notify({
        recipientKind: 'retailer',
        recipientId: o.id,
        kind: 'system',
        title: payload.title,
        body: payload.body ?? null,
        deepLink: payload.deepLink ?? null,
      }),
    ),
  );
}

export async function acceptOrder(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const result = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'accepted',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'admin_accepted',
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.accept',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin accepted an order',
    deepLink: `/retailer/orders/${input.orderId}`,
  });
  return ok(result);
}

export async function packOrder(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const result = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'packed',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'admin_packed',
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.pack',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin marked order packed',
    deepLink: `/retailer/orders/${input.orderId}`,
  });
  return ok(result);
}

export async function handoverOrder(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  body: z.infer<typeof HandoverBody>;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const result = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'picked_up',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'admin_handover',
    metadata: input.body as Record<string, unknown>,
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.handover',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok(result);
}

export async function departOrder(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const result = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'out_for_delivery',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'admin_departed',
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.depart',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok(result);
}

export async function markDelivered(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  body: z.infer<typeof MarkDeliveredBody>;
  requestId: string;
}) {
  const body = input.body as { note?: string; proofPhotoUrl?: string };
  await ownedOrderOr404(input.orderId, input.storeId);
  const result = await db.transaction(async (tx) => {
    const items = await tx
      .select({ variantId: orderItems.variantId, qty: orderItems.qty })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));
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
      .where(eq(deliveryAttempts.orderId, input.orderId));
    const nextAttempt =
      existingAttempts.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;
    await tx.insert(deliveryAttempts).values({
      id: newId(IdPrefix.DeliveryAttempt),
      orderId: input.orderId,
      deliveryAgentId: null,
      attemptNumber: nextAttempt,
      outcome: 'delivered',
      notes: body.note ?? null,
      proofPhotos: body.proofPhotoUrl ? [body.proofPhotoUrl] : [],
    });
    return { nextAttempt };
  });
  const transition = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'delivered',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'admin_delivery_confirmed',
    metadata: { attemptNumber: result.nextAttempt },
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.mark_delivered',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin marked order delivered',
    deepLink: `/retailer/orders/${input.orderId}`,
  });
  return ok(transition);
}

export async function markUndelivered(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  body: z.infer<typeof MarkUndeliveredBody>;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const cfg = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'undelivered_retry_budget'),
  });
  const retryBudget = cfg && typeof cfg.value === 'number' ? (cfg.value as number) : 1;
  const existingAttempts = await db
    .select({ attemptNumber: deliveryAttempts.attemptNumber })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.orderId, input.orderId));
  const attemptsSoFar = existingAttempts.length;
  const nextAttempt =
    existingAttempts.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;
  await db.insert(deliveryAttempts).values({
    id: newId(IdPrefix.DeliveryAttempt),
    orderId: input.orderId,
    deliveryAgentId: null,
    attemptNumber: nextAttempt,
    outcome: 'undelivered',
    notes: input.body.reason,
    proofPhotos: [],
  });
  await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'undelivered',
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: input.body.reason,
    metadata: { attemptNumber: nextAttempt },
  });
  const totalAttempts = attemptsSoFar + 1;
  if (totalAttempts < 1 + retryBudget) {
    const retry = await transitionOrder(db, {
      orderId: input.orderId,
      toStatus: 'out_for_delivery',
      actorType: 'system',
      actorId: 'system',
      reason: 'retry_within_budget',
      metadata: { retryNumber: totalAttempts + 1 },
    });
    await recordAudit({
      actor: input.auth,
      action: 'order.mark_undelivered',
      resourceKind: 'order',
      resourceId: input.orderId,
      impersonatedStoreId: input.storeId,
      requestId: input.requestId,
    });
    return ok({ ...retry, retryWithinBudget: true });
  }
  const final = await transitionOrder(db, {
    orderId: input.orderId,
    toStatus: 'returning_to_store',
    actorType: 'system',
    actorId: 'system',
    reason: 'retry_budget_exhausted',
    metadata: { totalAttempts },
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.mark_undelivered',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok({ ...final, retryWithinBudget: false });
}

export async function requestCancel(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  body: z.infer<typeof RequestCancelBody>;
  requestId: string;
}) {
  const order = await ownedOrderOr404(input.orderId, input.storeId);
  const marker = await logTransitionMarker(db, {
    orderId: order.id,
    toStatus: order.status as OrderStatus,
    actorType: 'admin',
    actorId: input.auth.sub,
    reason: 'cancel_requested',
    metadata: { requestedReason: input.body.reason },
  });
  await recordAudit({
    actor: input.auth,
    action: 'order.request_cancel',
    resourceKind: 'order',
    resourceId: order.id,
    impersonatedStoreId: input.storeId,
    note: input.body.reason,
    requestId: input.requestId,
  });
  return ok({ orderId: order.id, requestedReason: input.body.reason, ...marker });
}

export async function bulkAccept(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkOrderIdsBody>;
  requestId: string;
}) {
  let accepted = 0;
  const skipped: string[] = [];
  const acceptedIds: string[] = [];
  for (const oid of input.body.orderIds) {
    try {
      await ownedOrderOr404(oid, input.storeId);
      await transitionOrder(db, {
        orderId: oid,
        toStatus: 'accepted',
        actorType: 'admin',
        actorId: input.auth.sub,
        reason: 'admin_bulk_accept',
      });
      await recordAudit({
        actor: input.auth,
        action: 'order.accept',
        resourceKind: 'order',
        resourceId: oid,
        impersonatedStoreId: input.storeId,
        requestId: input.requestId,
      });
      accepted++;
      acceptedIds.push(oid);
    } catch {
      skipped.push(oid);
    }
  }
  if (accepted > 0) {
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action: 'accepted',
      count: accepted,
      deepLink: '/retailer/orders',
      sampleIds: acceptedIds,
    });
  }
  return ok({ accepted, skipped });
}

export async function bulkPack(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkOrderIdsBody>;
  requestId: string;
}) {
  let packed = 0;
  const skipped: string[] = [];
  const packedIds: string[] = [];
  for (const oid of input.body.orderIds) {
    try {
      await ownedOrderOr404(oid, input.storeId);
      await transitionOrder(db, {
        orderId: oid,
        toStatus: 'packed',
        actorType: 'admin',
        actorId: input.auth.sub,
        reason: 'admin_bulk_pack',
      });
      await recordAudit({
        actor: input.auth,
        action: 'order.pack',
        resourceKind: 'order',
        resourceId: oid,
        impersonatedStoreId: input.storeId,
        requestId: input.requestId,
      });
      packed++;
      packedIds.push(oid);
    } catch {
      skipped.push(oid);
    }
  }
  if (packed > 0) {
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action: 'packed',
      count: packed,
      deepLink: '/retailer/orders',
      sampleIds: packedIds,
    });
  }
  return ok({ packed, skipped });
}
