-- Phase 7 AI catalog generation: extend ai_catalog_submissions for the Gemini
-- integration. New columns: prompt + reference_image_urls (required inputs),
-- revision_notes (set on regeneration children), target_variant_id (which
-- variant the output should attach to on accept), error_message (provider
-- error surfaced when status='failed').
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "target_variant_id" text;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "reference_image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "revision_notes" text;--> statement-breakpoint
ALTER TABLE "ai_catalog_submissions" ADD COLUMN IF NOT EXISTS "error_message" text;
