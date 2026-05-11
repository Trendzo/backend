import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { earlyDisbursementRequests } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

function shapeRequest(r: typeof earlyDisbursementRequests.$inferSelect & { store?: { legalName: string } | null }) {
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: r.store?.legalName ?? r.storeId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
  };
}

const adminEarlyDisbursementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/early-disbursement-decisions =====
  app.get(
    '/early-disbursement-decisions',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const rows = await db.query.earlyDisbursementRequests.findMany({
        where: req.query.status ? eq(earlyDisbursementRequests.status, req.query.status) : undefined,
        orderBy: desc(earlyDisbursementRequests.requestedAt),
        limit: req.query.limit,
        with: { store: true },
      });

      return ok(rows.map(shapeRequest));
    },
  );

  // ===== POST /admin/early-disbursement-decisions/:id/approve =====
  app.post(
    '/early-disbursement-decisions/:id/approve',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const r = await db.query.earlyDisbursementRequests.findFirst({
        where: eq(earlyDisbursementRequests.id, req.params.id),
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Request not found');
      if (r.status !== 'pending') {
        throw new AppError(409, ErrorCode.InvalidState, 'Request is not pending');
      }

      await db
        .update(earlyDisbursementRequests)
        .set({ status: 'approved', decidedAt: new Date(), decidedByAccountId: auth.sub })
        .where(eq(earlyDisbursementRequests.id, req.params.id));

      return ok({ id: req.params.id, status: 'approved' });
    },
  );

  // ===== POST /admin/early-disbursement-decisions/:id/reject =====
  app.post(
    '/early-disbursement-decisions/:id/reject',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const r = await db.query.earlyDisbursementRequests.findFirst({
        where: eq(earlyDisbursementRequests.id, req.params.id),
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Request not found');
      if (r.status !== 'pending') {
        throw new AppError(409, ErrorCode.InvalidState, 'Request is not pending');
      }

      await db
        .update(earlyDisbursementRequests)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionNote: req.body.reason,
        })
        .where(eq(earlyDisbursementRequests.id, req.params.id));

      return ok({ id: req.params.id, status: 'rejected' });
    },
  );
};

export default adminEarlyDisbursementRoutes;
