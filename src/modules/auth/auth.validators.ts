import { z } from 'zod';
import {
  EmailSchema,
  GstinSchema,
  PasswordSchema,
  PhoneSchema,
} from '@/shared/validation/common.js';

export const LoginBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

export const SignupBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  legalName: z.string().trim().min(2).max(120),
  phone: PhoneSchema,
  gstin: GstinSchema,
});
