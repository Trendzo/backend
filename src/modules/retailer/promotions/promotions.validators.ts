import { z } from 'zod';
import {
  PromotionCommonSchema,
  PromotionPatchSchema,
  PromotionStatusEnum,
} from '@/shared/promotions/schemas.js';

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  status: PromotionStatusEnum.optional(),
  mechanism: z.enum(['offer', 'coupon', 'voucher']).optional(),
  listingId: z.string().optional(),
  excludedListingId: z.string().optional(),
});

export const CreateBody = PromotionCommonSchema;
export const PatchBody = PromotionPatchSchema;

export const ScopeListingBody = z.object({
  listingId: z.string(),
  action: z.enum(['include', 'uninclude', 'exclude', 'unexclude']),
});

export const PauseBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .nullish()
  .transform((v) => v ?? {});

export const RevokeBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .nullish()
  .transform((v) => v ?? {});

export const GenerateVouchersBody = z
  .object({
    promotionId: z.string(),
    prefix: z.string().trim().max(8).optional(),
    count: z.coerce.number().int().min(1).max(10_000).optional(),
    consumerIds: z.array(z.string().min(1)).min(1).max(10_000).optional(),
  })
  .refine(
    (v) => (v.count !== undefined) !== (v.consumerIds !== undefined),
    { message: 'Provide exactly one of `count` or `consumerIds`' },
  );

export const ExportVouchersQuery = z.object({ promotionId: z.string() });
