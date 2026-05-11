import { and, desc, eq, sql, sum } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { payouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

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

const adminSettlementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/payouts — all stores, failed pinned =====
  app.get(
    '/payouts',
    {
      schema: {
        querystring: z.object({
          storeId: z.string().optional(),
          status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const conditions = [];
      if (req.query.storeId) conditions.push(eq(payouts.storeId, req.query.storeId));
      if (req.query.status) conditions.push(eq(payouts.status, req.query.status));

      const rows = await db.query.payouts.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(payouts.createdAt),
        limit: req.query.limit,
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
    },
  );

  // ===== GET /admin/payouts/:id — single payout with full breakdown =====
  app.get(
    '/payouts/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const p = await db.query.payouts.findFirst({
        where: eq(payouts.id, req.params.id),
        with: { store: true, bankAccount: true },
      });
      if (!p) throw new AppError(404, ErrorCode.NotFound, 'Payout not found');

      const deductions: Array<{ kind: string; label: string; amountPaise: number }> = [];
      if (Number(p.commissionPaise) > 0)
        deductions.push({ kind: 'commission', label: 'Platform commission', amountPaise: Number(p.commissionPaise) });
      if (Number(p.commissionTaxPaise) > 0)
        deductions.push({ kind: 'commission_tax', label: 'GST on commission', amountPaise: Number(p.commissionTaxPaise) });
      if (Number(p.refundsHeldPaise) > 0)
        deductions.push({ kind: 'refunds', label: 'Refunds held', amountPaise: Number(p.refundsHeldPaise) });
      if (Number(p.adjustmentsPaise) !== 0)
        deductions.push({ kind: 'adjustments', label: 'Adjustments', amountPaise: Math.abs(Number(p.adjustmentsPaise)) });

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
    },
  );
  // ===== GET /admin/tail-of-cycle — failed payouts at end of cycle =====
  app.get('/tail-of-cycle', async () => {
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
  });

  // ===== GET /admin/billing-console — monthly summaries for all stores =====
  app.get('/billing-console', async () => {
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
        const status: 'open' | 'closing' | 'closed' = r.anyProcessing ? 'closing' : r.anyPending ? 'open' : 'closed';
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
  });
};

export default adminSettlementRoutes;
