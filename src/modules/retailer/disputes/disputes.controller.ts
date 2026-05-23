import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  disputes,
  orderItems,
  orders,
  returns,
  retailerAccounts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ListDisputesQuery } from './disputes.validators.js';

type Auth = AccessTokenPayload;

/**
 * GET /retailer/disputes — disputes for this retailer's store (read-only).
 *
 * Scoping logic:
 *   order-level disputes: dispute.orderId → orders.storeId = storeId
 *   return-level disputes: dispute.returnId → returns.orderItemId → orderItems.orderId → orders.storeId = storeId
 */
export async function listDisputes(input: {
  auth: Auth;
  query: z.infer<typeof ListDisputesQuery>;
}) {
  const { auth, query } = input;
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, auth.sub),
  });
  if (!retailer?.storeId) {
    throw new AppError(403, ErrorCode.StoreNotActive, 'No active store on this account');
  }
  const storeId = retailer.storeId;

  // Step 1: collect order IDs for this store.
  const storeOrders = await db.query.orders.findMany({
    where: eq(orders.storeId, storeId),
    columns: { id: true },
  });
  if (storeOrders.length === 0) return ok([]);
  const orderIds = storeOrders.map((o) => o.id);

  // Step 2: collect return IDs for items in those orders.
  const items = await db.query.orderItems.findMany({
    where: inArray(orderItems.orderId, orderIds),
    columns: { id: true },
  });
  const itemIds = items.map((i) => i.id);
  const storeReturnIds =
    itemIds.length === 0
      ? []
      : (
          await db.query.returns.findMany({
            where: inArray(returns.orderItemId, itemIds),
            columns: { id: true },
          })
        ).map((r) => r.id);

  // Step 3: fetch disputes by order OR return membership.
  const orderDisputes = await db.query.disputes.findMany({
    where: inArray(disputes.orderId, orderIds),
    columns: { id: true },
  });
  const returnDisputes =
    storeReturnIds.length === 0
      ? []
      : await db.query.disputes.findMany({
          where: inArray(disputes.returnId, storeReturnIds),
          columns: { id: true },
        });

  const allIds = [...new Set([...orderDisputes, ...returnDisputes].map((d) => d.id))];
  if (allIds.length === 0) return ok([]);

  // Step 4: fetch full rows, apply status filter, paginate.
  const where = query.status
    ? and(inArray(disputes.id, allIds), eq(disputes.status, query.status))
    : inArray(disputes.id, allIds);

  const rows = await db.query.disputes.findMany({
    where,
    orderBy: desc(disputes.openedAt),
    limit: query.limit,
    offset: query.offset,
  });

  return ok(
    rows.map((d) => ({
      ...d,
      targetKind: d.orderId ? 'order' : 'return',
      targetId: d.orderId ?? d.returnId,
    })),
  );
}

export async function getDispute(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, auth.sub),
  });
  if (!retailer?.storeId) {
    throw new AppError(403, ErrorCode.StoreNotActive, 'No active store on this account');
  }
  const storeId = retailer.storeId;

  const dispute = await db.query.disputes.findFirst({
    where: eq(disputes.id, id),
  });
  if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');

  // Verify the dispute targets an order that belongs to this store (or a return from that order).
  if (dispute.orderId) {
    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, dispute.orderId), eq(orders.storeId, storeId)),
      columns: { id: true },
    });
    if (!order)
      throw new AppError(403, ErrorCode.NotOwner, 'Dispute does not belong to your store');
  } else if (dispute.returnId) {
    const ret = await db.query.returns.findFirst({
      where: eq(returns.id, dispute.returnId!),
      with: { orderItem: { with: { order: true } } },
      columns: { id: true },
    });
    if (!ret || (ret as any).orderItem?.order?.storeId !== storeId) {
      throw new AppError(403, ErrorCode.NotOwner, 'Dispute does not belong to your store');
    }
  }

  return ok({
    ...dispute,
    targetKind: dispute.orderId ? 'order' : 'return',
    targetId: dispute.orderId ?? dispute.returnId,
  });
}
