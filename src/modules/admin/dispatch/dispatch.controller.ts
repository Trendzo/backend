/**
 * Admin/ops dispatch desk. Standalone drivers are assigned to packed orders here
 * (retailers no longer assign). Assigning mints the store→driver handoff code on the
 * order; the order stays `packed` and surfaces in the driver app with the code, which
 * the store then verifies at `POST /retailer/orders/:id/handover` to release the parcel.
 *
 * The handoff code is NEVER returned to the admin — it must be read off the driver's
 * screen at the physical handover (that is the whole point of the proof).
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents, orders, reversePickups } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { generatePickupCode } from '@/shared/orders/pickup-code.js';
import { notifyOffersChanged } from '@/shared/orders/offers-bus.js';
import type { OrderStatus } from '@/shared/orders/state-machine.js';
import type {
  AssignDriverBody,
  CreateReversePickupBody,
  ListReversePickupsQuery,
} from './dispatch.validators.js';

const ACTIVE_DELIVERY_STATUSES: OrderStatus[] = [
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'returning_to_store',
];

/** All drivers with live status, last-known location, and current active load. */
export async function listDrivers() {
  const drivers = await db.query.deliveryAgents.findMany({
    orderBy: (d, { desc: dd }) => dd(d.createdAt),
  });
  const loadRows = await db
    .select({ driverId: orders.assignedAgentId, n: count() })
    .from(orders)
    .where(inArray(orders.status, ACTIVE_DELIVERY_STATUSES))
    .groupBy(orders.assignedAgentId);
  const loadByDriver = new Map<string, number>();
  for (const r of loadRows) {
    if (r.driverId) loadByDriver.set(r.driverId, Number(r.n));
  }
  return ok(
    drivers.map((d) => ({
      id: d.id,
      phone: d.phone,
      name: d.name,
      vehicleType: d.vehicleType,
      vehicleNumber: d.vehicleNumber,
      city: d.city,
      status: d.status,
      currentLat: d.currentLat,
      currentLng: d.currentLng,
      lastLocationAt: d.lastLocationAt,
      activeDeliveries: loadByDriver.get(d.id) ?? 0,
      createdAt: d.createdAt,
    })),
  );
}

/**
 * Packed orders for the dispatch board — both unassigned (awaiting a driver) and already
 * assigned (with their current driver, so admin can reassign/unassign). This is the manual
 * override surface for when broadcast auto-dispatch fails.
 */
export async function listPackedOrders() {
  const rows = await db.query.orders.findMany({
    where: eq(orders.status, 'packed'),
    orderBy: asc(orders.placedAt),
    limit: 200,
    columns: {
      id: true,
      storeId: true,
      storeNameSnap: true,
      deliveryMethod: true,
      consumerNameSnap: true,
      addressCitySnap: true,
      addressPincodeSnap: true,
      grandTotalPaise: true,
      placedAt: true,
      assignedAgentId: true,
    },
  });
  const driverIds = [...new Set(rows.map((r) => r.assignedAgentId).filter((x): x is string => !!x))];
  const drivers = driverIds.length
    ? await db.query.deliveryAgents.findMany({
        where: inArray(deliveryAgents.id, driverIds),
        columns: { id: true, name: true, phone: true },
      })
    : [];
  const byId = new Map(drivers.map((d) => [d.id, d]));
  return ok(
    rows.map((r) => {
      const d = r.assignedAgentId ? byId.get(r.assignedAgentId) : null;
      return {
        ...r,
        assignedDriver: d ? { id: d.id, name: d.name, phone: d.phone } : null,
      };
    }),
  );
}

async function loadActiveDriver(driverId: string) {
  const driver = await db.query.deliveryAgents.findFirst({
    where: eq(deliveryAgents.id, driverId),
    columns: { id: true, name: true, status: true },
  });
  if (!driver) {
    throw new AppError(422, ErrorCode.InvalidState, 'driverId is not a known driver');
  }
  if (driver.status !== 'active') {
    throw new AppError(409, ErrorCode.InvalidState, `Driver is ${driver.status}`);
  }
  return driver;
}

/**
 * Assign (or reassign) a driver to a packed order and mint the handoff code. Reuses the
 * existing code when re-confirming the same driver; mints a fresh one for a new driver.
 */
export async function assignDriver(input: { id: string; body: z.infer<typeof AssignDriverBody> }) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.id),
    columns: { id: true, status: true, assignedAgentId: true, agentHandoffCode: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'packed') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order is ${order.status} — only a packed order can be dispatched`,
    );
  }
  const driver = await loadActiveDriver(input.body.driverId);
  const code =
    order.assignedAgentId === driver.id && order.agentHandoffCode
      ? order.agentHandoffCode
      : generatePickupCode();
  await db
    .update(orders)
    .set({ assignedAgentId: driver.id, agentHandoffCode: code, agentAssignedAt: new Date() })
    .where(eq(orders.id, input.id));
  notifyOffersChanged(); // order left the broadcast pool
  // Never echo the code.
  return ok({ orderId: input.id, driverId: driver.id, driverName: driver.name });
}

/** Clear a driver assignment (order returns to the unassigned pool). */
export async function unassignDriver(input: { id: string }) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, input.id),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'packed') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order is ${order.status} — only a packed order can be unassigned`,
    );
  }
  await db
    .update(orders)
    .set({ assignedAgentId: null, agentHandoffCode: null, agentAssignedAt: null })
    .where(eq(orders.id, input.id));
  notifyOffersChanged(); // order returned to the broadcast pool
  return ok({ orderId: input.id });
}

