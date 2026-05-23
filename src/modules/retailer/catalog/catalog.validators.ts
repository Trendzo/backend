import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const AxisSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['enum', 'free_text', 'numeric', 'color']),
  allowedValues: z.array(z.string()).default([]),
});

export const CreateTemplateBody = z.object({
  name: z.string().trim().min(1).max(120),
  axes: z.array(AxisSchema).min(1),
});

export const PatchTemplateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  axes: z.array(AxisSchema).min(1).optional(),
  // US-5.6.4: when true, accept axis edits that orphan existing variants —
  // flag those variants with `attributesOutOfTemplate=true` instead of blocking.
  force: z.boolean().optional(),
});
