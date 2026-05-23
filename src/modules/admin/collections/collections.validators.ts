import { z } from 'zod';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters/digits/hyphens');

export const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend', 'brand']);
export const CollectionStatusEnum = z.enum(['draft', 'active', 'archived']);
export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  kind: CollectionKindEnum.optional(),
  gender: GenderEnum.optional(),
  status: CollectionStatusEnum.optional(),
  featured: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

export const CreateBody = z
  .object({
    slug: SlugSchema,
    name: z.string().trim().min(1).max(120),
    kind: CollectionKindEnum,
    gender: GenderEnum.default('unisex'),
    description: z.string().trim().max(1000).optional(),
    heroImageUrl: z.string().url().optional(),
    accentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),
    sortOrder: z.number().int().default(0),
    isFeatured: z.boolean().default(false),
    status: CollectionStatusEnum.default('draft'),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    brandId: z.string().nullable().optional(),
    occasionTag: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine(
    (v) => !(v.startsAt && v.endsAt) || new Date(v.endsAt) > new Date(v.startsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  )
  .refine(
    (v) => v.kind !== 'brand' || Boolean(v.brandId),
    { message: 'brandId is required when kind=brand', path: ['brandId'] },
  )
  .refine(
    (v) => v.kind !== 'occasion' || Boolean(v.occasionTag || v.name),
    { message: 'occasionTag is required when kind=occasion', path: ['occasionTag'] },
  );

export const PatchBody = z
  .object({
    slug: SlugSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    kind: CollectionKindEnum.optional(),
    gender: GenderEnum.optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    heroImageUrl: z.string().url().nullable().optional(),
    accentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).optional(),
    sortOrder: z.number().int().optional(),
    isFeatured: z.boolean().optional(),
    status: CollectionStatusEnum.optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    brandId: z.string().nullable().optional(),
    occasionTag: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const ListingsBody = z.object({
  listingIds: z.array(z.string()).max(500),
});

export const ListingsSearchQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  brandId: z.string().optional(),
  categoryId: z.string().optional(),
  gender: GenderEnum.optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
