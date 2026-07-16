import { z } from 'zod';

/** Which legal document — Retailer T&C or Privacy Policy. Defaults keep old clients on 'terms'. */
export const LegalKind = z.enum(['terms', 'privacy']);

export const PublishTermsBody = z.object({
  kind: LegalKind.default('terms'),
  label: z.string().trim().max(64).optional(),
  shortText: z.string().trim().min(20).max(20000),
});

export const ListTermsQuery = z.object({ kind: LegalKind.default('terms') });

export const VersionParam = z.object({ version: z.string().min(1) });
