import { z } from 'zod';

const Items = z
  .array(z.object({ variantId: z.string().min(1), qty: z.number().int().positive() }))
  .min(1);

/** Price a single store-order (checkout). Mirrors the place-order inputs. */
export const PriceQuoteBody = z.object({
  storeId: z.string().min(1),
  items: Items,
  deliveryMethod: z.enum(['express', 'standard', 'pickup', 'try_and_buy']),
  paymentMethod: z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']),
  addressId: z.string().min(1).optional(),
  couponCode: z.string().trim().optional(),
  voucherCode: z.string().trim().optional(),
  pointsToRedeem: z.number().int().nonnegative().optional(),
  applyWallet: z.boolean().optional(),
});

/** Price the whole cart (cart screen). Backend groups by store + aggregates. */
export const PriceCartBody = z.object({
  items: Items,
  couponCode: z.string().trim().optional(),
  voucherCode: z.string().trim().optional(),
});
