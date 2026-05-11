/**
 * Admin order management. Test-order placement, list, detail, and cancellation.
 *
 * Test-order placement bypasses any real payment gateway — the admin chooses the payment
 * outcome on the form so the team can exercise the failure-retry chain without integrating
 * Razorpay yet.
 */
import { and, asc, desc, eq, lt, ne, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  deliveryAttempts,
  heldItems,
  orderGroups,
  orderItems,
  orderTransitions,
  orders,
  payments,
  productListings,
  refundDisbursements,
  refunds,
  retailerStores,
  returns,
  variants,
} from '@/db/schema/index.js';
import { inArray } from 'drizzle-orm';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { newId, IdPrefix } from '@/shared/ids.js';
import { cancelOrder } from '@/shared/orders/cancel.js';
import { closeDoor, extendDoor, openDoor } from '@/shared/orders/door-visit.js';
import { placeOrder } from '@/shared/orders/place-order.js';
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

const adminOrderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ============ POST /admin/test-orders — place a test order ============
  app.post(
    '/test-orders',
    {
      schema: {
        body: z.object({
          storeId: z.string().min(1),
          consumerId: z.string().min(1),
          addressId: z.string().min(1).optional(),
          items: z
            .array(z.object({ variantId: z.string().min(1), qty: z.number().int().positive() }))
            .min(1),
          deliveryMethod: z.enum(['express', 'standard', 'pickup', 'try_and_buy']),
          paymentMethod: z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']),
          paymentOutcome: z.enum(['succeeded', 'failed', 'pending']).default('succeeded'),
          couponCode: z.string().trim().optional(),
          voucherCode: z.string().trim().optional(),
          pointsToRedeem: z.number().int().nonnegative().optional(),
          /** Optional client-supplied idempotency key; auto-generated if absent. */
          idempotencyKey: z.string().min(1).optional(),
        }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const idempotencyKey = req.body.idempotencyKey ?? newId(IdPrefix.Order).replace(/^ord_/, 'ik_');
      const result = await placeOrder(db, {
        consumerId: req.body.consumerId,
        storeId: req.body.storeId,
        items: req.body.items,
        deliveryMethod: req.body.deliveryMethod,
        paymentMethod: req.body.paymentMethod,
        paymentOutcome: req.body.paymentOutcome,
        ...(req.body.addressId !== undefined && { addressId: req.body.addressId }),
        ...(req.body.couponCode !== undefined && { couponCode: req.body.couponCode }),
        ...(req.body.voucherCode !== undefined && { voucherCode: req.body.voucherCode }),
        ...(req.body.pointsToRedeem !== undefined && { pointsToRedeem: req.body.pointsToRedeem }),
        idempotencyKey,
        placedByActorType: 'admin',
        placedByActorId: adminId,
      });
      return ok(result);
    },
  );

  // ============ GET /admin/orders — list ============
  app.get(
    '/orders',
    {
      schema: {
        querystring: z.object({
          status: OrderStatusEnum.optional(),
          storeId: z.string().optional(),
          consumerId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const conds: SQL[] = [];
      if (req.query.status) conds.push(eq(orders.status, req.query.status));
      if (req.query.storeId) conds.push(eq(orders.storeId, req.query.storeId));
      if (req.query.consumerId) conds.push(eq(orders.consumerId, req.query.consumerId));
      const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

      const rows = await db.query.orders.findMany({
        ...(where && { where }),
        orderBy: desc(orders.placedAt),
        limit: req.query.limit,
        with: {
          store: { columns: { id: true, legalName: true } },
          items: { columns: { id: true } },
        },
      });
      return ok(
        rows.map((r) => ({
          id: r.id,
          groupId: r.groupId,
          status: r.status,
          storeId: r.storeId,
          storeName: r.storeNameSnap,
          consumerId: r.consumerId,
          consumerName: r.consumerNameSnap,
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

  // ============ GET /admin/orders/:id — detail ============
  app.get(
    '/orders/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, req.params.id),
        with: {
          group: true,
          items: true,
          payments: { orderBy: asc(payments.initiatedAt) },
          transitions: { orderBy: asc(orderTransitions.at) },
          deliveryAttempts: { orderBy: asc(deliveryAttempts.attemptedAt) },
        },
      });
      if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
      // Pull related returns, refunds, held-items so the detail page can render them in-line.
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

      const siblingRows = await db.query.orders.findMany({
        where: and(eq(orders.groupId, order.groupId), ne(orders.id, order.id)),
        with: { items: { columns: { id: true } } },
        orderBy: asc(orders.placedAt),
      });
      const siblingOrders = siblingRows.map((r) => ({
        id: r.id,
        groupId: r.groupId,
        status: r.status,
        storeId: r.storeId,
        storeName: r.storeNameSnap,
        consumerId: r.consumerId,
        consumerName: r.consumerNameSnap,
        consumerPhone: r.consumerPhoneSnap,
        deliveryMethod: r.deliveryMethod,
        paymentMethod: r.paymentMethod,
        itemCount: r.items.length,
        grandTotalPaise: r.grandTotalPaise,
        placedAt: r.placedAt,
        acceptedAt: r.acceptedAt,
        deliveredAt: r.deliveredAt,
      }));

      return ok({
        ...order,
        group: { ...order.group, siblingOrders },
        returns: returnsRows,
        refunds: refundsRows,
        heldItems: heldRows,
        availableTransitions: transitionsFrom(order.status as OrderStatus),
      });
    },
  );

  // ============ POST /admin/orders/:id/cancel ============
  app.post(
    '/orders/:id/cancel',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const result = await cancelOrder(db, {
        orderId: req.params.id,
        actorType: 'admin',
        actorId: adminId,
        reason: req.body.reason,
      });
      return ok(result);
    },
  );

  // ============ Try-and-Buy door visit (admin acts on behalf of agent) ============
  app.post(
    '/orders/:id/door/open',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await openDoor(db, req.params.id, { type: 'admin', id: adminId });
      return ok(r);
    },
  );

  app.post(
    '/orders/:id/door/extend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(3).max(300) }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await extendDoor(db, req.params.id, { type: 'admin', id: adminId }, req.body.reason);
      return ok(r);
    },
  );

  app.post(
    '/orders/:id/door/close',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          items: z
            .array(
              z.object({
                orderItemId: z.string().min(1),
                decision: z.enum(['kept', 'returned', 'refused']),
                reason: z.string().trim().max(500).optional(),
                photos: z.array(z.string().url()).optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req) => {
      const adminId = req.auth?.sub ?? 'admin';
      const r = await closeDoor(db, req.params.id, { type: 'admin', id: adminId }, req.body.items);
      return ok(r);
    },
  );

  // ============ GET /admin/stores/:storeId/catalog — listings + variants for placement ============
  app.get(
    '/stores/:storeId/catalog',
    { schema: { params: z.object({ storeId: z.string() }) } },
    async (req) => {
      const rows = await db.query.productListings.findMany({
        where: and(
          eq(productListings.storeId, req.params.storeId),
          eq(productListings.status, 'active'),
        ),
        orderBy: asc(productListings.name),
        with: { variants: true },
      });
      return ok(rows);
    },
  );

  // ===== GET /admin/orders/:id/price-snapshot — snapshot vs live variant prices =====
  app.get(
    '/orders/:id/price-snapshot',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const items = await db.query.orderItems.findMany({
        where: eq(orderItems.orderId, req.params.id),
        with: { variant: true },
      });
      return ok(
        items.map((it) => ({
          variantId: it.variantId,
          listingNameSnap: it.listingNameSnap,
          snapshotPaise: it.unitPricePaise,
          currentPaise: it.variant?.pricePaise ?? it.unitPricePaise,
        })),
      );
    },
  );

  // Suppress unused-symbol (referenced from query above)
  void orderGroups;
  void orderItems;
  void retailerStores;
  void variants;

  // ===== GET /admin/orders/acceptance-timeout — pending orders older than 30 min =====
  app.get('/orders/acceptance-timeout', async () => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const rows = await db.query.orders.findMany({
      where: and(eq(orders.status, 'pending'), lt(orders.placedAt, cutoff)),
      orderBy: asc(orders.placedAt),
      limit: 100,
    });
    return ok(
      rows.map((o) => ({
        orderId: o.id,
        storeName: o.storeNameSnap,
        consumerName: o.consumerEmailSnap,
        attempts: 1,
        lastTimeoutAt: o.placedAt!.toISOString(),
        candidateStoreCount: 0,
      })),
    );
  });
};

export default adminOrderRoutes;
