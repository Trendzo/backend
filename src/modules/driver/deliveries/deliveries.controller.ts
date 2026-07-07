/**
 * Driver delivery surface. A driver is a STANDALONE identity (`kind:'driver'`,
 * `delivery_agents` row); every endpoint is scoped to the orders assigned to that
 * driver (`orders.assignedAgentId === auth.sub`). Orders are put here by the admin
 * dispatch desk. Door visit + undelivered reuse the shared order helpers, acting as
 * the `delivery_agent` actor (the actor-type literal is decoupled from the token kind).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents, deliveryAttempts, orderItems, orders, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import { recordDriverEarnings } from '@/shared/orders/driver-earnings.js';
import { openDoor, extendDoor, closeDoor } from '@/shared/orders/door-visit.js';
import { recordUndelivered } from '@/shared/orders/undelivered.js';
import { type OrderStatus, transitionsFrom } from '@/shared/orders/state-machine.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  DeliverBody,
  DoorCloseBody,
  DoorExtendBody,
  ListDeliveriesQuery,
  MarkUndeliveredBody,
} from './deliveries.validators.js';

type Auth = AccessTokenPayload;

/** Resolve the calling driver, asserting the standalone account is active. */
async function getDriverId(auth: Auth): Promise<string> {
  const driver = await db.query.deliveryAgents.findFirst({
    where: eq(deliveryAgents.id, auth.sub),
    columns: { id: true, status: true },
  });
  if (!driver) throw AppError.unauthorized('Driver account not found');
  if (driver.status !== 'active') {
    throw new AppError(403, ErrorCode.DriverInactive, `Account is ${driver.status}`);
  }
  return driver.id;
}

/** Load an order only if it is assigned to this driver. */
async function loadAssignedOrder(orderId: string, driverId: string) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.assignedAgentId, driverId)),
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, `Order ${orderId} is not assigned to you`);
  }
  return order;
}

function actorOf(auth: Auth): { type: 'delivery_agent'; id: string } {
  return { type: 'delivery_agent', id: auth.sub };
}

// `packed` is included so an assigned driver sees the order as "ready for pickup" and
// can read out its handoff code to the store before the code-verified handover.
const ACTIVE_DELIVERY_STATUSES: OrderStatus[] = [
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'returning_to_store',
];

export async function listDeliveries(input: {
  auth: Auth;
  query: z.infer<typeof ListDeliveriesQuery>;
}) {
  const driverId = await getDriverId(input.auth);
  const statuses = input.query.status ? [input.query.status] : ACTIVE_DELIVERY_STATUSES;
  const rows = await db.query.orders.findMany({
    where: and(
      eq(orders.assignedAgentId, driverId),
      inArray(orders.status, statuses as OrderStatus[]),
    ),
    orderBy: asc(orders.placedAt),
    limit: input.query.limit,
    columns: {
      id: true,
      status: true,
      deliveryMethod: true,
      paymentMethod: true,
      grandTotalPaise: true,
      codCollectedPaise: true,
      // Store snapshot (name/addr) + customer snapshot (name/phone/addr + coords for maps).
      storeNameSnap: true,
      storeAddressSnap: true,
      consumerNameSnap: true,
      consumerPhoneSnap: true,
      addressLine1Snap: true,
      addressLine2Snap: true,
      addressCitySnap: true,
      addressPincodeSnap: true,
      addressLatSnap: true,
      addressLngSnap: true,
      doorWindowExpiresAt: true,
      placedAt: true,
      // Shown to the driver while `packed` so they can read it to the store at handover.
      agentHandoffCode: true,
    },
    with: {
      // Store phone + geo for the "call store" / navigate actions.
      store: { columns: { lat: true, lng: true, contactPhone: true } },
      items: {
        columns: {
          id: true,
          listingNameSnap: true,
          attributesLabelSnap: true,
          qty: true,
          listingId: true,
          listingPolicySnap: true,
        },
      },
    },
  });
  return ok(rows);
}

export async function getDelivery(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.id),
    with: {
      store: { columns: { lat: true, lng: true, contactPhone: true } },
      items: true,
    },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  return ok({
    ...order,
    availableTransitions: transitionsFrom(order.status as OrderStatus),
  });
}

export async function depart(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'out_for_delivery',
    actorType: 'delivery_agent',
    actorId: input.auth.sub,
    reason: 'agent_departed',
  });
  return ok(result);
}

