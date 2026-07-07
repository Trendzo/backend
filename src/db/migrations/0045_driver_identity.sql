ALTER TYPE "delivery_agent_status" ADD VALUE IF NOT EXISTS 'suspended';--> statement-breakpoint
ALTER TABLE "delivery_agents" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "vehicle_type" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "vehicle_number" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "licence_doc_url" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "rc_doc_url" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "insurance_doc_url" text;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "current_lat" double precision;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "current_lng" double precision;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "last_location_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_agents" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_agents_phone_idx" ON "delivery_agents" ("phone");
