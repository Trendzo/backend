import { and, between, count, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { bankAccounts, orders, payouts, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

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

function shapePayoutRow(p: typeof payouts.$inferSelect, bankAccount: typeof bankAccounts.$inferSelect | null) {
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
    deductions.push({ kind: 'commission', label: 'Platform commission', amountPaise: Number(p.commissionPaise) });
  if (Number(p.commissionTaxPaise) > 0)
    deductions.push({ kind: 'commission_tax', label: 'GST on commission', amountPaise: Number(p.commissionTaxPaise) });
  if (Number(p.refundsHeldPaise) > 0)
    deductions.push({ kind: 'refunds', label: 'Refunds held', amountPaise: Number(p.refundsHeldPaise) });
  if (Number(p.adjustmentsPaise) !== 0)
    deductions.push({ kind: 'adjustments', label: 'Adjustments', amountPaise: Math.abs(Number(p.adjustmentsPaise)) });
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
    .where(and(eq(orders.storeId, storeId), between(orders.placedAt, p.cycleStart, p.cycleEnd)));

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

const retailerSettlementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/payouts =====
  app.get(
    '/payouts',
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const rows = await db.query.payouts.findMany({
        where: eq(payouts.storeId, storeId),
        orderBy: desc(payouts.createdAt),
        limit: req.query.limit,
        with: { bankAccount: true },
      });

      return ok(rows.map((p) => shapePayoutRow(p, p.bankAccount)));
    },
  );

  // ===== GET /retailer/payouts/:id =====
  app.get(
    '/payouts/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const p = await db.query.payouts.findFirst({
        where: and(eq(payouts.id, req.params.id), eq(payouts.storeId, storeId)),
        with: { bankAccount: true },
      });
      if (!p) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');

      return ok({
        ...shapePayoutRow(p, p.bankAccount),
        deductions: buildDeductions(p),
      });
    },
  );

  // ===== GET /retailer/billing-statements =====
  app.get(
    '/billing-statements',
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const rows = await db.query.payouts.findMany({
        where: eq(payouts.storeId, storeId),
        orderBy: desc(payouts.createdAt),
        limit: req.query.limit,
      });

      return ok(await Promise.all(rows.map((p) => shapeBillingStatement(p, storeId))));
    },
  );

  // ===== GET /retailer/billing-statements/:id =====
  app.get(
    '/billing-statements/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const p = await db.query.payouts.findFirst({
        where: and(eq(payouts.id, req.params.id), eq(payouts.storeId, storeId)),
      });
      if (!p) throw new AppError(404, ErrorCode.NotFound, 'Statement not found');

      const statement = await shapeBillingStatement(p, storeId);
      return ok({ ...statement, liabilityBookings: [] });
    },
  );
};

export default retailerSettlementRoutes;
