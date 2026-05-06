/**
 * Admin returns + refunds + held-items.
 *
 * - POST /admin/orders/:id/returns/open  (admin-on-behalf-of-consumer)
 * - GET  /admin/returns + GET /:id
 * - POST /admin/returns/:id/verify
 * - GET  /admin/refunds + GET /:id
 * - POST /admin/refunds/:id/disbursements/:dId/force-fail
 * - POST /admin/refunds/:id/disbursements/:dId/retry
 * - GET  /admin/held-items
 * - POST /admin/held-items/:id/extend
 * - POST /admin/held-items/:id/force-dispose
 * - POST /admin/held-items/:id/mark-expired
 */
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  heldItems,
  refundDisbursements,
  refunds,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import { forceFailDisbursement } from '@/shared/refunds/force-fail.js';
import { retryDisbursement } from '@/shared/refunds/retry.js';
import {
  extendHoldingWindow,
  forceDispose,
  markExpired,
} from '@/shared/held-items/dispositions.js';

const adminReturnsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ─── Open return on behalf of consumer ───
  app.post(
    '/orders/:id/returns/open',
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
      const adminId = req.auth?.sub ?? 'admin';
      const r = await openReturn(db, {
        orderId: req.params.id,
        items: req.body.items,
        counterReturn: false,
        actor: { type: 'admin', id: adminId },
      });
      return ok(r);
    },
  );

  // ─── Returns: list + detail + verify ───
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
      const conds: SQL[] = [];
      if (req.query.decision) conds.push(eq(returns.storeDecision, req.query.decision));
      const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
      const rows = await db.query.returns.findMany({
        ...(where && { where }),
        orderBy: desc(returns.openedAt),
        limit: req.query.limit,
        with: { orderItem: { with: { order: true } } },
      });
      return ok(rows);
    },
  );

  app.get(
    '/returns/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const r = await db.query.returns.findFirst({
        where: eq(returns.id, req.params.id),
        with: { orderItem: { with: { order: true } } },
      });
      if (!r) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
      return ok(r);
    },
  );

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
      const adminId = req.auth?.sub ?? 'admin';
      const r = await verifyReturn(db, {
        returnId: req.params.id,
        decision: req.body.decision,
        reasonNote: req.body.reasonNote,
        actor: { type: 'admin', id: adminId },
      });
      return ok(r);
    },
  );

  // ─── Refunds ───
  app.get(
    '/refunds',
    {
      schema: {
        querystring: z.object({
          status: z
            .enum(['pending', 'processing', 'succeeded', 'partially_disbursed', 'failed'])
            .optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const where = req.query.status ? eq(refunds.status, req.query.status) : undefined;
      const rows = await db.query.refunds.findMany({
        ...(where && { where }),
        orderBy: desc(refunds.createdAt),
        limit: req.query.limit,
        with: {
          lines: true,
          disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
        },
      });
      return ok(rows);
    },
  );

  app.get(
    '/refunds/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const r = await db.query.refunds.findFirst({
        where: eq(refunds.id, req.params.id),
        with: {
          lines: true,
          disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
        },
      });
      if (!r) throw new AppError(404, ErrorCode.RefundNotFound, 'Refund not found');
      return ok(r);
    },
  );

  app.post(
    '/refunds/:id/disbursements/:dId/force-fail',
    {
      schema: {
        params: z.object({ id: z.string(), dId: z.string() }),
        body: z.object({ reason: z.string().trim().min(3).max(300) }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await forceFailDisbursement(db, {
        disbursementId: req.params.dId,
        reason: req.body.reason,
        actor: { type: 'admin', id: adminId },
      });
      return ok(r);
    },
  );

  app.post(
    '/refunds/:id/disbursements/:dId/retry',
    {
      schema: { params: z.object({ id: z.string(), dId: z.string() }) },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await retryDisbursement(db, {
        disbursementId: req.params.dId,
        actor: { type: 'admin', id: adminId },
      });
      return ok(r);
    },
  );

  // ─── Held items ───
  app.get(
    '/held-items',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['holding', 'expired', 'resolved']).optional(),
          storeId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const conds: SQL[] = [];
      if (req.query.status) conds.push(eq(heldItems.status, req.query.status));
      if (req.query.storeId) conds.push(eq(heldItems.storeId, req.query.storeId));
      const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
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
    '/held-items/:id/extend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          daysExtra: z.number().int().positive().max(60),
          reason: z.string().trim().min(3).max(500),
        }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await extendHoldingWindow(db, {
        heldId: req.params.id,
        daysExtra: req.body.daysExtra,
        reason: req.body.reason,
        adminId,
      });
      return ok(r);
    },
  );

  app.post(
    '/held-items/:id/force-dispose',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          disposition: z.enum(['restocked', 'forfeited_to_store', 'written_off']),
          reason: z.string().trim().min(3).max(500),
        }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await forceDispose(db, {
        heldId: req.params.id,
        disposition: req.body.disposition,
        reason: req.body.reason,
        actor: { type: 'admin', id: adminId },
      });
      return ok(r);
    },
  );

  app.post(
    '/held-items/:id/mark-expired',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await markExpired(db, req.params.id, { type: 'admin', id: adminId });
      return ok(r);
    },
  );
};

export default adminReturnsRoutes;
