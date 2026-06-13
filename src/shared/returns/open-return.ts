/**
 * Open a post-delivery return (consumer-app or counter return).
 *
 * Two entry points use this:
 *   - admin on behalf of consumer: order is in `delivered` status, items physically with consumer
 *   - retailer counter return: order is `delivered`, customer walked into the store with items
 *
 * Both flow into `returns` rows with kind='standard_return'. The `counterReturn` flag determines
 * whether items are immediately at the store (counter) or on their way (consumer-initiated; the
 * consumer is expected to drop them off / hand to a pickup agent).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  orderItems,
  orders,
  platformConfig,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';

export type OpenReturnItemInput = {
  orderItemId: string;
  reasonText?: string | undefined;
  /** Categorical reason — consumer-app standard returns. */
  reasonCategory?: 'damaged' | 'wrong_item' | 'not_as_described' | 'doesnt_fit' | 'other' | undefined;
  photos?: string[] | undefined;
  /** Consumer-submitted evidence photos (stored separately from store-side photos). */
  consumerPhotos?: string[] | undefined;
};

const RETURN_WINDOW_DAYS = 7;

export async function openReturn(
  database: typeof Db,
  input: {
    orderId: string;
    items: OpenReturnItemInput[];
    /** When true, the customer is at the counter — items immediately at the store. */
    counterReturn: boolean;
    actor: { type: ActorType; id: string };
  },
): Promise<{ orderId: string; returnIds: string[] }> {
  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required to open a return');
  }

  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'delivered') {
    throw new AppError(
      409,
      ErrorCode.ReturnInvalidState,
      `Order must be 'delivered' to open a return (current: '${order.status}')`,
    );
  }
  if (!order.deliveredAt) {
    throw new AppError(
      409,
      ErrorCode.ReturnInvalidState,
      'Order has no deliveredAt timestamp',
    );
  }
  // Return window check.
  const windowExpiry = new Date(
    order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  if (Date.now() > windowExpiry.getTime()) {
    throw new AppError(
      409,
      ErrorCode.ReturnWindowExpired,
      `Return window of ${RETURN_WINDOW_DAYS} days has passed`,
    );
  }

  // Validate every item belongs to this order + isn't already returned.
  const itemRows = await database.query.orderItems.findMany({
    where: and(
      eq(orderItems.orderId, input.orderId),
      inArray(
        orderItems.id,
        input.items.map((i) => i.orderItemId),
      ),
    ),
  });
  if (itemRows.length !== input.items.length) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'One or more items do not belong to this order',
    );
  }
  for (const it of itemRows) {
    if (it.outcome !== 'delivered_kept' && it.outcome !== 'pending_delivery' && it.outcome !== 'at_door_kept') {
      throw new AppError(
        409,
        ErrorCode.ReturnInvalidState,
        `Item ${it.id} is in outcome '${it.outcome}', cannot return`,
      );
    }
    // US-5.5.1: returns are gated by the policy snapshot frozen at order placement,
    // so future policy changes don't retroactively block (or unblock) past orders.
    if (it.listingPolicySnap === 'final_sale') {
      throw new AppError(
        409,
        ErrorCode.ReturnInvalidState,
        `Item ${it.id} was sold as final sale — no returns or replacements`,
      );
    }
  }

  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'verification_window_hours'),
  });
  const verHours = cfg && typeof cfg.value === 'number' ? cfg.value : 24;
  const verExpires = new Date(Date.now() + verHours * 60 * 60 * 1000);

  const returnIds: string[] = [];

  await database.transaction(async (tx) => {
    for (const it of input.items) {
      const rid = newId(IdPrefix.Return);
      await tx.insert(returns).values({
        id: rid,
        orderItemId: it.orderItemId,
        kind: 'standard_return',
        reasonText: it.reasonText ?? null,
        reasonCategory: it.reasonCategory ?? null,
        photos: it.photos ?? [],
        consumerPhotos: it.consumerPhotos ?? [],
        agentDisposition: null,
        // Counter returns are immediately at the store; consumer-app returns wait for the
        // bag to physically arrive before verification can begin. Both states carry
        // storeDecision='pending' until the retailer verifies.
        storeDecision: 'pending',
        verificationWindowExpiresAt: input.counterReturn ? verExpires : null,
      });
      // Mark the order item as awaiting verification.
      await tx
        .update(orderItems)
        .set({ outcome: 'at_store_pending_verification' })
        .where(eq(orderItems.id, it.orderItemId));
      returnIds.push(rid);
    }
  });

  return { orderId: input.orderId, returnIds };
}
