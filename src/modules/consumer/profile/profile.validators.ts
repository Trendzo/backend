import { z } from 'zod';
import { EmailSchema } from '@/shared/validation/common.js';

/**
 * Profile completion / edit. Phone is identity (verified via OTP) and cannot be changed
 * here. Name + email are required before placing an order (order snapshots are NOT NULL).
 */
export const UpdateMeBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: EmailSchema.optional(),
    genderPreference: z.enum(['her', 'him', 'unisex']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });
