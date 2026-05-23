import { z } from 'zod';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters/digits/hyphens');

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

export const CreateBody = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(120),
  tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().optional(),
  domain: z.string().url().optional(),
  isActive: z.boolean().default(true),
});

export const PatchBody = z
  .object({
    slug: SlugSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    logoUrl: z.string().url().nullable().optional(),
    domain: z.string().url().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
