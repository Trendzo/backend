import { z } from 'zod';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters/digits/hyphens');

export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  gender: GenderEnum.optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

export const CreateBody = z.object({
  slug: SlugSchema,
  label: z.string().trim().min(1).max(120),
  /** HIM-rail wording for a shared (unisex) node — "Shoes" HER vs "Footwear" HIM. */
  labelHim: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().nullable().optional(),
  gender: GenderEnum.default('unisex'),
  iconName: z.string().trim().max(60).optional(),
  tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().default(0),
  /** HIM-rail position for a shared node; omit when both rails order it the same. */
  sortOrderHim: z.number().int().optional(),
  isActive: z.boolean().default(true),
});

export const PatchBody = z
  .object({
    slug: SlugSchema.optional(),
    label: z.string().trim().min(1).max(120).optional(),
    labelHim: z.string().trim().min(1).max(120).nullable().optional(),
    parentId: z.string().nullable().optional(),
    gender: GenderEnum.optional(),
    iconName: z.string().trim().max(60).nullable().optional(),
    tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    imageUrl: z.string().url().nullable().optional(),
    sortOrder: z.number().int().optional(),
    sortOrderHim: z.number().int().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
