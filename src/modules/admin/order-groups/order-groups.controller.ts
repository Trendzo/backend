/**
 * Admin Order Group endpoints (MODULES.md §8 Order Group).
 *
 * One order_group rolls up the per-store orders that come out of one consumer
 * checkout. Even a single-store checkout gets a group of one, so consumer-facing
 * views are uniform; this admin endpoint surfaces the multi-retailer envelope.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orderGroups, orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';

export async function getOrderGroup(id: string) {
  const group = await db.query.orderGroups.findFirst({
    where: eq(orderGroups.id, id),
  });
  if (!group) throw new AppError(404, ErrorCode.NotFound, 'Order group not found');
  const children = await db.query.orders.findMany({
    where: eq(orders.groupId, group.id),
    columns: {
      id: true,
      storeId: true,
      storeNameSnap: true,
      status: true,
      grandTotalPaise: true,
      placedAt: true,
    },
  });
  return ok({
    id: group.id,
    consumerId: group.consumerId,
    status: group.status,
    combinedTotalPaise: group.combinedTotalPaise,
    placedAt: group.placedAt,
    orders: children,
  });
}
