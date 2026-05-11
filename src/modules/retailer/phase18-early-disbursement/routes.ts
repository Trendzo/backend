import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { earlyDisbursementRequests, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

function shapeRequest(r: typeof earlyDisbursementRequests.$inferSelect, storeName?: string) {
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: storeName ?? r.storeId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
  };
}

const retailerEarlyDisbursementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/early-disbursement — list for current store =====
  app.get('/early-disbursement', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

    const rows = await db.query.earlyDisbursementRequests.findMany({
      where: eq(earlyDisbursementRequests.storeId, storeId),
      orderBy: desc(earlyDisbursementRequests.requestedAt),
      with: { store: true },
    });

    return ok(rows.map((r) => shapeRequest(r, r.store?.legalName)));
  });

  // ===== POST /retailer/early-disbursement — create request =====
  app.post(
    '/early-disbursement',
    {
      schema: {
        body: z.object({
          amountPaise: z.number().int().positive(),
          reason: z.string().trim().min(5).max(500),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const existing = await db.query.earlyDisbursementRequests.findFirst({
        where: and(
          eq(earlyDisbursementRequests.storeId, storeId),
          eq(earlyDisbursementRequests.status, 'pending'),
        ),
      });
      if (existing) {
        throw new AppError(409, ErrorCode.InvalidState, 'A pending early disbursement request already exists');
      }

      const id = newId('edr');
      await db.insert(earlyDisbursementRequests).values({
        id,
        storeId,
        amountPaise: req.body.amountPaise,
        reason: req.body.reason,
      });

      return ok({ id, status: 'pending' });
    },
  );
};

export default retailerEarlyDisbursementRoutes;
