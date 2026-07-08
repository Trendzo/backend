/**
 * Inventory effect of an ACCEPTED return (store keeps the goods back on shelf).
 * The two return kinds hit different sides of the (stock, reserved) pair:
 *
 *   standard_return — the item was stock-finalized at delivery (stock−qty,
 *                     reserved−qty); goods physically back ⇒ stock += qty.
 *   door_return     — the item never finalized (customer never kept it); the
 *                     shelf count already includes it, only the reservation is
 *                     still held ⇒ reserved −= qty (release).
 *
 * Callers apply this exactly once per return, guarded by their own conditional
 * state flip (storeDecision / heldItem.status) — this helper is not idempotent
 * on its own.
 */
import { eq, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { variants } from '@/db/schema/index.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function applyAcceptedReturnStockEffect(
  executor: typeof Db | Tx,
  input: { returnKind: 'door_return' | 'standard_return' | string; variantId: string; qty: number },
): Promise<void> {
  if (input.returnKind === 'standard_return') {
    await executor
      .update(variants)
      .set({ stock: sql`${variants.stock} + ${input.qty}` })
      .where(eq(variants.id, input.variantId));
    return;
  }
  // door_return (and any future not-yet-finalized kind): release the reservation.
  await executor
    .update(variants)
    .set({ reserved: sql`GREATEST(${variants.reserved} - ${input.qty}, 0)` })
    .where(eq(variants.id, input.variantId));
}
