/**
 * Mint a reverse-pickup task for a consumer-initiated standard return: one task per
 * openReturn call, carrying all its return ids. Broadcast to drivers via the offers
 * bus (caller fires notifyOffersChanged). Returns null — deliberately not an error —
 * when there is nothing to collect from a home address (pickup-method orders have no
 * address snapshot; the retailer `mark-received` fallback starts the verification
 * window on self-drop-off instead).
 */
import { eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  orderItems,
  orders,
  refundCashHandovers,
  returns as returnsTable,
  reversePickups,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { generateDeliveryOtp } from '@/shared/orders/pickup-code.js';
import { quoteReturnRefundPaise } from '@/shared/refunds/create-refund.js';
import { loadRefundBasis, splitRefundTenders } from '@/shared/refunds/refund-basis.js';

export async function createReversePickupForReturns(
  database: typeof Db,
  input: { orderId: string; returnIds: string[] },
): Promise<{ reversePickupId: string; collectOtp: string; cashRefundDuePaise: number } | null> {
  if (input.returnIds.length === 0) return null;
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
  });
  if (!order || !order.addressLine1Snap) return null;

  // Label from the returned items' snapshots so the driver knows what to collect.
  const rows = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, input.orderId),
    columns: { id: true, listingNameSnap: true, attributesLabelSnap: true, qty: true },
  });
  const returnedItemIds = new Set(
    (
      await database.query.returns.findMany({
        where: inArray(returnsTable.id, input.returnIds),
        columns: { orderItemId: true },
      })
    ).map((r) => r.orderItemId),
  );
  const labelled = rows.filter((r) => returnedItemIds.has(r.id));
  const parts = labelled.map((r) =>
    r.attributesLabelSnap ? `${r.listingNameSnap} (${r.attributesLabelSnap})` : r.listingNameSnap,
  );
  const itemsLabel =
    parts.length > 0
      ? `${labelled.reduce((s, r) => s + r.qty, 0)} item(s): ${parts.join(', ')}`
      : `${input.returnIds.length} item(s)`;

  const cashRefundDuePaise = await computeCashRefundDue(database, order, input.returnIds);

  const id = newId(IdPrefix.ReversePickup);
  const collectOtp = generateDeliveryOtp();
  await database.insert(reversePickups).values({
    id,
    cashRefundDuePaise,
    orderId: order.id,
    returnIds: input.returnIds,
    consumerId: order.consumerId,
    storeId: order.storeId,
    status: 'pending',
    addressLine1: order.addressLine1Snap,
    addressLine2: order.addressLine2Snap,
    addressCity: order.addressCitySnap,
    addressPincode: order.addressPincodeSnap,
    addressLat: order.addressLatSnap,
    addressLng: order.addressLngSnap,
    itemsLabel,
    collectOtp,
  });
  return { reversePickupId: id, collectOtp, cashRefundDuePaise };
}

/**
 * Cash the driver must carry to this pickup.
 *
 * A COD order was paid in notes, so its refund is paid back in notes — handed over at
 * the moment the goods are collected. The amount is computed here, server-side, and the
 * driver only attests to it; letting a driver name the figure would be a skimming
 * surface.
 *
 * Three bounds, all load-bearing:
 *   - only the non-wallet share is cash (wallet money returns to the wallet)
 *   - never more than the order actually collected in cash (`codCollectedPaise`)
 *   - minus cash already handed on this order, so a SECOND partial return nets the
 *     first one even though its refund may not exist yet
 */
async function computeCashRefundDue(
  database: typeof Db,
  order: { id: string; paymentMethod: string; codCollectedPaise: number | null },
  returnIds: string[],
): Promise<number> {
  if (order.paymentMethod !== 'cod') return 0;
  const collected = order.codCollectedPaise ?? 0;
  if (collected <= 0) return 0;

  const quote = await quoteReturnRefundPaise(database, returnIds);
  if (quote <= 0) return 0;

  const basis = await loadRefundBasis(database, order.id);
  const { originalTenderPortion } = splitRefundTenders(basis, Math.min(quote, basis.refundablePaise));

  const priorHandovers = await database.query.refundCashHandovers.findMany({
    where: eq(refundCashHandovers.orderId, order.id),
    columns: { amountPaise: true },
  });
  const alreadyHanded = priorHandovers.reduce((s, h) => s + h.amountPaise, 0);

  return Math.max(Math.min(originalTenderPortion, collected - alreadyHanded), 0);
}
