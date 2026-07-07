import { z } from 'zod';

export const PublishTermsBody = z.object({
  label: z.string().trim().max(64).optional(),
  shortText: z.string().trim().min(20).max(20000),
});

export const VersionParam = z.object({ version: z.string().min(1) });
