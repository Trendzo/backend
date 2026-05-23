/**
 * Admin per-store returns + held-items.
 */
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  heldItems,
  orderItems,
  orders,
  retailerAccounts,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import {
  forceDispose,
  markCollectedAtCounter,
  markRedelivered,
} from '@/shared/held-items/dispositions.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ListHeldQuery,
  ListReturnsQuery,
  OpenCounterBody,
  RecordDispositionBody,
  VerifyBody,
} from './store-returns.validators.js';

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

export async function listReturns(input: {
  storeId: string;
  query: z.infer<typeof ListReturnsQuery>;
}) {
  const storeOrders = await db.query.orders.findMany({
    where: eq(orders.storeId, input.storeId),
    columns: { id: true },
  });
  const orderIds = storeOrders.map((o) => o.id);
  if (orderIds.length === 0) return ok([]);
  const items = await db.query.orderItems.findMany({
    where: inArray(orderItems.orderId, orderIds),
    columns: { id: true },
  });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length === 0) return ok([]);
  const conds: SQL[] = [inArray(returns.orderItemId, itemIds)];
  if (input.query.decision) conds.push(eq(returns.storeDecision, input.query.decision));
  const rows = await db.query.returns.findMany({
    where: and(...conds),
    orderBy: desc(returns.openedAt),
    limit: input.query.limit,
    with: { orderItem: { with: { order: true } } },
  });
  return ok(rows);
}

export async function openCounter(input: {
  auth: Auth;
  storeId: string;
  orderId: string;
  body: z.infer<typeof OpenCounterBody>;
  requestId: string;
}) {
  await ownedOrderOr404(input.orderId, input.storeId);
  const r = await openReturn(db, {
    orderId: input.orderId,
    items: input.body.items,
    counterReturn: true,
    actor: { type: 'admin', id: input.auth.sub },
  });
  await recordAudit({
    actor: input.auth,
    action: 'return.open_counter',
    resourceKind: 'order',
    resourceId: input.orderId,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin opened a counter return',
    deepLink: `/retailer/orders/${input.orderId}`,
  });
  return ok(r);
}

export async function verifyReturnHandler(input: {
  auth: Auth;
  storeId: string;
  returnId: string;
  body: z.infer<typeof VerifyBody>;
  requestId: string;
}) {
  const r = await verifyReturn(db, {
    returnId: input.returnId,
    decision: input.body.decision,
    reasonNote: input.body.reasonNote,
    rejectPhotos: input.body.rejectPhotos,
    actor: { type: 'admin', id: input.auth.sub },
    expectedStoreId: input.storeId,
  });
  await recordAudit({
    actor: input.auth,
    action: `return.${input.body.decision}`,
    resourceKind: 'return',
    resourceId: input.returnId,
    impersonatedStoreId: input.storeId,
    note: input.body.reasonNote ?? null,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: `Admin ${input.body.decision} a return`,
    deepLink: '/retailer/returns',
  });
  return ok(r);
}

export async function listHeldItems(input: {
  storeId: string;
  query: z.infer<typeof ListHeldQuery>;
}) {
  const conds: SQL[] = [eq(heldItems.storeId, input.storeId)];
  if (input.query.status) conds.push(eq(heldItems.status, input.query.status));
  const where = conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.query.heldItems.findMany({
    ...(where && { where }),
    orderBy: desc(heldItems.holdingWindowExpiresAt),
    limit: input.query.limit,
    with: { return: { with: { orderItem: { with: { order: true } } } } },
  });
  return ok(rows);
}

export async function collectAtCounter(input: {
  auth: Auth;
  storeId: string;
  id: string;
  requestId: string;
}) {
  const r = await markCollectedAtCounter(
    db,
    input.id,
    { type: 'admin', id: input.auth.sub },
    input.storeId,
  );
  await recordAudit({
    actor: input.auth,
    action: 'held_item.collect',
    resourceKind: 'held_item',
    resourceId: input.id,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok(r);
}

export async function redeliver(input: {
  auth: Auth;
  storeId: string;
  id: string;
  requestId: string;
}) {
  const r = await markRedelivered(
    db,
    input.id,
    { type: 'admin', id: input.auth.sub },
    input.storeId,
  );
  await recordAudit({
    actor: input.auth,
    action: 'held_item.redeliver',
    resourceKind: 'held_item',
    resourceId: input.id,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  return ok(r);
}

export async function recordDisposition(input: {
  auth: Auth;
  storeId: string;
  id: string;
  body: z.infer<typeof RecordDispositionBody>;
  requestId: string;
}) {
  const r = await forceDispose(db, {
    heldId: input.id,
    disposition: input.body.disposition,
    reason: input.body.note ?? '',
    actor: { type: 'admin', id: input.auth.sub },
  });
  await recordAudit({
    actor: input.auth,
    action: 'held_item.dispose',
    resourceKind: 'held_item',
    resourceId: input.id,
    after: { disposition: input.body.disposition },
    impersonatedStoreId: input.storeId,
    note: input.body.note ?? null,
    requestId: input.requestId,
  });
  return ok(r);
}
