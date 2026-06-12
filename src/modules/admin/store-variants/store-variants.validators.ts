import { z } from 'zod';
import { PositivePaiseSchema, StockSchema } from '@/shared/validation/common.js';

export const StoreParam = z.object({ storeId: z.string() });
export const StoreListingParam = z.object({ storeId: z.string(), listingId: z.string() });

const VariantInput = z.object({
  attributes: z.record(z.string(), z.string()),
  attributesLabel: z.string().trim().min(1).max(120),
  // Optional explicit parent group; otherwise resolved from the color
  // attribute (creating the color group when missing) or the default group.
  groupId: z.string().optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  pricePaise: PositivePaiseSchema,
  stock: StockSchema.default(0),
  imageUrls: z.array(z.string().url()).default([]),
});

export const CreateVariantBody = VariantInput;

export const BulkCreateBody = z.object({
  variants: z.array(VariantInput).min(1).max(100),
});

export const BulkDeactivateBody = z.object({
  variantIds: z.array(z.string()).min(1).max(200),
});
