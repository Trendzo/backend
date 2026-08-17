/**
 * Consumer-driven Try-and-Buy door decisions. During the try-on window (order at_door)
 * the customer chooses Keep or Return per item. 'keep' finalizes the item (and can
 * auto-close the visit); 'return' notifies the assigned driver, who accepts or inspects
 * it from the driver app. Ownership is asserted by orders.consumerId === auth.sub. There
 * is no OTP here — the OTP proved handover at door/open.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orderItems, orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { recordCustomerDoorChoice } from '@/shared/orders/door-visit.js';
import { pushDriver } from '@/shared/push/notify-push.js';

type Auth = AccessTokenPayload;

async function loadOwnedOrder(orderId: string, consumerId: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order || order.consumerId !== consumerId) {
    throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  }
  return order;
}

function doorState(
  customerDoorChoice: 'keep' | 'return' | null,
  agentDoorDecision: 'accept_return' | 'reject_return' | null,
) {
  if (agentDoorDecision === 'accept_return') return 'return_accepted';
  if (agentDoorDecision === 'reject_return') return 'return_rejected';
  if (customerDoorChoice === 'keep') return 'kept';
  if (customerDoorChoice === 'return') return 'return_requested';
  return 'undecided';
}

export async function keepItem(input: { auth: Auth; id: string; itemId: string }) {
  await loadOwnedOrder(input.id, input.auth.sub);
  const r = await recordCustomerDoorChoice(db, input.id, input.itemId, 'keep');
  return ok({ orderItemId: input.itemId, customerDoorChoice: 'keep', ...r });
}

export async function returnItem(input: { auth: Auth; id: string; itemId: string }) {
  const order = await loadOwnedOrder(input.id, input.auth.sub);
  const r = await recordCustomerDoorChoice(db, input.id, input.itemId, 'return');
  if (order.assignedAgentId) {
    const item = await db.query.orderItems.findFirst({
      where: eq(orderItems.id, input.itemId),
      columns: { listingNameSnap: true },
    });
    void pushDriver(order.assignedAgentId, {
      title: 'Return requested',
      body: `The customer wants to return ${item?.listingNameSnap ?? 'an item'}.`,
      data: { type: 'return_requested', orderId: input.id, orderItemId: input.itemId },
    }).catch(() => undefined);
  }
  return ok({ orderItemId: input.itemId, customerDoorChoice: 'return', ...r });
}

/** Compact try-on session for the consumer app to poll during the window. */
export async function getSession(input: { auth: Auth; id: string }) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.id),
    with: { items: true },
  });
  if (!order || order.consumerId !== input.auth.sub) {
    throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  }
  return ok({
    id: order.id,
    status: order.status,
    deliveryMethod: order.deliveryMethod,
    deliveryOtp: order.deliveryOtp,
    doorWindowExpiresAt: order.doorWindowExpiresAt,
    doorWindowExtendedAt: order.doorWindowExtendedAt,
    items: order.items.map((it) => ({
      id: it.id,
      name: it.listingNameSnap,
      image: it.galleryImageSnap,
      attributesLabel: it.attributesLabelSnap,
      policy: it.listingPolicySnap,
      customerDoorChoice: it.customerDoorChoice,
      agentDoorDecision: it.agentDoorDecision,
      agentReturnReason: it.agentReturnReason,
      doorState: doorState(it.customerDoorChoice, it.agentDoorDecision),
    })),
  });
}
