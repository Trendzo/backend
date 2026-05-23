import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

/** Shape of the JSON blob stored in `requestedValue` for `bank_account` change requests. */
export const BankAccountValueSchema = z.object({
  accountNumber: z.string().trim().min(6).max(34),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC format invalid'),
  legalName: z.string().trim().min(1).max(200),
});

export const KycUploadBody = z.object({
  kind: z.string().trim().min(1).max(64),
  url: z.string().url(),
});

export const ChangeRequestBody = z.object({
  field: z.enum(['legal_name', 'address', 'bank_account', 'gstin']),
  currentValue: z.string().trim().min(1),
  requestedValue: z.string().trim().min(1),
  reason: z.string().trim().min(3).max(500),
  evidenceUrl: z.string().url().optional(),
});
