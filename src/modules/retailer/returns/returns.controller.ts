/**
 * Retailer-side returns + held-items. Scoped to the authenticated retailer's store.
 */
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  heldItems,
  orderItems,
  orders,
  platformConfig,
  retailerAccounts,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import { declineReturn } from '@/shared/returns/decline-return.js';
import {
  forceDispose,
  markCollectedAtCounter,
  markRedelivered,
} from '@/shared/held-items/dispositions.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  DeclineBody,
  ListHeldQuery,
  ListReturnsQuery,
  OpenCounterBody,
  RecordDispositionBody,
  StandardReturnBody,
  VerifyBody,
} from './returns.validators.js';

type Auth = AccessTokenPayload;

async function getOwnStoreId(auth: Auth): Promise<string> {
  const sub = auth.sub;
  const r = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, sub),
    columns: { id: true, storeId: true, status: true },
  });
  if (!r) throw AppError.unauthorized('Retailer account not found');
  if (!r.storeId) throw new AppError(409, ErrorCode.NotOwner, 'No store linked');
  // `terminated` passes: read-only access to historical returns. Mutations are
  // rejected centrally in requireAuth (shared/auth/middleware.ts).
  if (r.status !== 'active' && r.status !== 'terminated')
    throw new AppError(403, ErrorCode.RetailerNotApproved, `${r.status}`);
  return r.storeId;
}

export async function listReturns(input: {
  auth: Auth;
  query: z.infer<typeof ListReturnsQuery>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const storeOrderIds = (
    await db.query.orders.findMany({
      where: eq(orders.storeId, storeId),
      columns: { id: true },
    })
  ).map((o) => o.id);
  if (storeOrderIds.length === 0) return ok([]);

  const itemIds = (
    await db.query.orderItems.findMany({
      where: inArray(orderItems.orderId, storeOrderIds),
      columns: { id: true },
    })
  ).map((i) => i.id);
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
  orderId: string;
  body: z.infer<typeof OpenCounterBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const orderRow = await db.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, storeId: true },
  });
  if (!orderRow || orderRow.storeId !== storeId) {
    throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found for your store');
  }
  const r = await openReturn(db, {
    orderId: input.orderId,
    items: input.body.items,
    counterReturn: true,
    actor: { type: 'retailer', id: input.auth.sub },
  });
  return ok(r);
}

export async function verifyReturnHandler(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof VerifyBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const r = await verifyReturn(db, {
    returnId: input.id,
    decision: input.body.decision,
    reasonNote: input.body.reasonNote,
    actor: { type: 'retailer', id: input.auth.sub },
    expectedStoreId: storeId,
  });
  return ok(r);
}

/**
 * Goods for a consumer-initiated standard return physically reached the store
 * (self-drop-off, or any path outside the reverse-pickup flow). Starts the
 * verification window — from here the store must verify within
 * `verification_window_hours` or the sweep auto-accepts + refunds.
 */
export async function markReceived(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const ret = await db.query.returns.findFirst({
    where: eq(returns.id, input.id),
    with: { orderItem: { with: { order: { columns: { storeId: true } } } } },
  });
  if (!ret) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
  if (ret.orderItem.order.storeId !== storeId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Return does not belong to your store');
  }
  if (ret.kind !== 'standard_return') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only standard returns are marked received');
  }
  if (ret.storeDecision !== 'pending') {
    throw new AppError(409, ErrorCode.ReturnAlreadyDecided, `Return is '${ret.storeDecision}'`);
  }
  const cfg = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'verification_window_hours'),
  });
  const verHours = cfg && typeof cfg.value === 'number' ? cfg.value : 24;
  const expiresAt = new Date(Date.now() + verHours * 3_600_000);
  const [stamped] = await db
    .update(returns)
    .set({ verificationWindowExpiresAt: expiresAt })
    .where(
      and(
        eq(returns.id, input.id),
        eq(returns.storeDecision, 'pending'),
        isNull(returns.verificationWindowExpiresAt),
      ),
    )
    .returning({ id: returns.id });
  if (!stamped) {
    throw new AppError(409, ErrorCode.InvalidState, 'Verification window already running');
  }
  return ok({ returnId: input.id, verificationWindowExpiresAt: expiresAt });
}

