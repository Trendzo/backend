import { and, between, count, desc, eq, gt, isNull, sum } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  bankAccounts,
  billingStatements,
  invoices,
  orders,
  payoutAdjustments,
  payoutHolds,
  payouts,
  postPayoutRecoveries,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { LimitQuery } from './settlement.validators.js';

type Auth = AccessTokenPayload;

function maskAccount(accountNumber: string): string {
  return `•••• ${accountNumber.slice(-4)}`;
}

function formatPeriod(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const s = start.toLocaleDateString('en-IN', opts);
  const e = end.toLocaleDateString('en-IN', { ...opts, year: 'numeric' });
  return `${s}–${e}`;
}

function mapStatus(status: string): string {
  return status === 'completed' ? 'paid' : status;
}

function shapePayoutRow(
  p: typeof payouts.$inferSelect,
  bankAccount: typeof bankAccounts.$inferSelect | null,
) {
  return {
    id: p.id,
    storeId: p.storeId,
    period: formatPeriod(p.cycleStart, p.cycleEnd),
    cycleStart: p.cycleStart.toISOString(),
    cycleEnd: p.cycleEnd.toISOString(),
    grossPaise: Number(p.grossPaise),
    commissionPaise: Number(p.commissionPaise),
    commissionTaxPaise: Number(p.commissionTaxPaise),
    refundsHeldPaise: Number(p.refundsHeldPaise),
    adjustmentsPaise: Number(p.adjustmentsPaise),
    amountPaise: Number(p.netPaise),
    netPaise: Number(p.netPaise),
    status: mapStatus(p.status),
    bankAccountMasked: bankAccount ? maskAccount(bankAccount.accountNumber) : '—',
    bankConfirmationRef: p.gatewayPayoutId,
    retryCount: 0,
    initiatedAt: p.initiatedAt ? p.initiatedAt.toISOString() : null,
    settledAt: p.completedAt ? p.completedAt.toISOString() : null,
    statementUrl: p.statementUrl,
    createdAt: p.createdAt.toISOString(),
  };
}

function buildDeductions(p: typeof payouts.$inferSelect) {
  const deductions: Array<{ kind: string; label: string; amountPaise: number }> = [];
  if (Number(p.commissionPaise) > 0)
    deductions.push({
      kind: 'commission',
      label: 'Platform commission',
      amountPaise: Number(p.commissionPaise),
    });
  if (Number(p.commissionTaxPaise) > 0)
    deductions.push({
      kind: 'commission_tax',
      label: 'GST on commission',
      amountPaise: Number(p.commissionTaxPaise),
    });
  if (Number(p.refundsHeldPaise) > 0)
    deductions.push({
      kind: 'refunds',
      label: 'Refunds held',
      amountPaise: Number(p.refundsHeldPaise),
    });
  if (Number(p.adjustmentsPaise) !== 0)
    deductions.push({
      kind: 'adjustments',
      label: 'Adjustments',
      amountPaise: Math.abs(Number(p.adjustmentsPaise)),
    });
  return deductions;
}

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

function payoutStatusToBillingStatus(status: string): 'open' | 'closing' | 'closed' {
  if (status === 'completed' || status === 'paid') return 'closed';
  if (status === 'processing') return 'closing';
  return 'open';
}

async function shapeBillingStatement(p: typeof payouts.$inferSelect, storeId: string) {
  const [countResult] = await db
    .select({ count: count() })
    .from(orders)
    .where(
      and(eq(orders.storeId, storeId), between(orders.placedAt, p.cycleStart, p.cycleEnd)),
    );

  return {
    id: p.id,
    period: formatPeriod(p.cycleStart, p.cycleEnd),
    storeId: p.storeId,
    status: payoutStatusToBillingStatus(p.status),
    ordersCount: countResult?.count ?? 0,
    grossPaise: Number(p.grossPaise),
    commissionPaise: Number(p.commissionPaise),
    tcsPaise: Number(p.commissionTaxPaise),
    refundsPaise: Number(p.refundsHeldPaise),
    holdsPaise: 0,
    adjustmentsPaise: Number(p.adjustmentsPaise),
    netPaise: Number(p.netPaise),
    generatedAt: p.createdAt.toISOString(),
  };
}

