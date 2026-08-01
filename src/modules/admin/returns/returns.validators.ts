import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const RefundDisbParam = z.object({ id: z.string(), dId: z.string() });

export const OpenReturnBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        reasonText: z.string().trim().max(500).optional(),
        photos: z.array(z.string().url()).optional(),
      }),
    )
    .min(1),
});

export const ListReturnsQuery = z.object({
  decision: z.enum(['pending', 'accepted', 'rejected']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const VerifyBody = z.object({
  decision: z.enum(['accepted', 'rejected']),
  reasonNote: z.string().trim().max(500).optional(),
  rejectPhotos: z.array(z.string().url()).max(5).optional(),
});

export const ListRefundsQuery = z.object({
  status: z
    .enum(['pending', 'processing', 'succeeded', 'partially_disbursed', 'failed'])
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const ForceFailBody = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const ListHeldQuery = z.object({
  status: z.enum(['holding', 'expired', 'resolved']).optional(),
  storeId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const ExtendHoldBody = z.object({
  daysExtra: z.number().int().positive().max(60),
  reason: z.string().trim().min(3).max(500),
});

export const ForceDisposeBody = z.object({
  disposition: z.enum(['restocked', 'forfeited_to_store', 'written_off']),
  reason: z.string().trim().min(3).max(500),
});

/** Payout desk: refund legs that need a human to move real money. */
export const PayoutDeskQuery = z.object({
  destination: z.enum(['manual_payout', 'cash']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * `reference` is mandatory — the settled-proof CHECK refuses a succeeded non-wallet leg
 * with no gatewayRef, so an admin cannot close a payout without naming it.
 */
export const SettleManualBody = z.object({
  reference: z.string().trim().min(4).max(120),
  note: z.string().trim().max(500).optional(),
});

export const RedirectToWalletBody = z
  .object({ note: z.string().trim().max(500).optional() })
  .default({});
