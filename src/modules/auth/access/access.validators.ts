import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';

export const HardwareKeyChallengeBody = z.object({
  adminId: z.string(),
});

export const PasswordResetStartBody = z.object({
  kind: z.enum(['retailer', 'admin']),
  email: EmailSchema,
});

export const PasswordResetCompleteBody = z.object({
  kind: z.enum(['retailer', 'admin']),
  email: EmailSchema,
  code: z.string().length(6),
  newPassword: PasswordSchema,
});
