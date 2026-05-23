import { z } from 'zod';
import { PromotionCommonSchema, PromotionPatchSchema } from '@/shared/promotions/schemas.js';

export const StoreParam = z.object({ storeId: z.string() });
export const StorePromoParam = z.object({ storeId: z.string(), id: z.string() });

export const ListPromotionsQuery = z.object({
  status: z
    .enum(['draft', 'scheduled', 'active', 'paused', 'expired', 'exhausted', 'revoked'])
    .optional(),
  mechanism: z.enum(['offer', 'coupon', 'voucher']).optional(),
});

export const CreatePromotionBody = PromotionCommonSchema;
export const PatchPromotionBody = PromotionPatchSchema;

export const BulkPauseBody = z.object({
  promotionIds: z.array(z.string()).min(1).max(100),
});

export const VoucherGenerateBody = z.object({
  count: z.number().int().min(1).max(10_000),
  prefix: z.string().trim().max(20).optional(),
});
