/**
 * Delivery-agent surface. The agent is a retailer staff account with sub-role
 * 'delivery_agent'; every endpoint is scoped to the orders assigned to that agent
 * (`orders.assignedAgentId === auth.sub`). Door visit + undelivered reuse the same
 * shared order helpers as the retailer, but act as the `delivery_agent` actor.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { orders, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { transitionOrder } from '@/shared/orders/transition.js';
import { openDoor, extendDoor, closeDoor } from '@/shared/orders/door-visit.js';
import { recordUndelivered } from '@/shared/orders/undelivered.js';
import { type OrderStatus, transitionsFrom } from '@/shared/orders/state-machine.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  DoorCloseBody,
  DoorExtendBody,
  ListDeliveriesQuery,
  MarkUndeliveredBody,
} from './deliveries.validators.js';

type Auth = AccessTokenPayload;

/** Resolve the calling agent, asserting the account is an active store agent. */
async function getAgent(auth: Auth): Promise<{ agentId: string; storeId: string }> {
  const acct = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, auth.sub),
    columns: { id: true, storeId: true, status: true, subRole: true },
  });
  if (!acct || !acct.storeId) throw AppError.unauthorized('Delivery agent account not found');
  if (acct.status !== 'active') {
    throw new AppError(403, ErrorCode.RetailerNotApproved, `Account is ${acct.status}`);
  }
  return { agentId: acct.id, storeId: acct.storeId };
}

/** Load an order only if it is assigned to this agent. */
async function loadAssignedOrder(orderId: string, agentId: string) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.assignedAgentId, agentId)),
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, `Order ${orderId} is not assigned to you`);
  }
  return order;
}

const ACTIVE_DELIVERY_STATUSES: OrderStatus[] = ['picked_up', 'out_for_delivery', 'at_door'];

function actorOf(auth: Auth): { type: 'delivery_agent'; id: string } {
  return { type: 'delivery_agent', id: auth.sub };
}

export async function listDeliveries(input: {
  auth: Auth;
  query: z.infer<typeof ListDeliveriesQuery>;
}) {
  const { agentId } = await getAgent(input.auth);
  const statuses = input.query.status ? [input.query.status] : ACTIVE_DELIVERY_STATUSES;
  const rows = await db.query.orders.findMany({
    where: and(eq(orders.assignedAgentId, agentId), inArray(orders.status, statuses as OrderStatus[])),
    orderBy: asc(orders.placedAt),
    limit: input.query.limit,
    columns: {
      id: true,
      status: true,
      deliveryMethod: true,
      consumerNameSnap: true,
      consumerPhoneSnap: true,
      addressLine1Snap: true,
      addressLine2Snap: true,
      addressCitySnap: true,
      addressPincodeSnap: true,
      grandTotalPaise: true,
      doorWindowExpiresAt: true,
      placedAt: true,
    },
    with: {
      items: { columns: { id: true, listingNameSnap: true, qty: true, listingId: true } },
    },
  });
  return ok(rows);
}

export async function getDelivery(input: { auth: Auth; id: string }) {
  const { agentId } = await getAgent(input.auth);
  const order = await loadAssignedOrder(input.id, agentId);
  const items = await db.query.orderItems.findMany({
    where: (oi, { eq: e }) => e(oi.orderId, order.id),
  });
  return ok({
    ...order,
    items,
    availableTransitions: transitionsFrom(order.status as OrderStatus),
  });
}

export async function depart(input: { auth: Auth; id: string }) {
  const { agentId } = await getAgent(input.auth);
  await loadAssignedOrder(input.id, agentId);
  const result = await transitionOrder(db, {
    orderId: input.id,
    toStatus: 'out_for_delivery',
    actorType: 'delivery_agent',
    actorId: input.auth.sub,
    reason: 'agent_departed',
  });
  return ok(result);
}

export async function doorOpen(input: { auth: Auth; id: string }) {
  const { agentId } = await getAgent(input.auth);
  await loadAssignedOrder(input.id, agentId);
  const r = await openDoor(db, input.id, actorOf(input.auth));
  return ok(r);
}

export async function doorExtend(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorExtendBody>;
}) {
  const { agentId } = await getAgent(input.auth);
  await loadAssignedOrder(input.id, agentId);
  const r = await extendDoor(db, input.id, actorOf(input.auth), input.body.reason);
  return ok(r);
}

export async function doorClose(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DoorCloseBody>;
}) {
  const { agentId } = await getAgent(input.auth);
  const order = await loadAssignedOrder(input.id, agentId);
  // Handover proof: orders that carry a delivery OTP can only be closed with the
  // consumer-spoken code. Legacy orders (NULL otp) close without one.
  if (order.deliveryOtp && input.body.otp !== order.deliveryOtp) {
    throw new AppError(403, ErrorCode.ValidationError, 'Delivery OTP missing or incorrect');
  }
  const r = await closeDoor(db, input.id, actorOf(input.auth), input.body.items);
  return ok(r);
}

export async function markUndelivered(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof MarkUndeliveredBody>;
}) {
  const { agentId } = await getAgent(input.auth);
  await loadAssignedOrder(input.id, agentId);
  const result = await recordUndelivered(db, {
    orderId: input.id,
    actor: actorOf(input.auth),
    reason: input.body.reason,
    proofPhotos: input.body.photos ?? [],
    deliveryAgentId: null, // agent is a retailer account, not a legacy deliveryAgents row
  });
  return ok(result);
}
