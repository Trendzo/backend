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
  returns as returnsTable,
  reversePickups,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { generateDeliveryOtp } from '@/shared/orders/pickup-code.js';

export async function createReversePickupForReturns(
  database: typeof Db,
  input: { orderId: string; returnIds: string[] },
): Promise<{ reversePickupId: string; collectOtp: string } | null> {
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

  const id = newId(IdPrefix.ReversePickup);
  const collectOtp = generateDeliveryOtp();
  await database.insert(reversePickups).values({
    id,
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
  return { reversePickupId: id, collectOtp };
}
