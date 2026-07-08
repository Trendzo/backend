/**
 * Multi-retailer cart split — one checkout, one order_group, one child order per
 * fulfilling store.
 *
 * Semantics:
 *   - ALL-OR-NOTHING. Children place sequentially; if any child fails (stock,
 *     price drift, promo expiry…), every already-placed child is compensated via
 *     cancelOrder (which releases reservations, fails pending COD payments, and
 *     refunds any wallet portion) and the original error is rethrown. No gateway
 *     exists, so there is no external charge to reverse — "payment" is the child
 *     payment rows, which the compensation flips/refunds.
 *   - ONE logical payment, N allocation rows: each child gets its own payments
 *     row (amount = child total − child wallet share) under a shared idempotency
 *     root. Every downstream money path (refunds, recon, settlement) already
 *     operates per child order and needs no change. When a real gateway lands,
 *     capture the cart total once and stamp the same capture ref across the
 *     child rows.
 *   - Wallet applies GREEDILY across children in placement order (child 1 draws
 *     up to its total, child 2 draws from the remainder, …) — emergent from each
 *     child's own CAS debit against the live balance.
 *   - Cart-level coupons/vouchers/points are NOT supported here (each child
 *     prices independently; a cart-wide minSpend rule can't see sibling totals).
 *     The validator rejects them — apply per-store codes via single-store
 *     checkout, or wait for cart-level promotions.
 *   - Replay: the group idempotency key derives child keys (`key#storeId`). A
 *     retry replays child-by-child — completed children short-circuit through
 *     placeOrder's own idempotency, missing children place fresh into the SAME
 *     group (crash-resume safe).
 *
 * Pickup carts must be single-store (a pickup slot belongs to one store).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderGroups, orders, payments, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  createRazorpayOrder,
  isRazorpayActive,
  razorpayKeyId,
} from '@/shared/payments/razorpay.js';
import { cancelOrder } from './cancel.js';
import {
  placeOrder,
  type GatewayCheckoutBlock,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from './place-order.js';

export type PlaceGroupOrderInput = {
  consumerId: string;
  /** The whole cart — may span stores; grouped by each variant's storeId here. */
  items: Array<{ variantId: string; qty: number }>;
  deliveryMethod: PlaceOrderInput['deliveryMethod'];
  paymentMethod: PlaceOrderInput['paymentMethod'];
  paymentOutcome: PlaceOrderInput['paymentOutcome'];
  addressId?: string | undefined;
  applyWallet?: boolean | undefined;
  idempotencyKey: string;
  placedByActorType: PlaceOrderInput['placedByActorType'];
  placedByActorId: string;
  pickupSlotId?: string | undefined;
  pickupSlotStart?: Date | undefined;
  pickupSlotEnd?: Date | undefined;
};

export type PlaceGroupOrderResult = {
  groupId: string;
  combinedTotalPaise: number;
  orders: Array<
    Pick<
      PlaceOrderResult,
      'orderId' | 'status' | 'pricing' | 'walletAppliedPaise' | 'amountChargedPaise' | 'alreadyExisted'
    > & { storeId: string }
  >;
  alreadyExisted: boolean;
  /** ONE Razorpay Checkout for the whole cart (children share the gateway order). */
  payment?: GatewayCheckoutBlock;
};

const childKey = (root: string, storeId: string) => `${root}#${storeId}`;

