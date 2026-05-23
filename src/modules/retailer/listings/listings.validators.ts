import { z } from 'zod';
import { PositivePaiseSchema, StockSchema } from '@/shared/validation/common.js';

export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const IdParam = z.object({ id: z.string() });
export const ListingIdParam = z.object({ listingId: z.string() });

export const ListQuery = z.object({
  status: z.enum(['draft', 'active', 'retired', 'taken_down']).optional(),
  sort: z.enum(['updated_desc', 'name_asc']).optional(),
});

export const CreateListingBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).optional(),
  brandId: z.string().min(1),
  categoryId: z.string().min(1),
  gender: GenderEnum,
  badge: z.enum(['new', 'hot', 'trending', 'none']).default('none'),
  listingPolicy: z.enum(['return', 'replace', 'final_sale']).default('return'),
  galleryUrls: z.array(z.string().url()).max(10).default([]),
  occasion: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  ageGroup: z.enum(['kids', 'teens', 'adults', 'all']).nullable().optional(),
  hsn: z.string().trim().max(8).optional(),
  templateId: z.string().optional(),
});

export const PatchListingBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).optional(),
    brandId: z.string().min(1).optional(),
    categoryId: z.string().min(1).optional(),
    gender: GenderEnum.optional(),
    badge: z.enum(['new', 'hot', 'trending', 'none']).optional(),
    listingPolicy: z.enum(['return', 'replace', 'final_sale']).optional(),
    galleryUrls: z.array(z.string().url()).max(10).optional(),
    occasion: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    ageGroup: z.enum(['kids', 'teens', 'adults', 'all']).nullable().optional(),
    hsn: z.string().trim().max(8).optional(),
    templateId: z.string().nullable().optional(),
    status: z.enum(['draft', 'active', 'retired']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const CreateVariantBody = z.object({
  attributes: z.record(z.string(), z.string()),
  attributesLabel: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(1).max(64).optional(),
  pricePaise: PositivePaiseSchema,
  stock: StockSchema.default(0),
  imageUrls: z.array(z.string().url()).default([]),
});

export const BulkCreateVariantsBody = z.object({
  variants: z
    .array(
      z.object({
        attributes: z.record(z.string(), z.string()),
        attributesLabel: z.string().trim().min(1).max(120),
        sku: z.string().trim().min(1).max(64).optional(),
        pricePaise: PositivePaiseSchema,
        stock: StockSchema.default(0),
        imageUrls: z.array(z.string().url()).default([]),
      }),
    )
    .min(1)
    .max(100),
});

export const PatchVariantBody = z
  .object({
    attributes: z.record(z.string(), z.string()).optional(),
    attributesLabel: z.string().trim().min(1).max(120).optional(),
    sku: z.string().trim().min(1).max(64).nullable().optional(),
    pricePaise: PositivePaiseSchema.optional(),
    stock: StockSchema.optional(),
    isActive: z.boolean().optional(),
    imageUrls: z.array(z.string().url()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const BulkStatusBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
  status: z.enum(['active', 'draft', 'retired']),
});
