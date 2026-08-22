import { z } from 'zod';
import { PRIVACY_APPS } from '@/db/schema/legal-pages.js';

export const AppParam = z.object({
  app: z.enum(PRIVACY_APPS),
});

export const UpdatePolicyBody = z.object({
  title: z.string().min(1).max(200),
  effectiveDate: z.string().min(1).max(60),
  // Rich-text HTML; sanitized on write. Capped to match the rich-text limit.
  bodyHtml: z.string().min(1).max(100_000),
});
