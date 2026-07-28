import { z } from 'zod';

// Mirrors the order core's enums (see modules/admin/orders/orders.validators.ts),
// minus what a consumer must not be able to ask for.
export const DeliveryMethodEnum = z.enum(['express', 'standard', 'pickup', 'try_and_buy']);

/**
 * `gift_card` is deliberately ABSENT.
 *
 * It was accepted here but nothing implements it: place-order's only mention is a
 * display label, there is no balance lookup and no debit. Combined with the old
 * `paymentOutcome` default of 'succeeded', any authenticated caller could post
 * `paymentMethod: 'gift_card'` and have an order confirm, route and ship having
 * collected nothing — no gift card required, not even a claim of payment.
 *
 * Gift cards do exist, but as a top-up: `/consumer/gift-cards/redeem` credits the
 * wallet, and the order is then paid with `wallet`. Re-add this only when checkout
 * genuinely debits a card balance.
 */
export const PaymentMethodEnum = z.enum(['upi', 'card', 'cod', 'wallet']);

export const OrderIdParam = z.object({ id: z.string() });

/** Cart arrives in the request body — the cart lives client-side, not in our DB. */
const ItemsSchema = z
  .array(z.object({ variantId: z.string().min(1), qty: z.number().int().positive() }))
  .min(1);

/** Dry-run pricing + stock + discount/coupon/voucher resolution. No side effects. */
export const QuoteBody = z.object({
  storeId: z.string().min(1),
  items: ItemsSchema,
  deliveryMethod: DeliveryMethodEnum,
  paymentMethod: PaymentMethodEnum,
  addressId: z.string().min(1).optional(),
  couponCode: z.string().trim().optional(),
  voucherCode: z.string().trim().optional(),
  pointsToRedeem: z.number().int().nonnegative().optional(),
  // Apply wallet balance as a partial tender; the remainder goes on paymentMethod.
  // (paymentMethod:'wallet' is wallet-only and applies regardless.)
  applyWallet: z.boolean().optional(),
});

/**
 * Place order. Same shape as a quote, plus the payment outcome and an optional
 * idempotency key.
 *
 * NOTE: paymentOutcome is accepted from the client as a pre-gateway stopgap — there
 * is no payment gateway yet. This is INSECURE for real money (a consumer could
 * self-declare 'succeeded'); replace with a gateway-driven outcome/webhook before
 * production. COD ignores this field entirely: the payment row is always born
 * 'pending' and settles when cash is collected at door/counter, while the order
 * still confirms and routes.
 */
/** Consumer-initiated cancellation. Reason is optional free text for the audit log. */
export const CancelOrderBody = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
});

/** Razorpay Checkout success triplet — HMAC-verified server-side. */
export const VerifyPaymentBody = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

/** Checkout dismissed/failed on the device. */
export const PaymentFailedBody = z.object({
  razorpayOrderId: z.string().min(1),
  reason: z.string().trim().max(300).optional(),
});

export const PlaceOrderBody = QuoteBody.extend({
  idempotencyKey: z.string().min(1).optional(),
  // §9 pickup slot snap — required for real consumer pickup orders.
  pickupSlotId: z.string().min(1).optional(),
  pickupSlotStart: z.coerce.date().optional(),
  pickupSlotEnd: z.coerce.date().optional(),
});

/**
 * Multi-retailer cart checkout: the WHOLE cart (no storeId — the server buckets
 * lines by each variant's store), one group, one child order per store,
 * all-or-nothing. Cart-level coupons/vouchers/points are deliberately absent —
 * children price independently; wallet applies greedily across children.
 */
export const PlaceGroupOrderBody = z.object({
  items: ItemsSchema,
  deliveryMethod: DeliveryMethodEnum,
  paymentMethod: PaymentMethodEnum,
  addressId: z.string().min(1).optional(),
  applyWallet: z.boolean().optional(),
  // Cart-level codes/points — resolved once against the whole cart, split across stores.
  couponCode: z.string().trim().optional(),
  voucherCode: z.string().trim().optional(),
  pointsToRedeem: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(1).optional(),
  pickupSlotId: z.string().min(1).optional(),
  pickupSlotStart: z.coerce.date().optional(),
  pickupSlotEnd: z.coerce.date().optional(),
});