/**
 * Standard (non-door) delivery completion: `out_for_delivery → delivered`. Verifies the
 * consumer-spoken delivery OTP (proof the handover reached the right person), finalizes
 * stock, and records a proof-of-delivery attempt stamped with the real driver id.
 */
export async function deliver(input: { auth: Auth; id: string; body: z.infer<typeof DeliverBody> }) {
  const driverId = await getDriverId(input.auth);
  const order = await loadAssignedOrder(input.id, driverId);
  if (order.deliveryOtp && input.body.otp !== order.deliveryOtp) {
    throw new AppError(403, ErrorCode.ValidationError, 'Delivery OTP missing or incorrect');
  }

  const isCod = order.paymentMethod === 'cod';
  const codCollectedPaise = isCod ? (input.body.codCollectedPaise ?? order.grandTotalPaise) : 0;

  const result = await db.transaction(async (tx) => {
    const items = await tx
      .select({ variantId: orderItems.variantId, qty: orderItems.qty })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.id));
    for (const it of items) {
      await tx
        .update(variants)
        .set({
          stock: sql`${variants.stock} - ${it.qty}`,
          reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)`,
        })
        .where(eq(variants.id, it.variantId));
    }

    if (isCod) {
      await tx
        .update(orders)
        .set({ codCollectedPaise })
        .where(eq(orders.id, input.id));
    }

    const existingAttempts = await tx
      .select({ attemptNumber: deliveryAttempts.attemptNumber })
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.orderId, input.id));
    const nextAttempt = existingAttempts.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;
    await tx.insert(deliveryAttempts).values({
      id: newId(IdPrefix.DeliveryAttempt),
      orderId: input.id,
      deliveryAgentId: driverId,
      attemptNumber: nextAttempt,
      outcome: 'delivered',
      notes: input.body.note ?? null,
      proofPhotos: input.body.proofPhotos ?? [],
      signatureUrl: input.body.signatureUrl ?? null,
    });
    return { nextAttempt };
  });

  const transition = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'delivered',
    actorType: 'delivery_agent',
    actorId: input.auth.sub,
    reason: 'delivery_confirmed',
    metadata: { attemptNumber: result.nextAttempt },
  });
  await recordDriverEarnings(db, {
    orderId: input.id,
    driverId,
    deliveryMethod: order.deliveryMethod,
  });
  return ok(transition);
}

export async function doorOpen(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const r = await openDoor(db, input.id, actorOf(input.auth));
  return ok(r);
}

export async function doorExtend(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorExtendBody>;
}) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const r = await extendDoor(db, input.id, actorOf(input.auth), input.body.reason);
  return ok(r);
}

export async function doorClose(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorCloseBody>;
}) {
  const driverId = await getDriverId(input.auth);
  const order = await loadAssignedOrder(input.id, driverId);
  // Handover proof: orders that carry a delivery OTP can only be closed with the
  // consumer-spoken code. Legacy orders (NULL otp) close without one.
  if (order.deliveryOtp && input.body.otp !== order.deliveryOtp) {
    throw new AppError(403, ErrorCode.ValidationError, 'Delivery OTP missing or incorrect');
  }
  const r = await closeDoor(db, input.id, actorOf(input.auth), input.body.items);
  // Try-and-buy that ends with the customer keeping ≥1 item counts as a delivery — pay out.
  if (r.toStatus === 'delivered') {
    await recordDriverEarnings(db, {
      orderId: input.id,
      driverId,
      deliveryMethod: order.deliveryMethod,
    });
  }
  return ok(r);
}

export async function markUndelivered(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof MarkUndeliveredBody>;
}) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const result = await recordUndelivered(db, {
    orderId: input.id,
    actor: actorOf(input.auth),
    reason: input.body.reason,
    proofPhotos: input.body.photos ?? [],
    deliveryAgentId: driverId,
  });
  return ok(result);
}

/** Driver starts carrying goods back to the store (undelivered / recalled leg). */
export async function returnToStore(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'returning_to_store',
    actorType: 'delivery_agent',
    actorId: input.auth.sub,
    reason: 'agent_returning',
  });
  return ok(result);
}

/** Driver has physically dropped the goods back at the store. */
export async function markReturned(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'returned_to_store',
    actorType: 'delivery_agent',
    actorId: input.auth.sub,
    reason: 'agent_returned_to_store',
  });
  return ok(result);
}