/* ── Reverse pickups (driver collects a consumer return from home) ────────── */

/** Reverse-pickup board: tasks by status with driver + store labels. */
export async function listReversePickups(input: {
  query: z.infer<typeof ListReversePickupsQuery>;
}) {
  const rows = await db.query.reversePickups.findMany({
    where: input.query.status ? eq(reversePickups.status, input.query.status) : undefined,
    orderBy: asc(reversePickups.createdAt),
    limit: 200,
    with: {
      assignedDriver: { columns: { id: true, name: true, phone: true } },
      store: { columns: { id: true, legalName: true } },
      order: { columns: { consumerNameSnap: true, consumerPhoneSnap: true } },
    },
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      returnIds: r.returnIds,
      status: r.status,
      itemsLabel: r.itemsLabel,
      addressLine1: r.addressLine1,
      addressCity: r.addressCity,
      addressPincode: r.addressPincode,
      consumerName: r.order.consumerNameSnap,
      consumerPhone: r.order.consumerPhoneSnap,
      store: r.store,
      assignedDriver: r.assignedDriver,
      createdAt: r.createdAt,
      assignedAt: r.assignedAt,
      collectedAt: r.collectedAt,
      deliveredAt: r.deliveredAt,
    })),
  );
}

/** Recreate a task (e.g. after an admin cancel) for still-pending returns. */
export async function createReversePickupAdmin(input: {
  body: z.infer<typeof CreateReversePickupBody>;
}) {
  const { createReversePickupForReturns } = await import(
    '@/shared/reverse-pickups/create-task.js'
  );
  const task = await createReversePickupForReturns(db, {
    orderId: input.body.orderId,
    returnIds: input.body.returnIds,
  });
  if (!task) {
    throw new AppError(
      422,
      ErrorCode.InvalidState,
      'Nothing to collect — order has no home address or no returns given',
    );
  }
  notifyOffersChanged();
  return ok({ reversePickupId: task.reversePickupId });
}

/** Manually assign (or reassign) a driver — overrides the broadcast pool. */
export async function assignReversePickup(input: {
  id: string;
  body: z.infer<typeof AssignDriverBody>;
}) {
  const driver = await loadActiveDriver(input.body.driverId);
  const [updated] = await db
    .update(reversePickups)
    .set({ assignedDriverId: driver.id, status: 'assigned', assignedAt: new Date() })
    .where(
      and(
        eq(reversePickups.id, input.id),
        inArray(reversePickups.status, ['pending', 'assigned']),
      ),
    )
    .returning({ id: reversePickups.id });
  if (!updated) {
    throw new AppError(409, ErrorCode.InvalidState, 'Task cannot be assigned in its current state');
  }
  notifyOffersChanged();
  return ok({ reversePickupId: input.id, driverId: driver.id, driverName: driver.name });
}

/** Clear the driver — task returns to the broadcast pool. */
export async function unassignReversePickup(input: { id: string }) {
  const [updated] = await db
    .update(reversePickups)
    .set({ assignedDriverId: null, status: 'pending', assignedAt: null })
    .where(and(eq(reversePickups.id, input.id), eq(reversePickups.status, 'assigned')))
    .returning({ id: reversePickups.id });
  if (!updated) {
    throw new AppError(409, ErrorCode.InvalidState, 'Only an assigned task can be unassigned');
  }
  notifyOffersChanged();
  return ok({ reversePickupId: input.id });
}

/** Cancel the pickup task (the return itself stays open — store handles receipt another way). */
export async function cancelReversePickup(input: { id: string }) {
  const task = await db.query.reversePickups.findFirst({
    where: eq(reversePickups.id, input.id),
    columns: { id: true, consumerId: true },
  });
  if (!task) throw new AppError(404, ErrorCode.NotFound, 'Task not found');
  const [updated] = await db
    .update(reversePickups)
    .set({ status: 'cancelled', cancelledAt: new Date(), assignedDriverId: null, assignedAt: null })
    .where(
      and(
        eq(reversePickups.id, input.id),
        inArray(reversePickups.status, ['pending', 'assigned']),
      ),
    )
    .returning({ id: reversePickups.id });
  if (!updated) {
    throw new AppError(409, ErrorCode.InvalidState, 'Only a pending/assigned task can be cancelled');
  }
  notifyOffersChanged();
  const { notifyConsumer } = await import('@/shared/notify-consumer.js');
  await notifyConsumer({
    consumerId: task.consumerId,
    kind: 'order',
    title: 'Return pickup cancelled',
    body: 'The scheduled pickup was cancelled — the store will receive your items another way.',
  }).catch(() => undefined);
  return ok({ reversePickupId: input.id, status: 'cancelled' });
}
