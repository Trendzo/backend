import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';

export const RetailerIdParam = z.object({ id: z.string() });
export const StaffParam = z.object({ retailerId: z.string(), accountId: z.string() });

export const CreateStaffBody = z.object({
  legalName: z.string().min(1),
  email: EmailSchema,
  phone: z.string().trim().min(6).max(20),
  password: PasswordSchema,
  subRole: z.enum(['manager', 'staff']),
});

export const ChangeRoleBody = z.object({ subRole: z.enum(['owner', 'manager', 'staff']) });

export const OptionalReasonBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);

export const ResetPasswordBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ newPassword: PasswordSchema.optional() }),
);
