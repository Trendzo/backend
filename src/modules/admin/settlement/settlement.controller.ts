import { and, desc, eq, sql, sum } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { billingStatements, payouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { previewCycle, runCycle } from '@/shared/settlement/run-cycle.js';
import { retryPayout, transitionPayout } from '@/shared/settlement/transition-payout.js';
import { runMonthlyClose } from '@/shared/settlement/statement.js';
import type {
  BillingCloseBody,
  BillingStatementsQuery,
  MarkCompleteBody,
  MarkFailedBody,
  PayoutListQuery,
  PayoutPreviewBody,
  PayoutRunBody,
} from './settlement.validators.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

function formatPeriod(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const s = start.toLocaleDateString('en-IN', opts);
  const e = end.toLocaleDateString('en-IN', { ...opts, year: 'numeric' });
  return `${s}–${e}`;
}

function mapStatus(status: string): string {
  return status === 'completed' ? 'paid' : status;
}

function maskAccount(accountNumber: string): string {
  return `•••• ${accountNumber.slice(-4)}`;
}

export async function listPayouts(input: { query: z.infer<typeof PayoutListQuery> }) {
  const { query } = input;
  const conditions = [];
  if (query.storeId) conditions.push(eq(payouts.storeId, query.storeId));
  if (query.status) conditions.push(eq(payouts.status, query.status));

  const rows = await db.query.payouts.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(payouts.createdAt),
    limit: query.limit,
    with: { store: true, bankAccount: true },
  });

  return ok(
    rows.map((p) => ({
      id: p.id,
      storeId: p.storeId,
      storeName: p.store?.legalName ?? p.storeId,
      period: formatPeriod(p.cycleStart, p.cycleEnd),
      amountPaise: Number(p.netPaise),
      status: mapStatus(p.status),
      bankAccountMasked: p.bankAccount ? maskAccount(p.bankAccount.accountNumber) : '—',
      bankConfirmationRef: p.gatewayPayoutId,
      retryCount: 0,
      initiatedAt: p.initiatedAt ? p.initiatedAt.toISOString() : null,
      settledAt: p.completedAt ? p.completedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    })),
  );
}

