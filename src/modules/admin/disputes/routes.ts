import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  disputes,
  orders,
  returns,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth, getAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const DisputeStatusEnum = z.enum(['open', 'requested_evidence', 'decided', 'escalated']);
const DisputeDecisionEnum = z.enum(['refund', 'fresh_delivery', 'pickup', 'no_refund', 'split']);
const ActorTypeEnum = z.enum(['consumer', 'retailer', 'admin', 'delivery_agent', 'system']);

const adminDisputeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== POST /admin/disputes — open a dispute =====
  app.post(
    '/disputes',
    {
      schema: {
        body: z
          .object({
            orderId: z.string().optional(),
            returnId: z.string().optional(),
            openedByActorType: ActorTypeEnum,
            openedByActorId: z.string().trim().min(1),
            description: z.string().trim().min(1).max(2000),
            evidence: z.array(z.string().url()).default([]),
          })
          .refine(
            (v) => Boolean(v.orderId) !== Boolean(v.returnId),
            { message: 'Exactly one of orderId or returnId must be provided', path: ['orderId'] },
          ),
      },
    },
    async (req) => {
      const { orderId, returnId, openedByActorType, openedByActorId, description, evidence } =
        req.body;

      // Validate target exists
      if (orderId) {
        const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
        if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
      } else {
        const ret = await db.query.returns.findFirst({ where: eq(returns.id, returnId!) });
        if (!ret) throw new AppError(404, ErrorCode.ReturnNotFound, 'Return not found');
      }

      const id = newId(IdPrefix.Dispute);
      const [created] = await db
        .insert(disputes)
        .values({
          id,
          orderId: orderId ?? null,
          returnId: returnId ?? null,
          openedByActorType,
          openedByActorId,
          description,
          evidence,
        })
        .returning();

      return ok(withTargetKind(created!));
    },
  );

  // ===== GET /admin/disputes — list with optional filters =====
  app.get(
    '/disputes',
    {
      schema: {
        querystring: z.object({
          status: DisputeStatusEnum.optional(),
          orderId: z.string().optional(),
          returnId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const { status, orderId, returnId, limit, offset } = req.query;
      const filters = [];
      if (status) filters.push(eq(disputes.status, status));
      if (orderId) filters.push(eq(disputes.orderId, orderId));
      if (returnId) filters.push(eq(disputes.returnId, returnId));
      const where =
        filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

      const rows = await db.query.disputes.findMany({
        ...(where && { where }),
        orderBy: desc(disputes.openedAt),
        limit,
        offset,
      });
      return ok(rows.map(withTargetKind));
    },
  );

  // ===== GET /admin/disputes/:id — full detail =====
  app.get(
    '/disputes/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const dispute = await db.query.disputes.findFirst({
        where: eq(disputes.id, req.params.id),
      });
      if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');

      // Attach a summary of the linked target for context.
      let target: Record<string, unknown> | null = null;
      if (dispute.orderId) {
        const order = await db.query.orders.findFirst({
          where: eq(orders.id, dispute.orderId),
          columns: { id: true, status: true, consumerId: true, storeId: true, placedAt: true, grandTotalPaise: true },
        });
        target = order ?? null;
      } else if (dispute.returnId) {
        const ret = await db.query.returns.findFirst({
          where: eq(returns.id, dispute.returnId),
          columns: { id: true, kind: true, storeDecision: true, openedAt: true, orderItemId: true },
          with: {
            orderItem: {
              columns: { id: true, listingNameSnap: true, orderId: true },
            },
          },
        });
        target = ret ?? null;
      }

      let decidedByAdmin: { id: string; email: string } | null = null;
      if (dispute.decidedByAdminId) {
        const admin = await db.query.adminAccounts.findFirst({
          where: eq(adminAccounts.id, dispute.decidedByAdminId),
          columns: { id: true, email: true },
        });
        decidedByAdmin = admin ?? null;
      }

      return ok({ ...withTargetKind(dispute), target, decidedByAdmin });
    },
  );

  // ===== POST /admin/disputes/:id/request-evidence =====
  app.post(
    '/disputes/:id/request-evidence',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ note: z.string().trim().min(1).max(1000) }),
      },
    },
    async (req) => {
      const dispute = await db.query.disputes.findFirst({
        where: eq(disputes.id, req.params.id),
      });
      if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
      if (dispute.status !== 'open') {
        throw new AppError(
          409,
          ErrorCode.DisputeInvalidState,
          `Cannot request evidence from a dispute in '${dispute.status}' status`,
        );
      }

      const [updated] = await db
        .update(disputes)
        .set({ status: 'requested_evidence', decisionNote: req.body.note })
        .where(eq(disputes.id, dispute.id))
        .returning();

      return ok(withTargetKind(updated!));
    },
  );

  // ===== POST /admin/disputes/:id/decide =====
  app.post(
    '/disputes/:id/decide',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          decision: DisputeDecisionEnum,
          decisionNote: z.string().trim().min(1).max(2000),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const dispute = await db.query.disputes.findFirst({
        where: eq(disputes.id, req.params.id),
      });
      if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
      if (dispute.status === 'decided') {
        throw new AppError(409, ErrorCode.DisputeAlreadyDecided, 'Dispute has already been decided');
      }

      const [updated] = await db
        .update(disputes)
        .set({
          status: 'decided',
          decision: req.body.decision,
          decisionNote: req.body.decisionNote,
          decidedByAdminId: auth.sub,
          decidedAt: new Date(),
        })
        .where(eq(disputes.id, dispute.id))
        .returning();

      return ok(withTargetKind(updated!));
    },
  );

  // ===== POST /admin/disputes/:id/escalate =====
  app.post(
    '/disputes/:id/escalate',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.preprocess(
          (v) => (v == null ? {} : v),
          z.object({ note: z.string().trim().max(1000).optional() }),
        ),
      },
    },
    async (req) => {
      const dispute = await db.query.disputes.findFirst({
        where: eq(disputes.id, req.params.id),
      });
      if (!dispute) throw new AppError(404, ErrorCode.DisputeNotFound, 'Dispute not found');
      if (dispute.status === 'decided') {
        throw new AppError(409, ErrorCode.DisputeAlreadyDecided, 'Cannot escalate a decided dispute');
      }
      if (dispute.status === 'escalated') {
        throw new AppError(409, ErrorCode.DisputeInvalidState, 'Dispute is already escalated');
      }

      const [updated] = await db
        .update(disputes)
        .set({
          status: 'escalated',
          ...(req.body?.note ? { decisionNote: req.body.note } : {}),
        })
        .where(eq(disputes.id, dispute.id))
        .returning();

      return ok(withTargetKind(updated!));
    },
  );
};

function withTargetKind(d: typeof disputes.$inferSelect) {
  return {
    ...d,
    targetKind: d.orderId ? 'order' : 'return',
    targetId: d.orderId ?? d.returnId,
  };
}

export default adminDisputeRoutes;
