import { z } from 'zod';

export const CartLineInput = z.object({
  lineId: z.string().min(1),
  listingId: z.string().min(1),
  variantId: z.string().min(1),
  brandId: z.string().optional(),
  categoryId: z.string().optional(),
  unitPricePaise: z.number().int().positive(),
  qty: z.number().int().positive(),
  gstRatePct: z.number().min(0).max(28).default(5),
});

export const CartInput = z.object({
  consumerId: z.string().default('sim-consumer'),
  consumerStateCode: z.string().regex(/^\d{2}$/).default('27'),
  storeStateCode: z.string().regex(/^\d{2}$/).default('27'),
  deliveryMethod: z.enum(['express', 'standard', 'pickup', 'try_and_buy']).default('standard'),
  paymentMethod: z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']).default('upi'),
  lines: z.array(CartLineInput).min(1),
});

export const SimulateSchema = z.object({
  cart: CartInput,
  /** Promotion IDs to apply (typically auto-applied 'offer' mechanism). */
  promotionIds: z.array(z.string()).default([]),
  /** Coupon code typed in by the consumer. */
  couponCode: z.string().trim().optional(),
  /** Voucher code typed in by the consumer (single-use). */
  voucherCode: z.string().trim().optional(),
  /** Loyalty points the consumer wants to spend. */
  pointsToRedeem: z.number().int().nonnegative().default(0),
  /** Override the consumer's loyalty balance (default = compute from DB ledger). */
  consumerLoyaltyBalance: z.number().int().nonnegative().optional(),
  /** Optional retailer-set fees (used in checkout flow when known per-store). */
  deliveryOverridePaise: z.number().int().nonnegative().optional(),
  handlingFeePaise: z.number().int().nonnegative().optional(),
  convenienceFeePaise: z.number().int().nonnegative().optional(),
});
