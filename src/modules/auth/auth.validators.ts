import { z } from 'zod';
import {
  EmailSchema,
  GstinSchema,
  IntlPhoneSchema,
  PasswordSchema,
} from '@/shared/validation/common.js';

export const LoginBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

export const SignupBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  legalName: z.string().trim().min(2).max(120),
  phone: IntlPhoneSchema,
  gstin: GstinSchema,
});

