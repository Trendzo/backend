import { z } from 'zod';

export const StoreStatusFilter = z.enum([
  'onboarding',
  'active',
  'paused',
  'suspended',
  'terminated',
]);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  status: StoreStatusFilter.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  stateCode: z.string().trim().min(2).max(3).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
  cursor: z.string().optional(),
});

export const ApproveBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({
    platformFeeBp: z.number().int().min(0).max(10_000).optional(),
    payoutCadenceDays: z.number().int().min(1).max(30).optional(),
  }),
);

export const RejectBody = z.object({ reason: z.string().trim().min(1).max(500) });
