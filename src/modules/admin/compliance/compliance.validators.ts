import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const StoreIdParam = z.object({ storeId: z.string() });

/** Shape of the JSON blob stored in `requestedValue` for `bank_account` change requests. */
export const BankAccountValueSchema = z.object({
  accountNumber: z.string().trim().min(6).max(34),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC format invalid'),
  legalName: z.string().trim().min(1).max(200),
});

export const KycDecideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});

export const ChangeRequestStatusQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const ChangeRequestDecideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

export const PolicyEnforcementQuery = z.object({ storeId: z.string().optional() });

export const PolicyEnforcementBody = z.object({
  storeId: z.string(),
  step: z.enum([
    'warning_1',
    'warning_2',
    'warning_3',
    'suspension',
    'termination',
    'lifted',
  ]),
  breachKind: z.enum([
    'acceptance_rate',
    'fulfilment_sla',
    'dispute_rate',
    'return_rate',
    'kyc_overdue',
    'policy_violation',
  ]),
  metric: z.record(z.unknown()).optional(),
  reason: z.string().trim().max(500).optional(),
  liftsActionId: z.string().optional(),
});

export const ReverifyBody = z.object({
  reason: z.string().trim().min(3).max(500),
  dueDays: z.coerce.number().int().min(7).max(90).optional(),
  graceDays: z.coerce.number().int().min(7).max(120).optional(),
});

export const DataExportProcessBody = z.object({
  status: z.enum(['building', 'ready', 'failed']),
  downloadUrl: z.string().url().optional(),
  failureReason: z.string().trim().max(500).optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const DeletionCancelBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .optional();
