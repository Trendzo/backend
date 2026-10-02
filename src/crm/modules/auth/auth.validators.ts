import { z } from 'zod';

/** 10-digit Indian mobile — the field team is domestic, matching the seeded sales users. */
export const CrmPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length === 10, 'Enter a valid 10-digit mobile number');

export const CrmRequestOtpBody = z.object({
  phone: CrmPhoneSchema,
});

export const CrmVerifyOtpBody = z.object({
  phone: CrmPhoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
