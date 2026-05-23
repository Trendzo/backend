import { z } from 'zod';

export const RetailerStatusFilter = z.enum([
  'pending_approval',
  'approved_no_store',
  'onboarding',
  'active',
  'paused',
  'suspended',
  'terminated',
]);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  status: RetailerStatusFilter.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
  cursor: z.string().optional(),
});

export const RejectBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const SuspendBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const UnsuspendBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);

export const TerminateBody = z.object({ reason: z.string().trim().min(1).max(500) });
