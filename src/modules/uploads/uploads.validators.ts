import { z } from 'zod';

export const UploadQuery = z.object({
  /** Sub-folder under `closetx/`. Defaults to `uploads`. */
  folder: z.string().trim().min(1).max(120).optional(),
  /** Force a specific resource type. `auto` is fine for most callers. */
  resourceType: z.enum(['auto', 'image', 'video', 'raw']).optional(),
  /**
   * Caller-declared purpose. `listing-gallery` triggers strict 5 MB cap + JPEG/PNG/WebP
   * filter per spec US-5.2.4. Omitted purpose stays on the 25 MB lax ceiling for KYC
   * docs, storefront photos, support attachments, etc.
   */
  purpose: z.enum(['listing-gallery']).optional(),
});
