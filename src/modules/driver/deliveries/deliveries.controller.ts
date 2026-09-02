/**
 * Driver delivery surface. A driver is a STANDALONE identity (`kind:'driver'`,
 * `delivery_agents` row); every endpoint is scoped to the orders assigned to that
 * driver (`orders.assignedAgentId === auth.sub`). Orders are put here by the admin
 * dispatch desk. Door visit + undelivered reuse the shared order helpers, acting as
 * the `delivery_agent` actor (the actor-type literal is decoupled from the token kind).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '@/config/env.js';
import { db } from '@/db/client.js';
import { deliveryAgents, deliveryAttempts, orderItems, orders, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import { arriveOrderAtStore } from '@/shared/orders/arrive-at-store.js';
import { settleCodPaymentOnDelivery } from '@/shared/payments/settle-cod.js';
import {
  openDoor,
  extendDoor,
  closeDoor,
  recordAgentDoorDecision,
} from '@/shared/orders/door-visit.js';
import { pushConsumer } from '@/shared/push/notify-push.js';
import { recordUndelivered } from '@/shared/orders/undelivered.js';
import { type OrderStatus, transitionsFrom } from '@/shared/orders/state-machine.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AcceptReturnBody,
  DeliverBody,
  DoorCloseBody,
  DoorExtendBody,
  DoorOpenBody,
  ListDeliveriesQuery,
  MarkUndeliveredBody,
  RejectReturnBody,
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

// QA test backdoor: '1111' is accepted as the consumer delivery OTP so QA can close
// doors / deliver without the real code. Gated to non-production — in production the
// real crypto OTP is the ONLY accepted value.
const TEST_DELIVERY_OTP = '1111';
const ALLOW_TEST_OTP = env.NODE_ENV !== 'production';
function otpOk(orderOtp: string | null, submitted: string | undefined): boolean {
  if (!orderOtp) return true; // legacy orders with no OTP
  if (submitted === orderOtp) return true;
  return ALLOW_TEST_OTP && submitted === TEST_DELIVERY_OTP;
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
          galleryImageSnap: true,
          // Live customer-driven door staging so the driver UI can show pending returns.
          customerDoorChoice: true,
          agentDoorDecision: true,
          agentReturnReason: true,
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
  if (!otpOk(order.deliveryOtp, input.body.otp)) {
    throw new AppError(403, ErrorCode.ValidationError, 'Delivery OTP missing or incorrect');
  }

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
  // Cash collected: flip the pending COD payment to succeeded + record codCollectedPaise.
  await settleCodPaymentOnDelivery(db, {
    orderId: input.id,
    collectedPaise: input.body.codCollectedPaise,
  }).catch((err) => {
    console.error(`[driver-deliver] settle COD ${input.id}: ${(err as Error).message}`);
  });
  // Driver earnings are recorded centrally in transitionOrder's →delivered block (see
  // shared/orders/transition.ts) so every completion path pays — not just this one.
  return ok(transition);
}

/**
 * Handover: the driver enters the OTP the customer reads out. This is the ONLY place the
 * delivery OTP is checked for a Try-and-Buy order — verifying it opens the door and starts
 * the try-on window. `openDoor`'s transition asserts source `out_for_delivery`, so the OTP
 * can't be bypassed by a wrong-state call.
 */
export async function doorOpen(input: { auth: Auth; id: string; body: z.infer<typeof DoorOpenBody> }) {
  const driverId = await getDriverId(input.auth);
  const order = await loadAssignedOrder(input.id, driverId);
  if (!otpOk(order.deliveryOtp, input.body.otp)) {
    throw new AppError(403, ErrorCode.ValidationError, 'Delivery OTP missing or incorrect');
  }
  const r = await openDoor(db, input.id, actorOf(input.auth));
  // Tell the customer their try-on window is live.
  void pushConsumer(order.consumerId, {
    title: 'Your try-on has started',
    body: 'Try your items and choose Keep or Return for each in the app.',
    data: { type: 'door_opened', orderId: input.id },
  }).catch(() => undefined);
  return ok(r);
}

/** Driver accepts a customer's requested return (goods travel back to the store). */
export async function acceptReturn(input: {
  auth: Auth;
  id: string;
  itemId: string;
  body: z.infer<typeof AcceptReturnBody>;
}) {
  const driverId = await getDriverId(input.auth);
  const order = await loadAssignedOrder(input.id, driverId);
  const r = await recordAgentDoorDecision(db, input.id, input.itemId, 'accept_return', {}, actorOf(input.auth));
  void pushConsumer(order.consumerId, {
    title: 'Return accepted',
    body: 'The rider accepted your return. Your refund starts once it reaches the store.',
    data: { type: 'return_accepted', orderId: input.id, orderItemId: input.itemId },
  }).catch(() => undefined);
  return ok({ orderItemId: input.itemId, agentDoorDecision: 'accept_return', ...r });
}

/** Driver inspects and rejects a return at the door (item stays with the customer; evidence required). */
export async function rejectReturn(input: {
  auth: Auth;
  id: string;
  itemId: string;
  body: z.infer<typeof RejectReturnBody>;
}) {
  const driverId = await getDriverId(input.auth);
  const order = await loadAssignedOrder(input.id, driverId);
  const r = await recordAgentDoorDecision(
    db,
    input.id,
    input.itemId,
    'reject_return',
    { reason: input.body.reason, photos: input.body.photos },
    actorOf(input.auth),
  );
  void pushConsumer(order.consumerId, {
    title: 'Return not accepted',
    body: `The rider could not accept this return: ${input.body.reason}`,
    data: { type: 'return_rejected', orderId: input.id, orderItemId: input.itemId },
  }).catch(() => undefined);
  return ok({ orderItemId: input.itemId, agentDoorDecision: 'reject_return', ...r });
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

/**
 * Driver "finish the visit" — used on timer expiry ("mark remaining kept") or to close a
 * fully-resolved window. OTP already proved handover at door/open, so none is needed here.
 * With no `items` body it closes from the accumulated per-item staging (undecided → kept),
 * and refuses if a customer-requested return is still awaiting the driver's response. An
 * explicit `items` payload keeps the legacy all-at-once close. Earnings + COD settle happen
 * inside closeDoor/transitionOrder on the delivered branch.
 */
export async function doorClose(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorCloseBody>;
}) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const r = await closeDoor(
    db,
    input.id,
    actorOf(input.auth),
    input.body.items
      ? { decisions: input.body.items, trigger: 'all_at_once' }
      : { trigger: 'driver_finish' },
  );
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

/** Driver has physically dropped the goods back at the store. Arrival auto-accepts
 *  pending door returns (refund-on-arrival) and finalizes the order. */
export async function markReturned(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await loadAssignedOrder(input.id, driverId);
  const result = await arriveOrderAtStore(db, input.id, {
    type: 'delivery_agent',
    id: input.auth.sub,
  });
  return ok(result);
}
