-- 0045 added the delivery_agents FK but the ORIGINAL FK (created in 0027 under Postgres's
-- default name `orders_assigned_agent_id_fkey`, still → retailer_accounts) survived the
-- drop-if-exists (which only matched drizzle's verbose name). Both FKs coexisting makes a
-- driver assignment impossible (a value can't be in both tables). Drop the stale one.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_assigned_agent_id_fkey";
