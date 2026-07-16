-- 0061: Legal consent at signup — the application form now records T&C + Privacy
-- Policy consent (with the document versions current at submit time). On approval the
-- consent is seeded into retailer_terms_acceptances, so a fresh retailer is not
-- re-prompted after first login unless a newer version was published in between.
-- Purely additive; old clients that do not send consent keep the post-login gate.
ALTER TABLE "retailer_applications" ADD COLUMN IF NOT EXISTS "legal_consent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "retailer_applications" ADD COLUMN IF NOT EXISTS "consent_terms_version" text;
--> statement-breakpoint
ALTER TABLE "retailer_applications" ADD COLUMN IF NOT EXISTS "consent_privacy_version" text;
