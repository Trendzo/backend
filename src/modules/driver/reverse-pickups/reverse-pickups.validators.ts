import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

/** Collection proof: consumer-spoken OTP + at least one photo of the goods. */
export const CollectBody = z.object({
  otp: z.string().trim().min(4).max(8).optional(),
  photos: z.array(z.string().url()).min(1).max(6),
  note: z.string().trim().max(300).optional(),
  /**
   * Attestation that the driver handed the task's `cashRefundDuePaise` to the customer.
   * Must equal that amount exactly — the server computed it, the driver only confirms
   * it. A driver-chosen figure would be a skimming surface.
   */
  cashHandedPaise: z.number().int().nonnegative().optional(),
});
