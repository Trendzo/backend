-- 0063: Retailer self-serve "stop accepting orders" toggle.
--
-- NULL = store is accepting orders. A future timestamp = the retailer flipped the
-- store offline; it stops accepting orders until that instant, then auto-reopens
-- (checked lazily at order time and swept back to NULL by the lifecycle sweep).
-- Set to the start of the store's next opening window when going offline; cleared
-- when the retailer reopens early. Independent of `status` / the admin pause path.
ALTER TABLE "retailer_stores" ADD COLUMN IF NOT EXISTS "order_pause_until" timestamp with time zone;
