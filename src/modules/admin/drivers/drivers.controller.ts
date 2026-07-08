/**
 * Admin driver directory + account management. Suspending a driver blocks their token
 * (the auth middleware rejects non-active drivers) and removes them from dispatch.
 */
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAgents,
  driverCashDeposits,
  driverCashLedger,
  driverEarnings,
  orders,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { OrderStatus } from '@/shared/orders/state-machine.js';
import type { DecideDepositBody, ListDepositsQuery, ListDriversQuery } from './drivers.validators.js';

const ACTIVE_DELIVERY_STATUSES: OrderStatus[] = [
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'returning_to_store',
];

/** Per-driver ledger totals: outstanding = Σcollected − Σdeposited(confirmed). */
async function cashOutstandingByDriver(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      driverId: driverCashLedger.driverId,
      outstanding: sql<number>`(
        coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'collected'), 0)
        - coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'deposited'), 0)
      )::int`,
    })
    .from(driverCashLedger)
    .groupBy(driverCashLedger.driverId);
  return new Map(rows.map((r) => [r.driverId, Number(r.outstanding)]));
}

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
  const cash = await cashOutstandingByDriver();
  const pendingRows = await db.query.driverCashDeposits.findMany({
    where: eq(driverCashDeposits.status, 'pending'),
    columns: { id: true, driverId: true, amountPaise: true },
  });
  const pendingByDriver = new Map(pendingRows.map((p) => [p.driverId, p]));

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
      cashOutstandingPaise: cash.get(d.id) ?? 0,
      pendingDeposit: pendingByDriver.has(d.id)
        ? {
            id: pendingByDriver.get(d.id)!.id,
            amountPaise: pendingByDriver.get(d.id)!.amountPaise,
          }
        : null,
    }));
  return ok(list);
}

/** One driver: profile + cash + lifetime earnings + recent deposits + live load. */
export async function getDriverDetail(input: { id: string }) {
  const d = await db.query.deliveryAgents.findFirst({ where: eq(deliveryAgents.id, input.id) });
  if (!d) throw new AppError(404, ErrorCode.NotFound, 'Driver not found');

  const [ledger] = await db
    .select({
      collected: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'collected'), 0)::int`,
      deposited: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'deposited'), 0)::int`,
    })
    .from(driverCashLedger)
    .where(eq(driverCashLedger.driverId, input.id));
  const [earn] = await db
    .select({
      total: sql<number>`coalesce(sum(${driverEarnings.totalPaise}), 0)::int`,
      legs: sql<number>`count(*)::int`,
    })
    .from(driverEarnings)
    .where(eq(driverEarnings.driverId, input.id));
  const [active] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.assignedAgentId, input.id), inArray(orders.status, ACTIVE_DELIVERY_STATUSES)));
  const deposits = await db.query.driverCashDeposits.findMany({
    where: eq(driverCashDeposits.driverId, input.id),
    orderBy: desc(driverCashDeposits.createdAt),
    limit: 10,
  });

  const collected = ledger?.collected ?? 0;
  const deposited = ledger?.deposited ?? 0;
  return ok({
    driver: d,
    cash: {
      collectedTotalPaise: collected,
      depositedTotalPaise: deposited,
      outstandingPaise: collected - deposited,
    },
    earnings: { totalPaise: earn?.total ?? 0, legs: earn?.legs ?? 0 },
    activeDeliveries: Number(active?.n ?? 0),
    deposits,
  });
}

/** Ops queue: cash deposits across drivers (default: pending). */
export async function listCashDeposits(input: { query: z.infer<typeof ListDepositsQuery> }) {
  const status = input.query.status ?? 'pending';
  const rows = await db.query.driverCashDeposits.findMany({
    where: eq(driverCashDeposits.status, status),
    orderBy: desc(driverCashDeposits.createdAt),
    limit: 100,
    with: { driver: { columns: { id: true, name: true, phone: true } } },
  });
  return ok(rows);
}

/**
 * Ops desk received the physical cash — confirm the deposit. Guarded flip
 * pending→confirmed; the 'deposited' ledger entry lands in the same tx
 * (exactly-once via the flip + the partial unique on deposit_id).
 */
export async function confirmDeposit(input: {
  auth: { sub: string };
  id: string;
  depositId: string;
  body: z.infer<typeof DecideDepositBody>;
}) {
  const result = await db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(driverCashDeposits)
      .set({
        status: 'confirmed',
        decidedByAdminId: input.auth.sub,
        decidedAt: new Date(),
        adminNote: input.body.note ?? null,
      })
      .where(
        and(
          eq(driverCashDeposits.id, input.depositId),
          eq(driverCashDeposits.driverId, input.id),
          eq(driverCashDeposits.status, 'pending'),
        ),
      )
      .returning({ id: driverCashDeposits.id, amountPaise: driverCashDeposits.amountPaise });
    if (!flipped) return null;
    await tx.insert(driverCashLedger).values({
      id: newId(IdPrefix.DriverCashLedger),
      driverId: input.id,
      entryKind: 'deposited',
      amountPaise: flipped.amountPaise,
      depositId: flipped.id,
    });
    return flipped;
  });
  if (!result) {
    throw new AppError(409, ErrorCode.InvalidState, 'Deposit is not pending (already decided?)');
  }
  return ok({ depositId: result.id, amountPaise: result.amountPaise, status: 'confirmed' });
}

/** Deposit declared but cash never arrived / amount wrong — reject; nothing moves. */
export async function rejectDeposit(input: {
  auth: { sub: string };
  id: string;
  depositId: string;
  body: z.infer<typeof DecideDepositBody>;
}) {
  const [flipped] = await db
    .update(driverCashDeposits)
    .set({
      status: 'rejected',
      decidedByAdminId: input.auth.sub,
      decidedAt: new Date(),
      adminNote: input.body.note ?? null,
    })
    .where(
      and(
        eq(driverCashDeposits.id, input.depositId),
        eq(driverCashDeposits.driverId, input.id),
        eq(driverCashDeposits.status, 'pending'),
      ),
    )
    .returning({ id: driverCashDeposits.id });
  if (!flipped) {
    throw new AppError(409, ErrorCode.InvalidState, 'Deposit is not pending (already decided?)');
  }
  return ok({ depositId: flipped.id, status: 'rejected' });
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
    .set({ assignedAgentId: null, agentHandoffCode: null, agentAssignedAt: null })
    .where(and(eq(orders.assignedAgentId, input.id), eq(orders.status, 'packed')));
  return setStatus(input.id, 'suspended');
}

export async function activateDriver(input: { id: string }) {
  return setStatus(input.id, 'active');
}
