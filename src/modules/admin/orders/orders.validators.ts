import { z } from 'zod';

export const OrderStatusEnum = z.enum([
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

export const DeliveryMethodEnum = z.enum(['express', 'standard', 'pickup', 'try_and_buy']);
export const PaymentMethodEnum = z.enum(['upi', 'card', 'cod', 'wallet', 'gift_card']);
export const PaymentOutcomeEnum = z.enum(['succeeded', 'failed', 'pending']);

export const IdParam = z.object({ id: z.string() });
export const StoreIdParam = z.object({ storeId: z.string() });

export const PlaceTestOrderBody = z.object({
  storeId: z.string().min(1),
  consumerId: z.string().min(1),
  addressId: z.string().min(1).optional(),
  items: z
    .array(z.object({ variantId: z.string().min(1), qty: z.number().int().positive() }))
    .min(1),
  deliveryMethod: DeliveryMethodEnum,
  paymentMethod: PaymentMethodEnum,
  paymentOutcome: PaymentOutcomeEnum.default('succeeded'),
  couponCode: z.string().trim().optional(),
  voucherCode: z.string().trim().optional(),
  pointsToRedeem: z.number().int().nonnegative().optional(),
  applyWallet: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export const ListOrdersQuery = z.object({
  status: OrderStatusEnum.optional(),
  storeId: z.string().optional(),
  consumerId: z.string().optional(),
  paymentMethod: PaymentMethodEnum.optional(),
  deliveryMethod: DeliveryMethodEnum.optional(),
  ageHours: z.coerce.number().int().positive().max(720).optional(),
  paymentState: z.enum(['paid', 'unpaid', 'failed']).optional(),
  disputeFlag: z.enum(['open', 'none']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export const DismissCancelBody = z
  .object({ note: z.string().trim().max(500).optional() })
  .optional();

export const CancelBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const FeeOverrideBody = z.object({
  overridePaise: z.number().int().min(0),
  reason: z.string().trim().min(3).max(500),
});

export const DoorExtendBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const DoorCloseBody = z.object({
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
});

export const RerouteBody = z
  .object({
    reason: z.enum(['timeout', 'rejected']).default('rejected'),
  })
  .default({ reason: 'rejected' });
