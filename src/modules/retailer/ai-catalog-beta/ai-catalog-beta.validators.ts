import { z } from 'zod';
import {
  AGE_RANGES,
  AgeRangeEnum,
  GenderEnum,
} from '@/modules/retailer/listings/listings.validators.js';
import { PositivePaiseSchema, StockSchema } from '@/shared/validation/common.js';

export const IdParam = z.object({ id: z.string() });

/**
 * Create a BETA submission. Images are pre-uploaded URLs (client uploads the
 * apparel photo(s) and the optional design via POST /api/v1/uploads first),
 * matching the legacy ai-catalog convention. `only` limits which angle presets
 * are generated (cheap testing).
 */
export const SubmissionBody = z.object({
  mode: z.enum(['without_model', 'with_model']),
  prompt: z.string().trim().max(800).optional(),
  apparelImageUrls: z.array(z.string().url()).min(1).max(5),
  // Optional real BACK photo of the plain apparel. When present (and no design),
  // back views (`back` / `model-back`) render from THIS photo instead of
  // hallucinating the back from the front image.
  apparelBackImageUrl: z.string().url().optional(),
  designImageUrl: z.string().url().optional(),
  only: z.array(z.string()).optional(),
});

export const DecisionBody = z.object({
  decision: z.enum(['accept', 'reject']),
  revisionNotes: z.string().trim().min(1).max(400).optional(),
});

/**
 * Product details captured at publish. Mirrors CreateListingBody (minus
 * gallery/template/variantMode, which we set) plus the single default variant's
 * price/stock. brandId is required — publish reuses createListing as-is.
 */
export const PublishBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).optional(),
    descriptionLong: z.string().max(110_000).optional(),
    brandId: z.string().min(1),
    categoryId: z.string().min(1),
    gender: GenderEnum,
    listingPolicy: z.enum(['return', 'replace', 'final_sale']).default('return'),
    occasion: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    ageGroups: z.array(AgeRangeEnum).max(AGE_RANGES.length).default([]),
    hsn: z.string().trim().max(8).optional(),
    pricePaise: PositivePaiseSchema,
    compareAtPrice: PositivePaiseSchema.optional(),
    stock: StockSchema.default(0),
    // Subset of the submission's outputUrls to use as the listing gallery.
    // Defaults to all outputUrls when omitted.
    selectedImageUrls: z.array(z.string().url()).max(20).optional(),
  })
  .refine((v) => v.compareAtPrice === undefined || v.compareAtPrice > v.pricePaise, {
    message: 'Compare-at price must be greater than the selling price',
    path: ['compareAtPrice'],
  });

/**
 * Quick mockups = the same generation as a submission, but stateless (no DB row,
 * no product). Reuses SubmissionBody's shape.
 */
export const MockupsBody = SubmissionBody;

/** Customer virtual try-on: a person photo + 1-2 garment photos (layered). */
export const TryOnBody = z.object({
  personImageUrl: z.string().url(),
  garmentImageUrls: z.array(z.string().url()).min(1).max(2),
});

export const ListQuery = z.object({
  status: z
    .enum([
      'submitted',
      'processing',
      'ready_for_review',
      'accepted',
      'rejected',
      'regenerating',
      'failed',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
