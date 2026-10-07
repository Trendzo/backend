/**
 * "New order" alert for the store an order was just routed / offered to.
 *
 * Fans an inbox row + native push out to every account on the store that holds `orders.view`
 * (floor staff included, anyone an owner stripped it from excluded). Idempotent per
 * (order, store): the dedupe key is stored on the inbox row, so a webhook replay, the
 * paid-not-routed sweep re-driving the order, or a re-route window extension to the SAME
 * store never alerts twice — while a re-route to a DIFFERENT store (new storeId) still
 * alerts that store exactly once.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';

const DELIVERY_LABEL: Record<string, string> = {
  express: 'Express delivery',
  standard: 'Standard delivery',
  pickup: 'Store pickup',
  try_and_buy: 'Try & Buy',
};

/** 149900 -> "₹1,499"; 149950 -> "₹1,499.50". */
function formatRupees(paise: number): string {
  const rupees = paise / 100;
  const whole = Number.isInteger(rupees);
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function newOrderDedupeKey(orderId: string, storeId: string): string {
  return `order.new:${orderId}:${storeId}`;
}

/**
 * Notify the order's current store of a new order awaiting acceptance. Returns the number of
 * accounts notified (0 when already notified, the order is gone, or nobody holds orders.view).
 */
export async function notifyStoreOfNewOrder(orderId: string): Promise<number> {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: {
      id: true,
      storeId: true,
      deliveryMethod: true,
      grandTotalPaise: true,
      acceptanceDeadlineAt: true,
    },
    with: { items: { columns: { qty: true } } },
  });
  if (!order) return 0;

  const itemCount = order.items.reduce((n, i) => n + i.qty, 0);
  const parts = [
    `${itemCount} item${itemCount === 1 ? '' : 's'}`,
    formatRupees(order.grandTotalPaise),
  ];
  const delivery = DELIVERY_LABEL[order.deliveryMethod];
  if (delivery) parts.push(delivery);

  return notifyStoreAccounts({
    storeId: order.storeId,
    kind: 'order',
    eventKind: 'order.new',
    title: 'New order',
    body: parts.join(' · '),
    deepLink: `/retailer/orders/${order.id}`,
    payload: {
      orderId: order.id,
      storeId: order.storeId,
      itemCount,
      grandTotalPaise: order.grandTotalPaise,
      deliveryMethod: order.deliveryMethod,
      acceptanceDeadlineAt: order.acceptanceDeadlineAt?.toISOString() ?? null,
    },
    requirePermission: 'orders.view',
    dedupeKey: newOrderDedupeKey(order.id, order.storeId),
  });
}
