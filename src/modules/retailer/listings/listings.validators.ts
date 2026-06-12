import { z } from 'zod';
import { PositivePaiseSchema, StockSchema } from '@/shared/validation/common.js';

export const GenderEnum = z.enum(['her', 'him', 'unisex']);

export const IdParam = z.object({ id: z.string() });
export const ListingIdParam = z.object({ listingId: z.string() });
export const GroupParam = z.object({ listingId: z.string(), groupId: z.string() });

export const VariantModeEnum = z.enum(['single', 'color_size', 'custom']);

/** System age ranges a product can target (multi-select; [] = unspecified). */
export const AGE_RANGES = ['0-2', '3-7', '8-12', '13-17', '18-24', '25-40', '40+'] as const;
export const AgeRangeEnum = z.enum(AGE_RANGES);

export const ListQuery = z.object({
  status: z.enum(['draft', 'active', 'retired', 'taken_down']).optional(),
  sort: z.enum(['updated_desc', 'name_asc']).optional(),
});

export const CreateListingBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  // Rich HTML — sanitized server-side in the controller before persisting.
  // Raw cap is slightly above the post-sanitize byte cap (LONG_DESC_MAX_BYTES).
  descriptionLong: z.string().max(110_000).optional(),
  brandId: z.string().min(1),
  categoryId: z.string().min(1),
  gender: GenderEnum,
  listingPolicy: z.enum(['return', 'replace', 'final_sale']).default('return'),
  galleryUrls: z.array(z.string().url()).max(20).default([]),
  occasion: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  ageGroups: z.array(AgeRangeEnum).max(AGE_RANGES.length).default([]),
  hsn: z.string().trim().max(8).optional(),
  templateId: z.string().optional(),
  // Defaults in the controller: 'custom' when templateId is set, else 'single'.
  variantMode: VariantModeEnum.optional(),
});

export const PatchListingBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2_000).optional(),
    // null clears the long description; sanitized in the controller.
    descriptionLong: z.string().max(110_000).nullable().optional(),
    brandId: z.string().min(1).optional(),
    categoryId: z.string().min(1).optional(),
    gender: GenderEnum.optional(),
    listingPolicy: z.enum(['return', 'replace', 'final_sale']).optional(),
    galleryUrls: z.array(z.string().url()).max(20).optional(),
    occasion: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    ageGroups: z.array(AgeRangeEnum).max(AGE_RANGES.length).optional(),
    hsn: z.string().trim().max(8).optional(),
    templateId: z.string().nullable().optional(),
    variantMode: VariantModeEnum.optional(),
    status: z.enum(['draft', 'active', 'retired']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

// ===== Variant groups (system color → size hierarchy) =====

const ColorHexSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a #RRGGBB hex value');

export const CreateGroupBody = z.object({
  name: z.string().trim().min(1).max(60),
  colorHex: ColorHexSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const PatchGroupBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    // null clears the swatch.
    colorHex: ColorHexSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/** Group-scoped variant create: identity (attributes/label) is server-derived. */
const GroupVariantInput = z
  .object({
    size: z.string().trim().min(1).max(40),
    sku: z.string().trim().min(1).max(64).optional(),
    pricePaise: PositivePaiseSchema,
    compareAtPrice: PositivePaiseSchema.optional(),
    stock: StockSchema.default(0),
    imageUrls: z.array(z.string().url()).default([]),
  })
  .refine(
    (v) => v.compareAtPrice === undefined || v.compareAtPrice > v.pricePaise,
    { message: 'Compare-at price must be greater than the selling price' },
  );

export const CreateGroupVariantBody = GroupVariantInput;

export const BulkCreateGroupVariantsBody = z.object({
  variants: z.array(GroupVariantInput).min(1).max(100),
});

/** Idempotent upsert of the single-product default variant. */
export const DefaultVariantBody = z
  .object({
    sku: z.string().trim().min(1).max(64).optional(),
    pricePaise: PositivePaiseSchema,
    compareAtPrice: PositivePaiseSchema.nullable().optional(),
    stock: StockSchema.default(0),
    imageUrls: z.array(z.string().url()).default([]),
  })
  .refine(
    (v) => v.compareAtPrice == null || v.compareAtPrice > v.pricePaise,
    { message: 'Compare-at price must be greater than the selling price' },
  );

// compareAtPrice is the struck-through "was" price; when present it must exceed
// the selling price.
const comparePriceRefine = (v: { pricePaise: number; compareAtPrice?: number | undefined }) =>
  v.compareAtPrice === undefined || v.compareAtPrice > v.pricePaise;
const comparePriceMsg = { message: 'Compare-at price must be greater than the selling price' };

export const CreateVariantBody = z
  .object({
    attributes: z.record(z.string(), z.string()),
    attributesLabel: z.string().trim().min(1).max(120),
    // Optional explicit parent group; defaults to the listing's default group.
    groupId: z.string().optional(),
    sku: z.string().trim().min(1).max(64).optional(),
    pricePaise: PositivePaiseSchema,
    compareAtPrice: PositivePaiseSchema.optional(),
    stock: StockSchema.default(0),
    imageUrls: z.array(z.string().url()).default([]),
  })
  .refine(comparePriceRefine, comparePriceMsg);

export const BulkCreateVariantsBody = z.object({
  variants: z
    .array(
      z
        .object({
          attributes: z.record(z.string(), z.string()),
          attributesLabel: z.string().trim().min(1).max(120),
          sku: z.string().trim().min(1).max(64).optional(),
          pricePaise: PositivePaiseSchema,
          compareAtPrice: PositivePaiseSchema.optional(),
          stock: StockSchema.default(0),
          imageUrls: z.array(z.string().url()).default([]),
        })
        .refine(comparePriceRefine, comparePriceMsg),
    )
    .min(1)
    .max(100),
});

export const PatchVariantBody = z
  .object({
    // Raw identity edits are only honoured on `custom`-mode listings; the
    // system path derives identity from group + size (controller-enforced).
    attributes: z.record(z.string(), z.string()).optional(),
    attributesLabel: z.string().trim().min(1).max(120).optional(),
    // System path: change this variant's size (identity re-derived).
    size: z.string().trim().min(1).max(40).optional(),
    // Move the variant to another group on the same listing (identity re-derived).
    groupId: z.string().optional(),
    sku: z.string().trim().min(1).max(64).nullable().optional(),
    pricePaise: PositivePaiseSchema.optional(),
    // null clears the compare-at price; cross-field check vs pricePaise is done
    // in the controller (Zod can't see the existing row's price).
    compareAtPrice: PositivePaiseSchema.nullable().optional(),
    stock: StockSchema.optional(),
    isActive: z.boolean().optional(),
    imageUrls: z.array(z.string().url()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/** Query for the live SKU-availability check in the wizard's Step 1. */
export const SkuAvailableQuery = z.object({
  sku: z.string().trim().min(1).max(64),
  excludeVariantId: z.string().optional(),
});

/** Params for publishing a single variant. */
export const VariantPubParam = z.object({
  listingId: z.string(),
  vid: z.string(),
});

export const BulkStatusBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
  status: z.enum(['active', 'draft', 'retired']),
});
