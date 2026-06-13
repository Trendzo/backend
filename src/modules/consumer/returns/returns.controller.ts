/**
 * Consumer returns. Scoped to the authenticated consumer — ownership is asserted by
 * joining return → order_item → order on consumerId. Creation reuses the shared
 * openReturn orchestrator (same path as admin-on-behalf returns), with
 * counterReturn=false: the consumer ships/hands the items back and the store
 * verifies on receipt. Refund status is surfaced per return via refund_lines.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { orderItems, orders, refundLines, refunds, returns } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { openReturn } from '@/shared/returns/open-return.js';
import type { CreateReturnBody } from './returns.validators.js';

type Auth = AccessTokenPayload;

/** Open a standard (post-delivery) return for one or more items of an owned order. */
export async function createReturn(input: {
  auth: Auth;
  body: z.infer<typeof CreateReturnBody>;
}) {
  const { auth, body } = input;
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, body.orderId),
    columns: { id: true, consumerId: true },
  });
  if (!order || order.consumerId !== auth.sub) {
    throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  }
  const result = await openReturn(db, {
    orderId: body.orderId,
    items: body.items.map((it) => ({
      orderItemId: it.orderItemId,
      ...(it.reasonText !== undefined && { reasonText: it.reasonText }),
      ...(it.reasonCategory !== undefined && { reasonCategory: it.reasonCategory }),
      ...(it.photos !== undefined && { consumerPhotos: it.photos }),
    })),
    counterReturn: false,
    actor: { type: 'consumer', id: auth.sub },
  });
  return ok(result);
}

/** This consumer's returns, newest first, each with its item snapshot + refund status. */
export async function listReturns(input: { auth: Auth }) {
  const rows = await db
    .select({
      id: returns.id,
      kind: returns.kind,
      openedAt: returns.openedAt,
      reasonText: returns.reasonText,
      reasonCategory: returns.reasonCategory,
      storeDecision: returns.storeDecision,
      storeDecidedAt: returns.storeDecidedAt,
      orderId: orders.id,
      orderItemId: orderItems.id,
      itemName: orderItems.listingNameSnap,
      itemBrand: orderItems.brandSnap,
      itemAttributes: orderItems.attributesLabelSnap,
      itemImage: orderItems.galleryImageSnap,
      itemOutcome: orderItems.outcome,
      netLinePaise: orderItems.netLinePaise,
    })
    .from(returns)
    .innerJoin(orderItems, eq(returns.orderItemId, orderItems.id))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(eq(orders.consumerId, input.auth.sub))
    .orderBy(desc(returns.openedAt));

  // Refund allocation per returned item (if the refund has been created yet).
  const itemIds = rows.map((r) => r.orderItemId);
  const refundRows = itemIds.length
    ? await db
        .select({
          orderItemId: refundLines.orderItemId,
          refundId: refunds.id,
          status: refunds.status,
          refundedAmountPaise: refundLines.refundedAmountPaise,
        })
        .from(refundLines)
        .innerJoin(refunds, eq(refundLines.refundId, refunds.id))
        .where(inArray(refundLines.orderItemId, itemIds))
    : [];
  const refundByItem = new Map(refundRows.map((r) => [r.orderItemId, r]));

  return ok(
    rows.map((r) => {
      const refund = refundByItem.get(r.orderItemId);
      return {
        ...r,
        refund: refund
          ? {
              id: refund.refundId,
              status: refund.status,
              amountPaise: refund.refundedAmountPaise,
            }
          : null,
      };
    }),
  );
}
