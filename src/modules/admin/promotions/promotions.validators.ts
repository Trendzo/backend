import { z } from 'zod';
import {
  PromotionCommonSchema,
  PromotionPatchSchema,
  PromotionStatusEnum,
} from '@/shared/promotions/schemas.js';

export const DiscountTypeEnum = z.enum([
  'flat_amount',
  'percent',
  'percent_upto',
  'bogo',
  'bxgy',
  'bundle',
  'tiered_cart',
  'free_shipping',
]);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  status: PromotionStatusEnum.optional(),
  mechanism: z.enum(['offer', 'coupon', 'voucher']).optional(),
  discountType: DiscountTypeEnum.optional(),
  storeId: z.string().optional(),
  retailerId: z.string().optional(),
  platformOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const CreateBody = PromotionCommonSchema.extend({
  storeId: z.string().optional(),
});

export const PatchBody = PromotionPatchSchema;

export const PauseBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .nullish()
  .transform((v) => v ?? {});

export const RevokeBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .nullish()
  .transform((v) => v ?? {});

export const TargetedDropBody = z.object({
  promotionId: z.string(),
  cohort: z.enum([
    'all',
    'loyalty_bronze',
    'loyalty_silver',
    'loyalty_gold',
    'loyalty_platinum',
    'specific_consumers',
  ]),
  consumerIds: z.array(z.string()).optional(),
});

export const GenerateVouchersBody = z
  .object({
    prefix: z.string().trim().max(8).optional(),
    count: z.coerce.number().int().min(1).max(10_000).optional(),
    consumerIds: z.array(z.string().min(1)).min(1).max(10_000).optional(),
  })
  .refine(
    (v) => (v.count !== undefined) !== (v.consumerIds !== undefined),
    { message: 'Provide exactly one of `count` or `consumerIds`' },
  );
