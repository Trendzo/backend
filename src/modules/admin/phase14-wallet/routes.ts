import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { walletPayouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

function shapeWalletPayout(
  p: typeof walletPayouts.$inferSelect & { consumer?: { email: string } | null },
) {
  return {
    id: p.id,
    consumerId: p.consumerId,
    consumerEmail: p.consumer?.email ?? p.consumerId,
    balancePaise: p.balancePaise,
    closedAt: p.createdAt.toISOString(),
    claimWindowEndsAt: p.claimWindowEndsAt.toISOString(),
    status: p.status,
    bankAccountMasked: p.bankAccountRef ? `•••• ${p.bankAccountRef.slice(-4)}` : null,
    paidAt: p.disbursedAt ? p.disbursedAt.toISOString() : null,
  };
}

const adminWalletRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/wallet-payouts =====
  app.get(
    '/wallet-payouts',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['pending_claim', 'awaiting_bank', 'paid', 'escheated', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const rows = await db.query.walletPayouts.findMany({
        where: req.query.status ? eq(walletPayouts.status, req.query.status) : undefined,
        limit: req.query.limit,
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        with: { consumer: true },
      });

      return ok(rows.map(shapeWalletPayout));
    },
  );

  // ===== POST /admin/wallet-payouts/:id/disburse =====
  app.post(
    '/wallet-payouts/:id/disburse',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const p = await db.query.walletPayouts.findFirst({
        where: eq(walletPayouts.id, req.params.id),
      });
      if (!p) throw new AppError(404, ErrorCode.NotFound, 'Wallet payout not found');
      if (p.status !== 'pending_claim' && p.status !== 'failed') {
        throw new AppError(409, ErrorCode.InvalidState, 'Payout is not in a disbursable state');
      }

      await db
        .update(walletPayouts)
        .set({ status: 'awaiting_bank' })
        .where(eq(walletPayouts.id, req.params.id));

      return ok({ id: req.params.id, status: 'awaiting_bank' });
    },
  );

  // ===== POST /admin/wallet-payouts/:id/escheat =====
  app.post(
    '/wallet-payouts/:id/escheat',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const p = await db.query.walletPayouts.findFirst({
        where: eq(walletPayouts.id, req.params.id),
      });
      if (!p) throw new AppError(404, ErrorCode.NotFound, 'Wallet payout not found');
      if (p.status === 'paid' || p.status === 'escheated') {
        throw new AppError(409, ErrorCode.InvalidState, 'Payout is already settled');
      }

      await db
        .update(walletPayouts)
        .set({ status: 'escheated' })
        .where(eq(walletPayouts.id, req.params.id));

      return ok({ id: req.params.id, status: 'escheated' });
    },
  );
};

export default adminWalletRoutes;