export async function placeGroupOrder(
  database: typeof Db,
  input: PlaceGroupOrderInput,
): Promise<PlaceGroupOrderResult> {
  if (input.items.length === 0) {
    throw AppError.validation('At least one item is required');
  }

  // ── Bucket the cart by fulfilling store (deterministic order for replay) ──
  const variantIds = [...new Set(input.items.map((i) => i.variantId))];
  const rows = await database.query.variants.findMany({
    where: inArray(variants.id, variantIds),
    columns: { id: true, storeId: true },
  });
  const storeByVariant = new Map(rows.map((r) => [r.id, r.storeId]));
  const buckets = new Map<string, Array<{ variantId: string; qty: number }>>();
  for (const it of input.items) {
    const storeId = storeByVariant.get(it.variantId);
    if (!storeId) {
      throw new AppError(404, ErrorCode.NotFound, `Unknown variant ${it.variantId}`);
    }
    const list = buckets.get(storeId) ?? [];
    list.push(it);
    buckets.set(storeId, list);
  }
  const storeIds = [...buckets.keys()].sort();

  if (input.deliveryMethod === 'pickup' && storeIds.length > 1) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Pickup carts must be single-store — a pickup slot belongs to one store',
    );
  }

  // ── Replay detection: the first bucket's child key marks a prior attempt.
  //    Reuse ITS group so a crash-resume fills the missing siblings in place. ──
  const firstChild = await database.query.orders.findFirst({
    where: eq(orders.idempotencyKey, childKey(input.idempotencyKey, storeIds[0]!)),
    columns: { groupId: true },
  });
  let groupId: string;
  let freshGroup = false;
  if (firstChild) {
    groupId = firstChild.groupId;
  } else {
    groupId = newId(IdPrefix.OrderGroup);
    freshGroup = true;
    await database.insert(orderGroups).values({
      id: groupId,
      consumerId: input.consumerId,
      status: 'in_flight',
      combinedTotalPaise: 0,
    });
  }

  // ── Place children sequentially; compensate everything on the first failure ──
  const placed: PlaceGroupOrderResult['orders'] = [];
  try {
    for (const storeId of storeIds) {
      const res = await placeOrder(database, {
        consumerId: input.consumerId,
        storeId,
        items: buckets.get(storeId)!,
        deliveryMethod: input.deliveryMethod,
        paymentMethod: input.paymentMethod,
        paymentOutcome: input.paymentOutcome,
        idempotencyKey: childKey(input.idempotencyKey, storeId),
        placedByActorType: input.placedByActorType,
        placedByActorId: input.placedByActorId,
        existingGroupId: groupId,
        skipGatewayOrder: true, // the group mints ONE gateway order below

        ...(input.addressId !== undefined && { addressId: input.addressId }),
        ...(input.applyWallet !== undefined && { applyWallet: input.applyWallet }),
        ...(input.pickupSlotId !== undefined && { pickupSlotId: input.pickupSlotId }),
        ...(input.pickupSlotStart !== undefined && { pickupSlotStart: input.pickupSlotStart }),
        ...(input.pickupSlotEnd !== undefined && { pickupSlotEnd: input.pickupSlotEnd }),
      });
      placed.push({
        orderId: res.orderId,
        storeId,
        status: res.status,
        pricing: res.pricing,
        walletAppliedPaise: res.walletAppliedPaise,
        amountChargedPaise: res.amountChargedPaise,
        alreadyExisted: res.alreadyExisted,
      });
    }
  } catch (err) {
    // ALL-OR-NOTHING: unwind the placed siblings. cancelOrder releases their
    // reservations, fails pending COD payments, and refunds wallet/tender —
    // the compensating transaction for a half-placed cart.
    for (const p of placed) {
      await cancelOrder(database, {
        orderId: p.orderId,
        actorType: 'system',
        actorId: 'system',
        reason: 'group_placement_failed',
        metadata: { groupId, failedAfter: placed.length, totalStores: storeIds.length },
      }).catch((e) => {
        console.error(
          `[group-order] compensation cancel ${p.orderId}: ${(e as Error).message}`,
        );
      });
    }
    // A fresh group that never got a child would be an orphan row — remove it.
    if (freshGroup && placed.length === 0) {
      await database.delete(orderGroups).where(eq(orderGroups.id, groupId)).catch(() => {});
    }
    throw err;
  }

  const group = await database.query.orderGroups.findFirst({
    where: eq(orderGroups.id, groupId),
    columns: { combinedTotalPaise: true },
  });

  // ── ONE Razorpay Checkout for the whole cart: mint a single gateway order for
  //    the sum of the children's still-pending gateway charges and stamp it on
  //    every child payment row. A replay whose children already share a gateway
  //    order reuses it (the client can reopen the same Checkout).
  let paymentBlock: GatewayCheckoutBlock | undefined;
  const gatewayEligible =
    isRazorpayActive() &&
    input.placedByActorType === 'consumer' &&
    (input.paymentMethod === 'upi' || input.paymentMethod === 'card');
  if (gatewayEligible) {
    const childIds = placed.map((p) => p.orderId);
    const pendingRows = childIds.length
      ? await database.query.payments.findMany({
          where: and(inArray(payments.orderId, childIds), eq(payments.status, 'pending')),
          columns: { id: true, amountPaise: true, gatewayOrderId: true },
        })
      : [];
    const chargePaise = pendingRows.reduce((s, r) => s + r.amountPaise, 0);
    if (chargePaise > 0) {
      const sharedExisting =
        pendingRows.every((r) => r.gatewayOrderId !== null) &&
        new Set(pendingRows.map((r) => r.gatewayOrderId)).size === 1
          ? pendingRows[0]!.gatewayOrderId!
          : null;
      let gatewayOrderId = sharedExisting;
      if (!gatewayOrderId) {
        const rzpOrder = await createRazorpayOrder({
          amountPaise: chargePaise,
          receipt: groupId,
          notes: { groupId },
        });
        gatewayOrderId = rzpOrder.id;
        await database
          .update(payments)
          .set({ gatewayOrderId })
          .where(inArray(payments.id, pendingRows.map((r) => r.id)));
      }
      paymentBlock = {
        gateway: 'razorpay',
        keyId: razorpayKeyId(),
        gatewayOrderId,
        amountPaise: chargePaise,
        currency: 'INR',
      };
    }
  }

  return {
    groupId,
    combinedTotalPaise: group?.combinedTotalPaise ?? placed.reduce((s, p) => s + p.pricing.totalPaise, 0),
    orders: placed,
    alreadyExisted: placed.length > 0 && placed.every((p) => p.alreadyExisted),
    ...(paymentBlock ? { payment: paymentBlock } : {}),
  };
}