export async function listPayouts(input: { auth: Auth; query: z.infer<typeof LimitQuery> }) {
  const storeId = await getStoreId(input.auth.sub);

  const rows = await db.query.payouts.findMany({
    where: eq(payouts.storeId, storeId),
    orderBy: desc(payouts.createdAt),
    limit: input.query.limit,
    with: { bankAccount: true },
  });

  return ok(rows.map((p) => shapePayoutRow(p, p.bankAccount)));
}

export async function getPayout(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);

  const p = await db.query.payouts.findFirst({
    where: and(eq(payouts.id, input.id), eq(payouts.storeId, storeId)),
    with: { bankAccount: true },
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');

  return ok({
    ...shapePayoutRow(p, p.bankAccount),
    deductions: buildDeductions(p),
  });
}

export async function listBillingStatements(input: {
  auth: Auth;
  query: z.infer<typeof LimitQuery>;
}) {
  const storeId = await getStoreId(input.auth.sub);

  const rows = await db.query.payouts.findMany({
    where: eq(payouts.storeId, storeId),
    orderBy: desc(payouts.createdAt),
    limit: input.query.limit,
  });

  return ok(await Promise.all(rows.map((p) => shapeBillingStatement(p, storeId))));
}

export async function getBillingStatement(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);

  const p = await db.query.payouts.findFirst({
    where: and(eq(payouts.id, input.id), eq(payouts.storeId, storeId)),
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Statement not found');

  const statement = await shapeBillingStatement(p, storeId);
  return ok({ ...statement, liabilityBookings: [] });
}

/**
 * §18 — Outstanding payable + next scheduled payout date for the retailer dashboard.
 * Outstanding = sum of delivered orders' netLine since the last paid cycleEnd.
 */
export async function getUpcomingPayout(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);
  const store = await db.query.retailerStores.findFirst({ where: eq(retailerStores.id, storeId) });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  const lastPaid = await db.query.payouts.findFirst({
    where: and(eq(payouts.storeId, storeId), eq(payouts.status, 'completed')),
    orderBy: desc(payouts.cycleEnd),
  });
  const sinceDate = lastPaid?.cycleEnd ?? new Date(0);
  const nextCycleDate = new Date(sinceDate.getTime() + store.payoutCadenceDays * 24 * 60 * 60 * 1000);

  // Pending orders contributing to upcoming payout.
  const pendingOrders = await db
    .select({
      id: orders.id,
      grandTotalPaise: orders.grandTotalPaise,
      itemsSubtotalPaise: orders.itemsSubtotalPaise,
      platformFeeBpSnap: orders.platformFeeBpSnap,
      tcsRateBpSnap: orders.tcsRateBpSnap,
      deliveredAt: orders.deliveredAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        eq(orders.status, 'delivered'),
        gt(orders.deliveredAt, sinceDate),
      ),
    );

  let outstandingGrossPaise = 0n;
  let outstandingCommissionPaise = 0n;
  let outstandingTcsPaise = 0n;
  const orderBreakdown: Array<{ orderId: string; gross: number; commission: number; tcs: number; net: number }> = [];
  for (const o of pendingOrders) {
    const gross = BigInt(o.grandTotalPaise);
    const commission = BigInt(Math.floor((o.itemsSubtotalPaise * o.platformFeeBpSnap) / 10_000));
    const tcs = BigInt(Math.floor((o.itemsSubtotalPaise * o.tcsRateBpSnap) / 10_000));
    outstandingGrossPaise += gross;
    outstandingCommissionPaise += commission;
    outstandingTcsPaise += tcs;
    orderBreakdown.push({
      orderId: o.id,
      gross: Number(gross),
      commission: Number(commission),
      tcs: Number(tcs),
      net: Number(gross - commission - tcs),
    });
  }

  // Active holds for store.
  const [holdSumRow] = await db
    .select({ total: sum(payoutHolds.amountPaise) })
    .from(payoutHolds)
    .where(and(eq(payoutHolds.storeId, storeId), eq(payoutHolds.status, 'active')));
  const heldPaise = Number(holdSumRow?.total ?? 0);

  // Unattached adjustments.
  const unattachedAdj = await db
    .select({ direction: payoutAdjustments.direction, amount: payoutAdjustments.amountPaise })
    .from(payoutAdjustments)
    .where(and(eq(payoutAdjustments.storeId, storeId), isNull(payoutAdjustments.payoutId)));
  let pendingAdjustmentsPaise = 0n;
  for (const a of unattachedAdj) {
    pendingAdjustmentsPaise += a.direction === 'credit' ? a.amount : -a.amount;
  }

  const outstandingPayable =
    Number(outstandingGrossPaise - outstandingCommissionPaise - outstandingTcsPaise) -
    heldPaise +
    Number(pendingAdjustmentsPaise);

  return ok({
    storeId,
    nextCycleDate: nextCycleDate.toISOString(),
    payoutCadenceDays: store.payoutCadenceDays,
    outstandingPayable,
    grossPaise: Number(outstandingGrossPaise),
    commissionPaise: Number(outstandingCommissionPaise),
    tcsPaise: Number(outstandingTcsPaise),
    heldPaise,
    pendingAdjustmentsPaise: Number(pendingAdjustmentsPaise),
    orderBreakdown,
    orderCount: orderBreakdown.length,
  });
}

/** §18 — Per-payout itemised deductions for retailer drill-down. */
export async function getPayoutDeductions(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);
  const p = await db.query.payouts.findFirst({
    where: and(eq(payouts.id, input.id), eq(payouts.storeId, storeId)),
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');

  const holds = await db.query.payoutHolds.findMany({
    where: eq(payoutHolds.payoutId, p.id),
  });
  const adjustments = await db.query.payoutAdjustments.findMany({
    where: eq(payoutAdjustments.payoutId, p.id),
  });
  const recoveries = await db.query.postPayoutRecoveries.findMany({
    where: eq(postPayoutRecoveries.payoutCycleId, p.id),
  });

  return ok({
    payoutId: p.id,
    cycle: { start: p.cycleStart.toISOString(), end: p.cycleEnd.toISOString() },
    breakdown: {
      grossPaise: Number(p.grossPaise),
      commissionPaise: Number(p.commissionPaise),
      commissionTaxPaise: Number(p.commissionTaxPaise),
      refundsHeldPaise: Number(p.refundsHeldPaise),
      tcsPaise: 0, // tracked at order level — retailer can see via billing statement
      priorOverPayoutsPaise: recoveries.reduce((s, r) => s + r.refundedPaise, 0),
      disputeHoldPaise: Number(p.disputeHoldPaise),
      adjustmentsPaise: Number(p.adjustmentsPaise),
      netPaise: Number(p.netPaise),
    },
    holds: holds.map((h) => ({
      id: h.id,
      disputeId: h.disputeId,
      amountPaise: Number(h.amountPaise),
      reason: h.reason,
      status: h.status,
    })),
    adjustments: adjustments.map((a) => ({
      id: a.id,
      direction: a.direction,
      amountPaise: Number(a.amountPaise),
      reason: a.reason,
    })),
    recoveries: recoveries.map((r) => ({
      id: r.id,
      refundId: r.refundId,
      orderId: r.orderId,
      refundedPaise: r.refundedPaise,
      plannedDebitPaise: r.plannedDebitPaise,
      reason: r.reason,
      status: r.status,
    })),
  });
}

/** §18 — Closed monthly billing statement PDF (retailer-scoped). */
export async function getBillingStatementPdf(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);
  const row = await db.query.billingStatements.findFirst({
    where: and(eq(billingStatements.id, input.id), eq(billingStatements.storeId, storeId)),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Statement not found');
  if (!row.pdfUrl) {
    throw new AppError(409, ErrorCode.InvalidState, 'Statement PDF not yet rendered');
  }
  return ok({ statementId: row.id, period: row.period, pdfUrl: row.pdfUrl });
}

void invoices;