/** Decline a return — opens a dispute and holds funds until an admin decides. */
export async function declineReturnHandler(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DeclineBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const r = await declineReturn(db, {
    returnId: input.id,
    reasonNote: input.body.reasonNote,
    rejectPhotos: input.body.rejectPhotos,
    actor: { type: 'retailer', id: input.auth.sub },
    expectedStoreId: storeId,
  });
  return ok(r);
}

export async function listHeldItems(input: {
  auth: Auth;
  query: z.infer<typeof ListHeldQuery>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const conds: SQL[] = [eq(heldItems.storeId, storeId)];
  if (input.query.status) conds.push(eq(heldItems.status, input.query.status));
  const where = conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.query.heldItems.findMany({
    ...(where && { where }),
    orderBy: desc(heldItems.holdingWindowExpiresAt),
    limit: input.query.limit,
    with: {
      return: { with: { orderItem: { with: { order: true } } } },
    },
  });
  return ok(rows);
}

export async function collectAtCounter(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const r = await markCollectedAtCounter(
    db,
    input.id,
    { type: 'retailer', id: input.auth.sub },
    storeId,
  );
  return ok(r);
}

export async function redeliver(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const r = await markRedelivered(
    db,
    input.id,
    { type: 'retailer', id: input.auth.sub },
    storeId,
  );
  return ok(r);
}

export async function openStandard(input: {
  auth: Auth;
  orderId: string;
  body: z.infer<typeof StandardReturnBody>;
}) {
  const storeId = await getOwnStoreId(input.auth);
  const orderRow = await db.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    columns: { id: true, storeId: true, status: true },
  });
  if (!orderRow || orderRow.storeId !== storeId) {
    throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found for your store');
  }
  if (orderRow.status !== 'delivered') {
    throw new AppError(409, ErrorCode.InvalidState, 'Standard returns require a delivered order');
  }
  const opened = await openReturn(db, {
    orderId: input.orderId,
    items: input.body.items.map((i) => ({
      orderItemId: i.orderItemId,
      ...(i.reasonText !== undefined ? { reasonText: i.reasonText } : {}),
      photos: i.consumerPhotos,
    })),
    counterReturn: false,
    actor: { type: 'retailer', id: input.auth.sub },
  });
  const created = await db.query.returns.findMany({
    where: inArray(
      returns.orderItemId,
      input.body.items.map((i) => i.orderItemId),
    ),
    orderBy: desc(returns.openedAt),
    limit: input.body.items.length,
  });
  for (let i = 0; i < created.length; i++) {
    const r = created[i]!;
    const src = input.body.items[i]!;
    await db
      .update(returns)
      .set({ reasonCategory: src.reasonCategory, consumerPhotos: src.consumerPhotos })
      .where(eq(returns.id, r.id));
  }
  return ok(opened);
}

export async function getReturn(input: { auth: Auth; id: string }) {
  const storeId = await getOwnStoreId(input.auth);
  const row = await db.query.returns.findFirst({
    where: eq(returns.id, input.id),
    with: { orderItem: { with: { order: true } }, heldItems: true },
  });
  if (!row) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
  if (row.orderItem.order.storeId !== storeId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Return does not belong to your store');
  }
  return ok(row);
}

export async function recordDisposition(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof RecordDispositionBody>;
}) {
  await getOwnStoreId(input.auth);
  const r = await forceDispose(db, {
    heldId: input.id,
    disposition: input.body.disposition,
    reason: input.body.note ?? '',
    actor: { type: 'retailer', id: input.auth.sub },
  });
  return ok(r);
}
