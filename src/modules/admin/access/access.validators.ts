import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';

export const IdParam = z.object({ id: z.string() });

export const SubRoleEnum = z.enum(['super_admin', 'ops_admin', 'support']);

export const CreateTeamBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  subRole: SubRoleEnum,
});

export const UpdateTeamBody = z
  .object({
    email: EmailSchema.optional(),
    subRole: SubRoleEnum.optional(),
  })
  .refine((v) => v.email !== undefined || v.subRole !== undefined, {
    message: 'Provide at least one of email, subRole',
  });

export const RevokeBody = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .default({});

export const SubRoleOverrideBody = z.object({
  scope: z.enum(['admin', 'retailer']),
  subRole: z.string().min(1),
  action: z.string().min(1),
  allowed: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export const ImpersonationStartBody = z.object({
  storeId: z.string(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const ImpersonationStopBody = z.object({ sessionId: z.string() });

export const AuditLogQuery = z.object({
  resourceKind: z.string().optional(),
  resourceId: z.string().optional(),
  actorId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});
