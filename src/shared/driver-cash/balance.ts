/**
 * Driver cash ledger totals — one definition.
 *
 * `Σcollected − Σdeposited` was hand-copied into three surfaces (the driver's own
 * balance, the admin driver list, the admin driver detail). Adding the subtractive
 * `refund_paid` kind to only some of them would have silently overstated a driver's
 * liability in exactly the surfaces that were missed, so the math moves here.
 *
 * A driver whose refunds exceed his collections goes NEGATIVE. That is correct and
 * means the platform owes him — the ops desk reimburses out of band.
 */
import { eq, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { driverCashLedger } from '@/db/schema/index.js';

export type DriverCashTotals = {
  collectedTotalPaise: number;
  depositedTotalPaise: number;
  /** Cash handed back to consumers at reverse pickups. */
  refundPaidTotalPaise: number;
  /** collected − deposited − refundPaid. May be negative (platform owes the driver). */
  outstandingPaise: number;
};

const ZERO: DriverCashTotals = {
  collectedTotalPaise: 0,
  depositedTotalPaise: 0,
  refundPaidTotalPaise: 0,
  outstandingPaise: 0,
};

function totalsOf(row: {
  collected: number | null;
  deposited: number | null;
  refundPaid: number | null;
}): DriverCashTotals {
  const collected = row.collected ?? 0;
  const deposited = row.deposited ?? 0;
  const refundPaid = row.refundPaid ?? 0;
  return {
    collectedTotalPaise: collected,
    depositedTotalPaise: deposited,
    refundPaidTotalPaise: refundPaid,
    outstandingPaise: collected - deposited - refundPaid,
  };
}

const SUMS = {
  collected: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'collected'), 0)::int`,
  deposited: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'deposited'), 0)::int`,
  refundPaid: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'refund_paid'), 0)::int`,
};

export async function computeDriverCashTotals(
  database: typeof Db,
  driverId: string,
): Promise<DriverCashTotals> {
  const [row] = await database
    .select(SUMS)
    .from(driverCashLedger)
    .where(eq(driverCashLedger.driverId, driverId));
  return row ? totalsOf(row) : { ...ZERO };
}

/** One grouped scan for the admin driver list, instead of N per-driver queries. */
export async function computeDriverCashTotalsByDriver(
  database: typeof Db,
): Promise<Map<string, DriverCashTotals>> {
  const rows = await database
    .select({ driverId: driverCashLedger.driverId, ...SUMS })
    .from(driverCashLedger)
    .groupBy(driverCashLedger.driverId);
  return new Map(rows.map((r) => [r.driverId, totalsOf(r)]));
}
