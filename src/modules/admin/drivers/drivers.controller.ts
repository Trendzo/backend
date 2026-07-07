/**
 * Admin driver directory + account management. Suspending a driver blocks their token
 * (the auth middleware rejects non-active drivers) and removes them from dispatch.
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents, orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { OrderStatus } from '@/shared/orders/state-machine.js';
import type { ListDriversQuery } from './drivers.validators.js';

const ACTIVE_DELIVERY_STATUSES: OrderStatus[] = [
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'returning_to_store',
];

export async function listDrivers(input: { query: z.infer<typeof ListDriversQuery> }) {
  const rows = await db.query.deliveryAgents.findMany({
    orderBy: (d, { desc: dd }) => dd(d.createdAt),
  });
  const loadRows = await db
    .select({ driverId: orders.assignedAgentId, n: count() })
    .from(orders)
    .where(inArray(orders.status, ACTIVE_DELIVERY_STATUSES))
    .groupBy(orders.assignedAgentId);
  const load = new Map<string, number>();
  for (const r of loadRows) if (r.driverId) load.set(r.driverId, Number(r.n));

  const q = input.query.q?.trim().toLowerCase();
  const status = input.query.status;

  const list = rows
    .filter((d) => (status ? d.status === status : true))
    .filter((d) =>
      q
        ? (d.name ?? '').toLowerCase().includes(q) ||
          d.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
          (d.vehicleNumber ?? '').toLowerCase().includes(q)
        : true,
    )
    .map((d) => ({
      id: d.id,
      name: d.name,
      phone: d.phone,
      vehicleType: d.vehicleType,
      vehicleNumber: d.vehicleNumber,
      city: d.city,
      status: d.status,
      activeDeliveries: load.get(d.id) ?? 0,
      currentLat: d.currentLat,
      currentLng: d.currentLng,
      lastLocationAt: d.lastLocationAt,
      createdAt: d.createdAt,
    }));
  return ok(list);
}

async function setStatus(id: string, status: 'active' | 'suspended') {
  const rows = await db
    .update(deliveryAgents)
    .set({ status })
    .where(eq(deliveryAgents.id, id))
    .returning({ id: deliveryAgents.id });
  if (rows.length === 0) throw new AppError(404, ErrorCode.NotFound, 'Driver not found');
  return ok({ id, status });
}

export async function suspendDriver(input: { id: string }) {
  // Free any packed order this driver was holding so it returns to the dispatch pool.
  await db
    .update(orders)
    .set({ assignedAgentId: null, agentHandoffCode: null })
    .where(and(eq(orders.assignedAgentId, input.id), eq(orders.status, 'packed')));
  return setStatus(input.id, 'suspended');
}

export async function activateDriver(input: { id: string }) {
  return setStatus(input.id, 'active');
}
