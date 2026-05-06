/**
 * Order group status rollup. Computed synchronously from constituent orders' statuses,
 * per spec — never deferred to a background job.
 *
 *   in_flight             at least one child still in motion
 *   all_delivered         every child either delivered or closed
 *   partially_delivered   mix: some delivered/closed, some still in flight or cancelled
 *   all_cancelled         every child cancelled
 *   partially_cancelled   mix: some cancelled, some not
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderGroups, orders } from '@/db/schema/index.js';
import type { OrderStatus } from './state-machine.js';

type GroupStatus = (typeof orderGroups.status.enumValues)[number];

export function computeGroupStatus(childStatuses: OrderStatus[]): GroupStatus {
  if (childStatuses.length === 0) return 'in_flight';

  const isDeliveredOrClosed = (s: OrderStatus): boolean => s === 'delivered' || s === 'closed';
  const isCancelled = (s: OrderStatus): boolean => s === 'cancelled';
  const isInFlight = (s: OrderStatus): boolean => !isDeliveredOrClosed(s) && !isCancelled(s);

  const delivered = childStatuses.filter(isDeliveredOrClosed).length;
  const cancelled = childStatuses.filter(isCancelled).length;
  const inFlight = childStatuses.filter(isInFlight).length;

  if (cancelled === childStatuses.length) return 'all_cancelled';
  if (delivered === childStatuses.length) return 'all_delivered';
  if (inFlight > 0) return 'in_flight';
  // Mixed terminal: some delivered, some cancelled. Partial-cancellation framing.
  if (cancelled > 0 && delivered > 0) return 'partially_delivered';
  if (cancelled > 0) return 'partially_cancelled';
  return 'partially_delivered';
}

/**
 * Recompute and persist the group's status from the live children. Caller must invoke
 * this inside the same transaction that mutates a child order's status.
 */
export async function recomputeGroupStatus(
  database: typeof Db,
  groupId: string,
): Promise<GroupStatus> {
  const children = await database
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.groupId, groupId));
  const next = computeGroupStatus(children.map((c) => c.status as OrderStatus));
  await database.update(orderGroups).set({ status: next }).where(eq(orderGroups.id, groupId));
  return next;
}
