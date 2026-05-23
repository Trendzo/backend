import { z } from 'zod';

export const StoreParam = z.object({ storeId: z.string() });
export const StoreListingParam = z.object({ storeId: z.string(), listingId: z.string() });

export const CreateListingBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).optional(),
  brandId: z.string().min(1),
  categoryId: z.string().min(1),
  gender: z.enum(['her', 'him', 'unisex']),
  badge: z.enum(['new', 'hot', 'trending', 'none']).default('none'),
  listingPolicy: z.enum(['return', 'replace', 'final_sale']).default('return'),
  galleryUrls: z.array(z.string().url()).default([]),
  hsn: z.string().trim().max(8).optional(),
  templateId: z.string().optional(),
});

export const BulkStatusBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
  status: z.enum(['active', 'draft', 'retired']),
});

export const BulkDeleteBody = z.object({
  ids: z.array(z.string()).min(1).max(100),
});
