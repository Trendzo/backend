import { z } from 'zod';
import { EmailSchema } from '@/shared/validation/common.js';

export const IdParam = z.object({ id: z.string() });

export const SubRoleEnum = z.enum(['owner', 'manager', 'staff']);

export const PatchStaffBody = z.object({ subRole: SubRoleEnum });

export const CreateStaffBody = z.object({
  legalName: z.string().min(1),
  email: EmailSchema,
  password: z.string().min(6),
  subRole: SubRoleEnum,
});

export const InviteStaffBody = z.object({
  email: EmailSchema,
  subRole: SubRoleEnum,
});
