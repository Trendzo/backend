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
import { orderItems, orders, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { verificationWindowHours } from '@/shared/returns/mark-goods-received.js';
import {
  RETURN_WINDOW_DAYS,
  isReturnableOutcome,
  returnDeadline,
} from '@/shared/returns/returnable.js';

export type OpenReturnItemInput = {
  orderItemId: string;
  reasonText?: string | undefined;
  /** Categorical reason — consumer-app standard returns. */
  reasonCategory?: 'damaged' | 'wrong_item' | 'not_as_described' | 'doesnt_fit' | 'other' | undefined;
  photos?: string[] | undefined;
  /** Consumer-submitted evidence photos (stored separately from store-side photos). */
  consumerPhotos?: string[] | undefined;
};

export async function openReturn(
  database: typeof Db,
  input: {
    orderId: string;
    items: OpenReturnItemInput[];
    /** When true, the customer is at the counter — items immediately at the store. */
    counterReturn: boolean;
    actor: { type: ActorType; id: string };
  },
): Promise<{ orderId: string; returnIds: string[]; reversePickupId?: string }> {
  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required to open a return');
  }

  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

  const verHours = await verificationWindowHours(database);
  const returnIds: string[] = [];

  /**
   * Everything is validated INSIDE the transaction, behind a row lock on the order
   * items.
   *
   * The old shape read `order_items.outcome` outside the transaction and only then
   * inserted. Under READ COMMITTED two concurrent requests both saw the pre-flip
   * outcome, both passed, and both inserted — two returns for one item, and later two
   * refunds. Locking the items (ids sorted, so two multi-item requests cannot deadlock)
   * makes the loser block, re-read the flipped outcome, and fail cleanly; the partial
   * unique index `returns_open_per_order_item_uniq` is the hard backstop underneath.
   */
  await database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: orders.status, deliveredAt: orders.deliveredAt })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for('update');
    if (!locked) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
    if (locked.status !== 'delivered') {
      throw new AppError(
        409,
        ErrorCode.ReturnInvalidState,
        `Order must be 'delivered' to open a return (current: '${locked.status}')`,
      );
    }
    if (!locked.deliveredAt) {
      throw new AppError(409, ErrorCode.ReturnInvalidState, 'Order has no deliveredAt timestamp');
    }
    if (Date.now() > returnDeadline(locked.deliveredAt).getTime()) {
      throw new AppError(
        409,
        ErrorCode.ReturnWindowExpired,
        `Return window of ${RETURN_WINDOW_DAYS} days has passed`,
      );
    }

    const wantedIds = [...new Set(input.items.map((i) => i.orderItemId))].sort();
    const itemRows = await tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, input.orderId), inArray(orderItems.id, wantedIds)))
      .orderBy(orderItems.id)
      .for('update');
    if (itemRows.length !== wantedIds.length || wantedIds.length !== input.items.length) {
      throw new AppError(
        422,
        ErrorCode.ValidationError,
        'One or more items do not belong to this order',
      );
    }

    const byId = new Map(itemRows.map((it) => [it.id, it]));
    for (const it of itemRows) {
      if (it.outcome === 'at_store_pending_verification') {
        throw new AppError(
          409,
          ErrorCode.ReturnAlreadyOpen,
          'A return is already open for this item',
        );
      }
      if (!isReturnableOutcome(it.outcome)) {
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

    const now = new Date();
    const verExpires = new Date(now.getTime() + verHours * 60 * 60 * 1000);

    for (const it of input.items) {
      const rid = newId(IdPrefix.Return);
      try {
        await tx.insert(returns).values({
          id: rid,
          orderItemId: it.orderItemId,
          kind: 'standard_return',
          reasonText: it.reasonText ?? null,
          reasonCategory: it.reasonCategory ?? null,
          photos: it.photos ?? [],
          consumerPhotos: it.consumerPhotos ?? [],
          agentDisposition: null,
          // Counter returns are immediately at the store — custody and the decision clock
          // both start now. Consumer-app returns carry neither until the bag physically
          // arrives (driver drop-off, or the retailer pressing "received").
          storeDecision: 'pending',
          goodsReceivedAt: input.counterReturn ? now : null,
          verificationWindowExpiresAt: input.counterReturn ? verExpires : null,
          // Remember what the item was, so withdrawing an uncollected return restores
          // the truth (delivered_kept vs at_door_kept) instead of guessing.
          priorItemOutcome: byId.get(it.orderItemId)?.outcome ?? null,
        });
      } catch (err) {
        // 23505 on returns_open_per_order_item_uniq — a concurrent request won the race.
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(
            409,
            ErrorCode.ReturnAlreadyOpen,
            'A return is already open for this item',
          );
        }
        throw err;
      }
      await tx
        .update(orderItems)
        .set({ outcome: 'at_store_pending_verification' })
        .where(eq(orderItems.id, it.orderItemId));
      returnIds.push(rid);
    }
  });

  // Consumer-initiated returns get a reverse-pickup task (driver collects from
  // home, broadcast to the pool). Best-effort — a failure never breaks the return;
  // admin can recreate from the dispatch board. Skipped for address-less (pickup)
  // orders; those start their verify window via retailer mark-received.
  let reversePickupId: string | undefined;
  if (!input.counterReturn) {
    const { createReversePickupForReturns } = await import(
      '@/shared/reverse-pickups/create-task.js'
    );
    const task = await createReversePickupForReturns(database, {
      orderId: input.orderId,
      returnIds,
    }).catch((err) => {
      console.error(
        `[open-return] reverse-pickup create ${input.orderId}: ${(err as Error).message}`,
      );
      return null;
    });
    if (task) {
      reversePickupId = task.reversePickupId;
      const { notifyOffersChanged } = await import('@/shared/orders/offers-bus.js');
      notifyOffersChanged();
      const { notifyStoreAccounts } = await import('@/shared/notify-store.js');
      await notifyStoreAccounts({
        storeId: order.storeId,
        kind: 'order',
        title: 'Return pickup scheduled — items incoming',
        body: 'A driver will collect the return from the customer and bring it to you.',
        deepLink: '/retailer/returns',
        payload: { orderId: input.orderId, reversePickupId },
      }).catch(() => undefined);
    }
  }

  return { orderId: input.orderId, returnIds, ...(reversePickupId ? { reversePickupId } : {}) };
}
