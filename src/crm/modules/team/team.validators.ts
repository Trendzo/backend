import { z } from 'zod';
import { CrmPhoneSchema } from '../auth/auth.validators.js';

const TargetNumber = z.coerce.number().int().min(0).max(999);
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const TeamIdParam = z.object({ id: z.string().min(3).max(80) });

export const CreateTeamMemberBody = z.object({
  name: z.string().trim().min(2, 'Name is required').max(120),
  mobile: CrmPhoneSchema,
  role: z.enum(['exec', 'manager']).default('exec'),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
  employee_id: Optional(40),
  territory_id: Optional(80),
  manager_id: Optional(80),
  visit_target: TargetNumber.optional(),
  demo_target: TargetNumber.optional(),
  agreement_target: TargetNumber.optional(),
  onboarding_target: TargetNumber.optional(),
});

/**
 * Team edits arrive as a discriminated union rather than a free-form patch: the side-effecting
 * operations (targets, revocation) are genuinely different verbs from a profile edit, and
 * modelling them as such keeps each one's validation honest.
 */
export const UpdateTeamMemberBody = z.union([
  z.object({ action: z.literal('reset_access') }),
  z.object({
    action: z.literal('set_targets'),
    visits: TargetNumber,
    demos: TargetNumber,
    agreements: TargetNumber,
    onboardings: TargetNumber,
  }),
  z.object({ action: z.literal('clear_targets') }),
  z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      mobile: CrmPhoneSchema.optional(),
      email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
      employee_id: Optional(40),
      territory_id: Optional(80),
      manager_id: Optional(80),
      role: z.enum(['exec', 'manager']).optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
]);

export const SetTargetsBody = z.object({
  user_id: z.string().trim().min(3).max(80).nullable().optional(),
  visits: TargetNumber,
  demos: TargetNumber,
  agreements: TargetNumber,
  onboardings: TargetNumber,
});

export const CreateCategoryBody = z.object({ name: z.string().trim().min(1).max(80) });
export const CreateTerritoryBody = z.object({
  city: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
});
export const IdQuery = z.object({ id: z.string().min(3).max(80) });

export const ReportQuery = z.object({
  type: z.enum(['performance', 'daily', 'conversion', 'followups']).default('performance'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  exec: z.string().trim().max(80).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
