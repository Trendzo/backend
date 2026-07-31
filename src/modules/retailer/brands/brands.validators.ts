import { z } from 'zod';

export const CreateBody = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase, hyphen-separated'),
  name: z.string().trim().min(1).max(120),
  tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().max(2000).optional(),
  domain: z.string().url().optional(),
});

export const IdParam = z.object({ id: z.string().min(1) });

export const PatchLogoBody = z
  .object({
    logoUrl: z.string().url().max(2000).nullable(),
  })
  .strict();
