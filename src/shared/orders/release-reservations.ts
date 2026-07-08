/**
 * Release `variants.reserved` for order items that were never stock-finalized.
 * Only `outcome='pending_delivery'` items still hold their placement reservation;
 * items that reached the customer (delivered_kept / at_door_kept /
 * at_door_return_rejected) were finalized (stock−qty, reserved−qty) at delivery,
 * and items in the returns pipeline (at_door_returned / at_door_refused /
 * at_store_pending_verification…) have their reservation released by the return
 * verification path (verify-return accept) or a held-item disposition — exactly
 * one owner per release.
 *
 * Idempotent + race-safe: each item's outcome is CAS-flipped
 * pending_delivery → cancelled, and the reservation is released only when this
 * call won the flip.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, variants } from '@/db/schema/index.js';

export async function releaseUnfinalizedReservations(
  database: typeof Db,
  orderId: string,
): Promise<{ releasedCount: number }> {
  let releasedCount = 0;
  await database.transaction(async (tx) => {
    const items = await tx
      .select({ id: orderItems.id, variantId: orderItems.variantId, qty: orderItems.qty })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.outcome, 'pending_delivery')));
    for (const it of items) {
      const [flipped] = await tx
        .update(orderItems)
        .set({ outcome: 'cancelled' })
        .where(and(eq(orderItems.id, it.id), eq(orderItems.outcome, 'pending_delivery')))
        .returning({ id: orderItems.id });
      if (!flipped) continue;
      await tx
        .update(variants)
        .set({ reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)` })
        .where(eq(variants.id, it.variantId));
      releasedCount += 1;
    }
  });
  return { releasedCount };
}
