import { z } from 'zod';

/** Paginated list of a store's uploaded media (newest first, keyset on createdAt). */
export const ListMediaQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  /** ISO timestamp of the last item from the previous page (keyset cursor). */
  cursor: z.string().optional(),
  folder: z.string().trim().min(1).max(120).optional(),
  type: z.enum(['image', 'video', 'raw']).optional(),
});

/** Multipart upload query — mirrors the generic /uploads endpoint's options. */
export const UploadMediaQuery = z.object({
  folder: z.string().trim().min(1).max(120).optional(),
  purpose: z.enum(['listing-gallery', 'listing-description']).optional(),
  alt: z.string().trim().max(300).optional(),
});

export const IdParam = z.object({ id: z.string() });
