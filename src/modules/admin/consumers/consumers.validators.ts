import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const IdFlagParam = z.object({ id: z.string(), flagId: z.string() });

export const ConsumerStatusEnum = z.enum(['active', 'suspended', 'closed']);

export const ListQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: ConsumerStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SuspendBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const UnsuspendBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);

export const CloseBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const IssueGiftCardBody = z.object({
  balancePaise: z.number().int().positive(),
  /** Calendar date 'YYYY-MM-DD'. */
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiresOn must be YYYY-MM-DD'),
  /** Optional custom code; auto-generated when omitted. */
  code: z.string().trim().min(1).max(64).optional(),
});

export const FlagsQuery = z.object({
  includeResolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const FlagKindEnum = z.enum(['promo_abuse', 'dispute_pattern', 'rewards_ban', 'other']);

export const CreateFlagBody = z.object({
  kind: FlagKindEnum,
  reason: z.string().trim().min(3).max(500),
});

export const ResolveFlagBody = z
  .object({ note: z.string().trim().max(500).optional() })
  .optional();

export const BanSurfaceEnum = z.enum(['posts', 'reviews', 'rewards']);

export const CreateBanBody = z.object({
  surface: BanSurfaceEnum,
  reason: z.string().trim().min(3).max(500),
});

export const LiftBanBody = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const ListBansQuery = z.object({
  includeLifted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const IdBanParam = z.object({ id: z.string(), banId: z.string() });

export const CreateConsumerBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().regex(/^\+?\d{10,15}$/, 'Use international format e.g. +919812345678'),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(4).max(72).optional(),
  genderPreference: z.enum(['her', 'him', 'unisex']).optional(),
});

export const MintTestBody = z
  .object({
    legalName: z.string().trim().min(1).max(120).optional(),
    storeId: z.string().optional(),
  })
  .default({});
