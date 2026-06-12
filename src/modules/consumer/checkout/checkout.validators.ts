import { z } from 'zod';

// Reuse the canonical method/outcome enums so consumer checkout stays in lockstep
// with the order core (see modules/admin/orders/orders.validators.ts).
export const DeliveryMethodEnum = z.enum(['express', 'standard', 'pickup', 'try_and_buy']);
export const PaymentMethodEnum = z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']);
export const PaymentOutcomeEnum = z.enum(['succeeded', 'failed', 'pending']);

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
 * production.
 */
export const PlaceOrderBody = QuoteBody.extend({
  paymentOutcome: PaymentOutcomeEnum.default('succeeded'),
  idempotencyKey: z.string().min(1).optional(),
  // §9 pickup slot snap — required for real consumer pickup orders.
  pickupSlotId: z.string().min(1).optional(),
  pickupSlotStart: z.coerce.date().optional(),
  pickupSlotEnd: z.coerce.date().optional(),
});
