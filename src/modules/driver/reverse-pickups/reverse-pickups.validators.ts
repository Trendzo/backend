import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

/** Collection proof: consumer-spoken OTP + at least one photo of the goods. */
export const CollectBody = z.object({
  otp: z.string().trim().min(4).max(8).optional(),
  photos: z.array(z.string().url()).min(1).max(6),
  note: z.string().trim().max(300).optional(),
});
