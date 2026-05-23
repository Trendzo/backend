-- Rename deactivated → terminated on retailer_account_status.
-- Single canonical "dead account" state shared by staff and owner accounts.
ALTER TYPE "public"."retailer_account_status" RENAME VALUE 'deactivated' TO 'terminated';--> statement-breakpoint

-- Drop 'under_review' from application_status. Apps now go: pending → docs_requested → approved/rejected.
-- "Reviewing" is implicit in 'pending'. Postgres can't DROP VALUE on an enum, so rebuild the type.
UPDATE "retailer_applications" SET "status" = 'pending' WHERE "status" = 'under_review';--> statement-breakpoint
ALTER TYPE "public"."application_status" RENAME TO "application_status_old";--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('pending', 'docs_requested', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "retailer_applications" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "retailer_applications" ALTER COLUMN "status" TYPE "public"."application_status" USING "status"::text::"public"."application_status";--> statement-breakpoint
ALTER TABLE "retailer_applications" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."application_status_old";
