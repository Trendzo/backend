import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { postPayoutRecoveries } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

function shapeRow(
  r: typeof postPayoutRecoveries.$inferSelect & { store?: { legalName: string; id: string } | null },
) {
  return {
    id: r.id,
    refundId: r.refundId,
    orderId: r.orderId,
    retailerId: r.store?.id ?? r.storeId,
    retailerName: r.store?.legalName ?? r.storeId,
    payoutCycleId: r.payoutCycleId ?? null,
    refundedPaise: r.refundedPaise,
    plannedDebitPaise: r.plannedDebitPaise,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    scheduledFor: r.scheduledFor.toISOString(),
    settledAt: r.settledAt ? r.settledAt.toISOString() : null,
  };
}

const adminPostPayoutRecoveryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/post-payout-recovery =====
  app.get(
    '/post-payout-recovery',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['planned', 'debited', 'failed', 'cancelled']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const rows = await db.query.postPayoutRecoveries.findMany({
        where: req.query.status ? eq(postPayoutRecoveries.status, req.query.status) : undefined,
        orderBy: desc(postPayoutRecoveries.createdAt),
        limit: req.query.limit,
        with: { store: true },
      });

      return ok(rows.map(shapeRow));
    },
  );

  // ===== POST /admin/post-payout-recovery/:id/cancel =====
  app.post(
    '/post-payout-recovery/:id/cancel',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const r = await db.query.postPayoutRecoveries.findFirst({
        where: eq(postPayoutRecoveries.id, req.params.id),
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Recovery row not found');
      if (r.status !== 'planned') {
        throw new AppError(409, ErrorCode.InvalidState, 'Can only cancel planned recoveries');
      }

      await db
        .update(postPayoutRecoveries)
        .set({ status: 'cancelled' })
        .where(eq(postPayoutRecoveries.id, req.params.id));

      return ok({ id: req.params.id, status: 'cancelled' });
    },
  );
};

export default adminPostPayoutRecoveryRoutes;
