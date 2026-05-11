/**
 * Retailer-side returns + held-items. Scoped to the authenticated retailer's store.
 *
 * - GET  /retailer/returns
 * - POST /retailer/orders/:id/returns/open-counter   (counter return)
 * - POST /retailer/returns/:id/verify                 (store verification)
 * - GET  /retailer/held-items
 * - POST /retailer/held-items/:id/collect-at-counter
 * - POST /retailer/held-items/:id/redeliver
 */
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { heldItems, orderItems, orders, retailerAccounts, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import {
  forceDispose,
  markCollectedAtCounter,
  markRedelivered,
} from '@/shared/held-items/dispositions.js';

async function getOwnStoreId(req: { auth?: { sub: string } }): Promise<string> {
  const sub = req.auth?.sub;
  if (!sub) throw AppError.unauthorized();
  const r = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, sub),
    columns: { id: true, storeId: true, status: true },
  });
  if (!r) throw AppError.unauthorized('Retailer account not found');
  if (!r.storeId) throw new AppError(409, ErrorCode.NotOwner, 'No store linked');
  if (r.status !== 'active') throw new AppError(403, ErrorCode.RetailerNotApproved, `${r.status}`);
  return r.storeId;
}

const retailerReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/returns — list returns for own store =====
  app.get(
    '/returns',
    {
      schema: {
        querystring: z.object({
          decision: z.enum(['pending', 'accepted', 'rejected']).optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });

      const storeOrderIds = (
        await db.query.orders.findMany({
          where: eq(orders.storeId, storeId),
          columns: { id: true },
        })
      ).map((o) => o.id);
      if (storeOrderIds.length === 0) return ok([]);

      const itemIds = (
        await db.query.orderItems.findMany({
          where: inArray(orderItems.orderId, storeOrderIds),
          columns: { id: true },
        })
      ).map((i) => i.id);
      if (itemIds.length === 0) return ok([]);

      const conds: SQL[] = [inArray(returns.orderItemId, itemIds)];
      if (req.query.decision) conds.push(eq(returns.storeDecision, req.query.decision));
      const rows = await db.query.returns.findMany({
        where: and(...conds),
        orderBy: desc(returns.openedAt),
        limit: req.query.limit,
        with: { orderItem: { with: { order: true } } },
      });
      return ok(rows);
    },
  );

  // Counter return
  app.post(
    '/orders/:id/returns/open-counter',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          items: z
            .array(
              z.object({
                orderItemId: z.string().min(1),
                reasonText: z.string().trim().max(500).optional(),
                photos: z.array(z.string().url()).optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      // Verify the order belongs to this retailer's store before opening the return.
      const orderRow = await db.query.orders.findFirst({
        where: eq(orders.id, req.params.id),
        columns: { id: true, storeId: true },
      });
      if (!orderRow || orderRow.storeId !== storeId) {
        throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found for your store');
      }

      const r = await openReturn(db, {
        orderId: req.params.id,
        items: req.body.items,
        counterReturn: true,
        actor: { type: 'retailer', id: auth.sub },
      });
      return ok(r);
    },
  );

  // Store verification (scoped)
  app.post(
    '/returns/:id/verify',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          decision: z.enum(['accepted', 'rejected']),
          reasonNote: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      const r = await verifyReturn(db, {
        returnId: req.params.id,
        decision: req.body.decision,
        reasonNote: req.body.reasonNote,
        actor: { type: 'retailer', id: auth.sub },
        expectedStoreId: storeId,
      });
      return ok(r);
    },
  );

  // Held items list (own store)
  app.get(
    '/held-items',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['holding', 'expired', 'resolved']).optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      const conds: SQL[] = [eq(heldItems.storeId, storeId)];
      if (req.query.status) conds.push(eq(heldItems.status, req.query.status));
      const where = conds.length === 1 ? conds[0] : and(...conds);
      const rows = await db.query.heldItems.findMany({
        ...(where && { where }),
        orderBy: desc(heldItems.holdingWindowExpiresAt),
        limit: req.query.limit,
        with: {
          return: { with: { orderItem: { with: { order: true } } } },
        },
      });
      return ok(rows);
    },
  );

  app.post(
    '/held-items/:id/collect-at-counter',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      const r = await markCollectedAtCounter(db, req.params.id, {
        type: 'retailer',
        id: auth.sub,
      }, storeId);
      return ok(r);
    },
  );

  app.post(
    '/held-items/:id/redeliver',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      const r = await markRedelivered(db, req.params.id, {
        type: 'retailer',
        id: auth.sub,
      }, storeId);
      return ok(r);
    },
  );

  app.post(
    '/held-items/:id/record-disposition',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          disposition: z.enum(['restocked', 'forfeited_to_store', 'written_off']),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      await getOwnStoreId({ auth });
      const r = await forceDispose(db, {
        heldId: req.params.id,
        disposition: req.body.disposition,
        reason: req.body.note ?? '',
        actor: { type: 'retailer', id: auth.sub },
      });
      return ok(r);
    },
  );
};

export default retailerReturnsRoutes;
