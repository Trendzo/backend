/**
 * Retailer-side order management. Scoped to the authenticated retailer's storeId — every
 * fetch is filtered, every transition asserts the order belongs to their store.
 *
 * Standard delivery is the focus of this iteration; the state machine itself supports the
 * full Try-and-Buy + door-visit + returns set, those just don't have UI yet.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAttempts,
  heldItems,
  orderItems,
  orderTransitions,
  orders,
  payments,
  platformConfig,
  refundDisbursements,
  refunds,
  retailerAccounts,
  returns,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { logTransitionMarker, transitionOrder } from '@/shared/orders/transition.js';
import {
  type OrderStatus,
  transitionsFrom,
} from '@/shared/orders/state-machine.js';

const OrderStatusEnum = z.enum([
  'pending',
  'confirmed',
  'routing',
  'accepted',
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'undelivered',
  'returning_to_store',
  'returned_to_store',
  'delivered',
  'cancelled',
  'payment_failed',
  'closed',
]);

/** Resolve the authenticated retailer's storeId; rejects if not yet linked. */
async function getOwnStoreId(req: { auth?: { sub: string } }): Promise<string> {
  const sub = req.auth?.sub;
  if (!sub) throw AppError.unauthorized();
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, sub),
    columns: { id: true, storeId: true, status: true },
  });
  if (!retailer) throw AppError.unauthorized('Retailer account not found');
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.NotOwner, 'No store linked to this retailer account');
  }
  if (retailer.status !== 'active') {
    throw new AppError(
      403,
      ErrorCode.RetailerNotApproved,
      `Retailer account is ${retailer.status}`,
    );
  }
  return retailer.storeId;
}

/** Load order, asserting it belongs to the calling retailer's store. */
async function loadOwnedOrder(orderId: string, storeId: string) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, orderId), eq(orders.storeId, storeId)),
  });
  if (!order) {
    throw new AppError(404, ErrorCode.OrderNotFound, `Order ${orderId} not found for your store`);
  }
  return order;
}

const retailerOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ============ GET /retailer/orders — list (own store only) ============
  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          status: OrderStatusEnum.optional(),
          /** Comma-separated list of statuses, used to power the tabs view. */
          statusIn: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });

      const conds: SQL[] = [eq(orders.storeId, storeId)];
      if (req.query.status) conds.push(eq(orders.status, req.query.status));
      if (req.query.statusIn) {
        const statuses = req.query.statusIn
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean) as OrderStatus[];
        if (statuses.length > 0) conds.push(inArray(orders.status, statuses));
      }
      const where = conds.length === 1 ? conds[0] : and(...conds);

      const rows = await db.query.orders.findMany({
        ...(where && { where }),
        orderBy: desc(orders.placedAt),
        limit: req.query.limit,
        with: {
          items: { columns: { id: true } },
        },
      });
      return ok(
        rows.map((r) => ({
          id: r.id,
          status: r.status,
          consumerName: r.consumerNameSnap,
          consumerPhone: r.consumerPhoneSnap,
          deliveryMethod: r.deliveryMethod,
          paymentMethod: r.paymentMethod,
          itemCount: r.items.length,
          grandTotalPaise: r.grandTotalPaise,
          placedAt: r.placedAt,
          acceptedAt: r.acceptedAt,
          deliveredAt: r.deliveredAt,
        })),
      );
    },
  );

  // ============ GET /retailer/orders/:id — detail ============
  app.get(
    '/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      // Pull the order + everything for detail rendering. ownership-checked via storeId in query.
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.id, req.params.id), eq(orders.storeId, storeId)),
        with: {
          group: true,
          items: true,
          payments: { orderBy: asc(payments.initiatedAt) },
          transitions: { orderBy: asc(orderTransitions.at) },
          deliveryAttempts: { orderBy: asc(deliveryAttempts.attemptedAt) },
        },
      });
      if (!order) {
        throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found for your store');
      }
      const itemIds = order.items.map((i) => i.id);
      const returnsRows = itemIds.length === 0 ? [] : await db.query.returns.findMany({
        where: inArray(returns.orderItemId, itemIds),
        orderBy: asc(returns.openedAt),
      });
      const refundsRows = await db.query.refunds.findMany({
        where: eq(refunds.orderId, order.id),
        with: {
          lines: true,
          disbursements: { orderBy: asc(refundDisbursements.initiatedAt) },
        },
        orderBy: asc(refunds.createdAt),
      });
      const returnIds = returnsRows.map((r) => r.id);
      const heldRows = returnIds.length === 0 ? [] : await db.query.heldItems.findMany({
        where: inArray(heldItems.returnId, returnIds),
        orderBy: asc(heldItems.holdingWindowExpiresAt),
      });
      return ok({
        ...order,
        returns: returnsRows,
        refunds: refundsRows,
        heldItems: heldRows,
        availableTransitions: transitionsFrom(order.status as OrderStatus),
      });
    },
  );

  // ============ POST /retailer/orders/:id/accept ============
  app.post(
    '/:id/accept',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);
      const result = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'accepted',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'retailer_accepted',
      });
      return ok(result);
    },
  );

  // ============ POST /retailer/orders/:id/pack ============
  app.post(
    '/:id/pack',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);
      const result = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'packed',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'retailer_packed',
      });
      return ok(result);
    },
  );

  // ============ POST /retailer/orders/:id/handover — mark picked_up by agent ============
  app.post(
    '/:id/handover',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z
          .object({
            agentName: z.string().trim().min(1).max(120).optional(),
            agentPhone: z.string().trim().min(1).max(20).optional(),
          })
          .default({}),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);
      const result = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'picked_up',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'agent_handover',
        metadata: req.body,
      });
      return ok(result);
    },
  );

  // ============ POST /retailer/orders/:id/depart — agent left store ============
  app.post(
    '/:id/depart',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);
      const result = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'out_for_delivery',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'agent_departed',
      });
      return ok(result);
    },
  );

  // ============ POST /retailer/orders/:id/mark-delivered ============
  app.post(
    '/:id/mark-delivered',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z
          .object({
            note: z.string().trim().max(500).optional(),
            proofPhotoUrl: z.string().url().optional(),
          })
          .default({}),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);

      const result = await db.transaction(async (tx) => {
        // Decrement stock + release reservation atomically.
        const items = await tx
          .select({ variantId: orderItems.variantId, qty: orderItems.qty })
          .from(orderItems)
          .where(eq(orderItems.orderId, req.params.id));
        for (const it of items) {
          await tx
            .update(variants)
            .set({
              stock: sql`${variants.stock} - ${it.qty}`,
              reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)`,
            })
            .where(eq(variants.id, it.variantId));
        }

        // Insert a delivery_attempt row at the next attemptNumber.
        const existingAttempts = await tx
          .select({ attemptNumber: deliveryAttempts.attemptNumber })
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.orderId, req.params.id));
        const nextAttempt =
          existingAttempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;
        await tx.insert(deliveryAttempts).values({
          id: newId(IdPrefix.DeliveryAttempt),
          orderId: req.params.id,
          deliveryAgentId: null,
          attemptNumber: nextAttempt,
          outcome: 'delivered',
          notes: req.body.note ?? null,
          proofPhotos: req.body.proofPhotoUrl ? [req.body.proofPhotoUrl] : [],
        });
        return { nextAttempt };
      });

      const transition = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'delivered',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'delivery_confirmed',
        metadata: { attemptNumber: result.nextAttempt },
      });
      return ok(transition);
    },
  );

  // ============ POST /retailer/orders/:id/mark-undelivered ============
  app.post(
    '/:id/mark-undelivered',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          reason: z.string().trim().min(3).max(500),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      await loadOwnedOrder(req.params.id, storeId);

      // Read the platform_config retry budget.
      const cfg = await db.query.platformConfig.findFirst({
        where: eq(platformConfig.key, 'undelivered_retry_budget'),
      });
      const retryBudget =
        cfg && typeof cfg.value === 'number' ? (cfg.value as number) : 1;

      // Existing attempts for this order so far.
      const existingAttempts = await db
        .select({ attemptNumber: deliveryAttempts.attemptNumber })
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.orderId, req.params.id));
      const attemptsSoFar = existingAttempts.length;
      const nextAttempt =
        existingAttempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;

      // Insert this failed attempt row.
      await db.insert(deliveryAttempts).values({
        id: newId(IdPrefix.DeliveryAttempt),
        orderId: req.params.id,
        deliveryAgentId: null,
        attemptNumber: nextAttempt,
        outcome: 'undelivered',
        notes: req.body.reason,
        proofPhotos: [],
      });

      // First, mark the order undelivered.
      await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'undelivered',
        actorType: 'retailer',
        actorId: auth.sub,
        reason: req.body.reason,
        metadata: { attemptNumber: nextAttempt },
      });

      // Then either retry (back to out_for_delivery) or send back to store.
      const totalAttemptsAfterThis = attemptsSoFar + 1;
      // Total = 1 initial + retryBudget retries. So if totalAttemptsAfterThis > 1 + retryBudget,
      // budget exhausted. With default retryBudget=1, we allow 2 attempts total.
      if (totalAttemptsAfterThis < 1 + retryBudget) {
        const retry = await transitionOrder(db, {
          orderId: req.params.id,
          toStatus: 'out_for_delivery',
          actorType: 'system',
          actorId: 'system',
          reason: 'retry_within_budget',
          metadata: { retryNumber: totalAttemptsAfterThis + 1 },
        });
        return ok({ ...retry, retryWithinBudget: true });
      }
      const final = await transitionOrder(db, {
        orderId: req.params.id,
        toStatus: 'returning_to_store',
        actorType: 'system',
        actorId: 'system',
        reason: 'retry_budget_exhausted',
        metadata: { totalAttempts: totalAttemptsAfterThis },
      });
      return ok({ ...final, retryWithinBudget: false });
    },
  );

  // ============ POST /retailer/orders/:id/request-cancel ============
  // Marker only — does NOT change status. Admin must approve via /admin/orders/:id/cancel.
  app.post(
    '/:id/request-cancel',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          reason: z.string().trim().min(3).max(500),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getOwnStoreId({ auth });
      const order = await loadOwnedOrder(req.params.id, storeId);
      const marker = await logTransitionMarker(db, {
        orderId: order.id,
        // toStatus is the same as current — purely informational, no actual transition.
        toStatus: order.status as OrderStatus,
        actorType: 'retailer',
        actorId: auth.sub,
        reason: 'cancel_requested',
        metadata: { requestedReason: req.body.reason },
      });
      return ok({ orderId: order.id, requestedReason: req.body.reason, ...marker });
    },
  );
};

export default retailerOrderRoutes;
