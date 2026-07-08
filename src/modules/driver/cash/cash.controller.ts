/**
 * Driver COD cash surface. The append-only ledger is the truth:
 *   outstanding = Σ collected − Σ deposited(confirmed)
 * A deposit REQUEST moves nothing — the ledger entry lands only when the ops
 * desk confirms receipt of the physical cash (admin drivers module).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents, driverCashDeposits, driverCashLedger } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { RequestDepositBody } from './cash.validators.js';

type Auth = AccessTokenPayload;

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

/** Ledger truth for one driver: collected / deposited totals + outstanding. */
export async function computeCashBalance(driverId: string): Promise<{
  collectedTotalPaise: number;
  depositedTotalPaise: number;
  outstandingPaise: number;
  pendingDepositPaise: number;
  pendingDepositId: string | null;
}> {
  const [totals] = await db
    .select({
      collected: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'collected'), 0)::int`,
      deposited: sql<number>`coalesce(sum(${driverCashLedger.amountPaise}) filter (where ${driverCashLedger.entryKind} = 'deposited'), 0)::int`,
    })
    .from(driverCashLedger)
    .where(eq(driverCashLedger.driverId, driverId));
  const collected = totals?.collected ?? 0;
  const deposited = totals?.deposited ?? 0;
  const pending = await db.query.driverCashDeposits.findFirst({
    where: and(eq(driverCashDeposits.driverId, driverId), eq(driverCashDeposits.status, 'pending')),
    columns: { id: true, amountPaise: true },
  });
  return {
    collectedTotalPaise: collected,
    depositedTotalPaise: deposited,
    outstandingPaise: collected - deposited,
    pendingDepositPaise: pending?.amountPaise ?? 0,
    pendingDepositId: pending?.id ?? null,
  };
}

export async function getBalance(input: { auth: Auth }) {
  const driverId = await getDriverId(input.auth);
  return ok(await computeCashBalance(driverId));
}

/** Deposit history, newest first. */
export async function listDeposits(input: { auth: Auth }) {
  const driverId = await getDriverId(input.auth);
  const rows = await db.query.driverCashDeposits.findMany({
    where: eq(driverCashDeposits.driverId, driverId),
    orderBy: desc(driverCashDeposits.createdAt),
    limit: 50,
  });
  return ok(rows);
}

/**
 * Declare a deposit (hand the cash to the ops desk). Defaults to the full
 * outstanding amount. One pending declaration at a time; nothing moves on the
 * ledger until an admin confirms.
 */
export async function requestDeposit(input: {
  auth: Auth;
  body: z.infer<typeof RequestDepositBody>;
}) {
  const driverId = await getDriverId(input.auth);
  const balance = await computeCashBalance(driverId);
  if (balance.pendingDepositId) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'A deposit is already awaiting confirmation at the ops desk',
    );
  }
  const amountPaise = input.body.amountPaise ?? balance.outstandingPaise;
  if (amountPaise <= 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'No cash outstanding to deposit');
  }
  if (amountPaise > balance.outstandingPaise) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Cannot deposit more than the outstanding ₹${(balance.outstandingPaise / 100).toFixed(2)}`,
    );
  }
  const id = newId(IdPrefix.DriverCashDeposit);
  await db.insert(driverCashDeposits).values({
    id,
    driverId,
    amountPaise,
    note: input.body.note ?? null,
  });
  return ok({ depositId: id, amountPaise, status: 'pending' });
}
