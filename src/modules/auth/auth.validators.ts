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

/**
 * MSG91 OTP-widget access token, produced client-side after a successful OTP verify.
 * The backend re-verifies it against MSG91 before trusting the phone number.
 */
export const Msg91VerifyBody = z.object({
  accessToken: z.string().min(20).max(2048),
});

export const ReviewLoginBody = z.object({
  phone: IntlPhoneSchema,
  otp: z.string().regex(/^\d{4,8}$/, 'OTP must contain 4 to 8 digits'),
});
