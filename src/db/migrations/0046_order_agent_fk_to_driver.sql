ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_assigned_agent_id_retailer_accounts_id_fk";--> statement-breakpoint
-- Clear any stale assignment that points at a retailer account (pre-decouple test rows);
-- the id-space is now delivery_agents. Unassigns the order + drops its dead handoff code.
UPDATE "orders" SET "assigned_agent_id" = NULL, "agent_handoff_code" = NULL WHERE "assigned_agent_id" IS NOT NULL AND "assigned_agent_id" NOT IN (SELECT "id" FROM "delivery_agents");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_agent_id_delivery_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."delivery_agents"("id") ON DELETE no action ON UPDATE no action;