export async function getPayout(id: string) {
  const p = await db.query.payouts.findFirst({
    where: eq(payouts.id, id),
    with: { store: true, bankAccount: true },
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');

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

  return ok({
    id: p.id,
    storeId: p.storeId,
    storeName: p.store?.legalName ?? p.storeId,
    period: formatPeriod(p.cycleStart, p.cycleEnd),
    cycleStart: p.cycleStart.toISOString(),
    cycleEnd: p.cycleEnd.toISOString(),
    grossPaise: Number(p.grossPaise),
    commissionPaise: Number(p.commissionPaise),
    commissionTaxPaise: Number(p.commissionTaxPaise),
    refundsHeldPaise: Number(p.refundsHeldPaise),
    adjustmentsPaise: Number(p.adjustmentsPaise),
    netPaise: Number(p.netPaise),
    amountPaise: Number(p.netPaise),
    status: mapStatus(p.status),
    bankAccountMasked: p.bankAccount ? maskAccount(p.bankAccount.accountNumber) : '—',
    bankConfirmationRef: p.gatewayPayoutId,
    retryCount: 0,
    initiatedAt: p.initiatedAt ? p.initiatedAt.toISOString() : null,
    settledAt: p.completedAt ? p.completedAt.toISOString() : null,
    statementUrl: p.statementUrl,
    createdAt: p.createdAt.toISOString(),
    deductions,
  });
}

export async function getTailOfCycle() {
  const failed = await db.query.payouts.findMany({
    where: eq(payouts.status, 'failed'),
    orderBy: desc(payouts.createdAt),
    with: { store: true },
  });

  return ok(
    failed.map((p) => ({
      storeId: p.storeId,
      storeName: p.store?.legalName ?? p.storeId,
      period: formatPeriod(p.cycleStart, p.cycleEnd),
      unreconciledPaise: Number(p.netPaise),
      reasonHints: ['Failed bank transfer', `Payout ID: ${p.id}`],
    })),
  );
}

export async function previewPayoutCycle(input: { body: z.infer<typeof PayoutPreviewBody> }) {
  const aggregate = await previewCycle({
    storeId: input.body.storeId,
    cycleStart: new Date(input.body.cycleStart),
    cycleEnd: new Date(input.body.cycleEnd),
  });
  return ok(serializeAggregate(aggregate));
}

export async function runPayoutCycle(input: {
  body: z.infer<typeof PayoutRunBody>;
  auth: AccessTokenPayload;
}) {
  const result = await runCycle({
    storeId: input.body.storeId,
    cycleStart: new Date(input.body.cycleStart),
    cycleEnd: new Date(input.body.cycleEnd),
    bankAccountId: input.body.bankAccountId,
    actor: { type: 'admin', id: input.auth.sub },
  });
  if (result.alreadyExisted) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Payout for this cycle already exists: ${result.payoutId}`,
    );
  }
  return ok({
    payoutId: result.payoutId,
    aggregate: serializeAggregate(result.aggregate),
  });
}

export async function initiatePayout(input: { id: string; auth: AccessTokenPayload }) {
  const r = await transitionPayout({
    payoutId: input.id,
    toStatus: 'processing',
    actor: { type: 'admin', id: input.auth.sub },
  });
  return ok(r);
}

export async function markPayoutComplete(input: {
  id: string;
  body: z.infer<typeof MarkCompleteBody>;
  auth: AccessTokenPayload;
}) {
  const r = await transitionPayout({
    payoutId: input.id,
    toStatus: 'completed',
    bankConfirmationRef: input.body.bankConfirmationRef,
    actor: { type: 'admin', id: input.auth.sub },
  });
  return ok(r);
}

export async function markPayoutFailed(input: {
  id: string;
  body: z.infer<typeof MarkFailedBody>;
  auth: AccessTokenPayload;
}) {
  const r = await transitionPayout({
    payoutId: input.id,
    toStatus: 'failed',
    failureReason: input.body.reason,
    actor: { type: 'admin', id: input.auth.sub },
  });
  return ok(r);
}

export async function retryFailedPayout(input: { id: string; auth: AccessTokenPayload }) {
  const r = await retryPayout({
    payoutId: input.id,
    actor: { type: 'admin', id: input.auth.sub },
  });
  return ok(r);
}

export async function closeBillingPeriod(input: { body: z.infer<typeof BillingCloseBody> }) {
  const r = await runMonthlyClose({ period: input.body.period });
  return ok({
    period: r.period,
    statementCount: r.statements.length,
    statements: r.statements.map((s) => ({
      storeId: s.storeId,
      statementId: s.statementId,
      alreadyExisted: s.alreadyExisted,
      netPayoutPaise: Number(s.netPayoutPaise),
    })),
  });
}

export async function listBillingStatements(input: { query: z.infer<typeof BillingStatementsQuery> }) {
  const conds = [];
  if (input.query.storeId) conds.push(eq(billingStatements.storeId, input.query.storeId));
  if (input.query.period) conds.push(eq(billingStatements.period, input.query.period));
  const rows = await db.query.billingStatements.findMany({
    where: conds.length > 0 ? and(...conds) : undefined,
    orderBy: desc(billingStatements.createdAt),
    limit: input.query.limit,
  });
  return ok(rows.map(shapeStatement));
}

export async function getBillingStatementPdf(input: { id: string }) {
  const row = await db.query.billingStatements.findFirst({
    where: eq(billingStatements.id, input.id),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Statement not found');
  if (!row.pdfUrl) {
    throw new AppError(409, ErrorCode.InvalidState, 'Statement PDF not yet rendered');
  }
  return ok({ statementId: row.id, period: row.period, pdfUrl: row.pdfUrl });
}

function shapeStatement(row: typeof billingStatements.$inferSelect) {
  return {
    id: row.id,
    storeId: row.storeId,
    legalEntityId: row.legalEntityId,
    period: row.period,
    commissionPaise: Number(row.commissionPaise),
    commissionTaxPaise: Number(row.commissionTaxPaise),
    addOnFeesPaise: Number(row.addOnFeesPaise),
    tcsPaise: Number(row.tcsPaise),
    disputeLiabilitiesPaise: Number(row.disputeLiabilitiesPaise),
    adjustmentsPaise: Number(row.adjustmentsPaise),
    netPayoutPaise: Number(row.netPayoutPaise),
    pdfUrl: row.pdfUrl,
    status: row.status,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeAggregate(a: import('@/shared/settlement/payout-math.js').CycleAggregate) {
  return {
    grossPaise: Number(a.grossPaise),
    commissionPaise: Number(a.commissionPaise),
    commissionTaxPaise: Number(a.commissionTaxPaise),
    refundsHeldPaise: Number(a.refundsHeldPaise),
    adjustmentsPaise: Number(a.adjustmentsPaise),
    disputeLiabilitiesPaise: Number(a.disputeLiabilitiesPaise),
    disputeHoldPaise: Number(a.disputeHoldPaise),
    tcsPaise: Number(a.tcsPaise),
    netPaise: Number(a.netPaise),
    orderCount: a.orderCount,
    includedOrderIds: a.includedOrderIds,
    activeHoldIds: a.activeHoldIds,
    unattachedAdjustmentIds: a.unattachedAdjustmentIds,
  };
}

export async function getBillingConsole() {
  // Aggregate payouts by year-month bucket.
  const rows = await db
    .select({
      month: sql<string>`to_char(${payouts.cycleStart}, 'YYYY-MM')`,
      storesIncluded: sql<number>`COUNT(DISTINCT ${payouts.storeId})::int`,
      totalGrossPaise: sum(payouts.grossPaise),
      totalCommissionPaise: sum(payouts.commissionPaise),
      totalNetPaise: sum(payouts.netPaise),
      anyPending: sql<boolean>`BOOL_OR(${payouts.status} = 'pending')`,
      anyProcessing: sql<boolean>`BOOL_OR(${payouts.status} = 'processing')`,
    })
    .from(payouts)
    .groupBy(sql`to_char(${payouts.cycleStart}, 'YYYY-MM')`)
    .orderBy(desc(sql`to_char(${payouts.cycleStart}, 'YYYY-MM')`));

  return ok(
    rows.map((r) => {
      const [year, mon] = r.month.split('-');
      const d = new Date(Number(year), Number(mon) - 1, 1);
      const period = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      const status: 'open' | 'closing' | 'closed' = r.anyProcessing
        ? 'closing'
        : r.anyPending
          ? 'open'
          : 'closed';
      return {
        period,
        status,
        storesIncluded: r.storesIncluded,
        totalGrossPaise: Number(r.totalGrossPaise ?? 0),
        totalCommissionPaise: Number(r.totalCommissionPaise ?? 0),
        totalNetPaise: Number(r.totalNetPaise ?? 0),
        closedAt: status === 'closed' ? null : null,
        gstReturnStatus: 'pending' as const,
      };
    }),
  );
}
