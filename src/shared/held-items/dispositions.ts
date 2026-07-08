/**
 * Held-item lifecycle helpers. Five resolutions:
 *   collect_at_counter (retailer)  → status='resolved' disposition='returned_to_consumer'
 *   redeliver (retailer)           → status='resolved' disposition='redelivered'; new delivery_attempt
 *   force_dispose (admin)          → status='resolved' disposition=restocked|forfeited|written_off;
 *                                       restocked also bumps variants.stock back up
 *   extend (admin, one-shot)       → status stays 'holding'; pushes holdingWindowExpiresAt forward;
 *                                       refuses if extendedByAdminId already set
 *   mark_expired (admin)           → status='expired' (no disposition required)
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  deliveryAttempts,
  heldItems,
  orderItems,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ActorType } from '@/shared/orders/state-machine.js';
import { applyAcceptedReturnStockEffect } from '@/shared/returns/restock.js';

async function loadHolding(database: typeof Db, heldId: string) {
  const h = await database.query.heldItems.findFirst({
    where: eq(heldItems.id, heldId),
    with: { return: { with: { orderItem: true } } },
  });
  if (!h) throw new AppError(404, ErrorCode.HeldItemNotFound, 'Held item not found');
  if (h.status !== 'holding') {
    throw new AppError(
      409,
      ErrorCode.HeldItemNotHolding,
      `Held item is in '${h.status}', not 'holding'`,
    );
  }
  return h;
}

export async function markCollectedAtCounter(
  database: typeof Db,
  heldId: string,
  actor: { type: ActorType; id: string },
  expectedStoreId?: string,
): Promise<{ heldId: string }> {
  const h = await loadHolding(database, heldId);
  if (expectedStoreId && h.storeId !== expectedStoreId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Held item belongs to a different store');
  }
  await database
    .update(heldItems)
    .set({
      status: 'resolved',
      disposition: 'returned_to_consumer',
      resolvedAt: new Date(),
    })
    .where(eq(heldItems.id, heldId));
  await database
    .update(orderItems)
    .set({ outcome: 'held_collected_at_counter' })
    .where(eq(orderItems.id, h.return.orderItemId));
  await issueSupplementaryForHeld(h.return.orderItem.orderId, heldId);
  void actor;
  return { heldId };
}

export async function markRedelivered(
  database: typeof Db,
  heldId: string,
  actor: { type: ActorType; id: string },
  expectedStoreId?: string,
): Promise<{ heldId: string; deliveryAttemptId: string }> {
  const h = await loadHolding(database, heldId);
  if (expectedStoreId && h.storeId !== expectedStoreId) {
    throw new AppError(403, ErrorCode.Forbidden, 'Held item belongs to a different store');
  }
  const orderId = h.return.orderItem.orderId;

  // Insert a fresh delivery_attempt with attemptNumber = max+1, outcome='delivered'.
  const existing = await database
    .select({ attemptNumber: deliveryAttempts.attemptNumber })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.orderId, orderId));
  const nextAttempt =
    existing.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;

  const daId = newId(IdPrefix.DeliveryAttempt);
  await database.transaction(async (tx) => {
    await tx.insert(deliveryAttempts).values({
      id: daId,
      orderId,
      deliveryAgentId: null,
      attemptNumber: nextAttempt,
      outcome: 'delivered',
      notes: `Redelivered held item ${heldId}`,
      proofPhotos: [],
    });
    await tx
      .update(heldItems)
      .set({ status: 'resolved', disposition: 'redelivered', resolvedAt: new Date() })
      .where(eq(heldItems.id, heldId));
    await tx
      .update(orderItems)
      .set({ outcome: 'held_redelivered' })
      .where(eq(orderItems.id, h.return.orderItemId));
  });
  await issueSupplementaryForHeld(orderId, heldId);
  void actor;
  return { heldId, deliveryAttemptId: daId };
}

/**
 * §17 — supplementary tax invoice for the held item the consumer ultimately keeps.
 * Best-effort: if the parent order isn't yet delivered (no tax invoice) or render fails,
 * we log but don't block the disposition.
 */
async function issueSupplementaryForHeld(orderId: string, heldItemId: string): Promise<void> {
  try {
    const { issueInvoiceForOrder } = await import('@/shared/invoicing/issuance.js');
    await issueInvoiceForOrder({
      orderId,
      kind: 'supplementary_invoice',
      heldItemId,
    });
  } catch (err) {
    console.error(
      `[invoicing] supplementary invoice failed for held ${heldItemId}: ${(err as Error).message}`,
    );
  }
}

export async function forceDispose(
  database: typeof Db,
  input: {
    heldId: string;
    disposition: 'restocked' | 'forfeited_to_store' | 'written_off';
    reason: string;
    actor: { type: ActorType; id: string };
  },
): Promise<{ heldId: string }> {
  const h = await loadHolding(database, input.heldId);
  const orderItem = h.return.orderItem;

  await database.transaction(async (tx) => {
    if (input.disposition === 'restocked') {
      // Standard return → stock+qty (finalized at delivery); door return → release
      // the still-held reservation (stock was never decremented, so a raw stock
      // bump would phantom-inflate the shelf count).
      await applyAcceptedReturnStockEffect(tx, {
        returnKind: h.return.kind,
        variantId: orderItem.variantId,
        qty: orderItem.qty,
      });
    }
    await tx
      .update(heldItems)
      .set({
        status: 'resolved',
        disposition: input.disposition,
        resolvedAt: new Date(),
      })
      .where(eq(heldItems.id, input.heldId));
    // Map disposition → order_item.outcome
    const outcomeMap = {
      restocked: 'held_abandoned',
      forfeited_to_store: 'held_abandoned',
      written_off: 'held_abandoned',
    } as const;
    await tx
      .update(orderItems)
      .set({ outcome: outcomeMap[input.disposition] })
      .where(eq(orderItems.id, orderItem.id));
  });
  void input.actor;
  void input.reason;
  return { heldId: input.heldId };
}

export async function extendHoldingWindow(
  database: typeof Db,
  input: {
    heldId: string;
    daysExtra: number;
    reason: string;
    adminId: string;
  },
): Promise<{ heldId: string; newExpiry: Date }> {
  const h = await loadHolding(database, input.heldId);
  if (h.extendedByAdminId) {
    throw new AppError(
      409,
      ErrorCode.HeldExtensionAlreadyUsed,
      'This held item has already been extended once',
    );
  }
  const newExpiry = new Date(
    h.holdingWindowExpiresAt.getTime() + input.daysExtra * 24 * 60 * 60 * 1000,
  );
  await database
    .update(heldItems)
    .set({
      holdingWindowExpiresAt: newExpiry,
      extendedByAdminId: input.adminId,
      extensionReason: input.reason,
      // Re-arm the pre-expiry warning sweep so the new threshold gets a fresh notification.
      warningNotifiedAt: null,
    })
    .where(eq(heldItems.id, input.heldId));
  return { heldId: input.heldId, newExpiry };
}

export async function markExpired(
  database: typeof Db,
  heldId: string,
  actor: { type: ActorType; id: string },
): Promise<{ heldId: string }> {
  const h = await loadHolding(database, heldId);
  await database.transaction(async (tx) => {
    await tx
      .update(heldItems)
      .set({ status: 'expired' })
      .where(eq(heldItems.id, heldId));
    await tx
      .update(orderItems)
      .set({ outcome: 'held_window_expired' })
      .where(eq(orderItems.id, h.return.orderItemId));
  });
  void actor;
  return { heldId };
}

void returns;
