import { z } from 'zod';
import { KycDocKindEnum } from '@/shared/kyc/doc-kinds.js';

export const IdParam = z.object({ id: z.string() });

/** Shape of the JSON blob stored in `requestedValue` for `bank_account` change requests. */
export const BankAccountValueSchema = z.object({
  accountNumber: z.string().trim().min(6).max(34),
  ifsc: z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC format invalid'),
  legalName: z.string().trim().min(1).max(200),
});

/** `kind` is validated against the canonical 5 — a free string used to silently
 *  insert an orphan 6th document row instead of filling a seeded slot. */
export const KycUploadBody = z.object({
  kind: KycDocKindEnum,
  url: z.string().url(),
});

export const ChangeRequestBody = z.object({
  field: z.enum(['legal_name', 'address', 'bank_account', 'gstin', 'pos_billing_activation']),
  currentValue: z.string().trim().min(1),
  requestedValue: z.string().trim().min(1),
  reason: z.string().trim().min(3).max(500),
  evidenceUrl: z.string().url().optional(),
});

/** Body for the owner/manager account-closure and account-reopen requests. */
export const AccountLifecycleBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Body for a suspend/terminate appeal-thread message. */
export const AppealMessageBody = z.object({
  body: z.string().trim().min(1).max(2000),
  attachmentUrls: z.array(z.string().url()).optional(),
});
