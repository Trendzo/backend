import { z } from 'zod';

export const CreateBody = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase, hyphen-separated'),
  name: z.string().trim().min(1).max(120),
  tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().optional(),
  domain: z.string().url().optional(),
});
