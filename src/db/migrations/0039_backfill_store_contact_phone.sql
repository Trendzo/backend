-- Decouple store contact from the owner account + reconcile permanent-kill status.
-- Hand-authored (do NOT db:push). Idempotent: every UPDATE is guarded so a re-run is a no-op.

-- A. Backfill retailer_stores.contact_phone from the owning account's phone where the
--    store has none yet, so each store carries an independent, separately-editable copy.
--    account.phone is already E.164 (migration 0038), so this copies the canonical form.
UPDATE "retailer_stores" s SET "contact_phone" = a."phone"
FROM "retailer_accounts" a
WHERE a."store_id" = s."id"
  AND (s."contact_phone" IS NULL OR s."contact_phone" = '')
  AND a."phone" <> '';--> statement-breakpoint

-- B. Defensively E.164-normalise any store contact phones still stored as bare 10 digits.
UPDATE "retailer_stores"
SET "contact_phone" = '+91' || regexp_replace("contact_phone", '\D', '', 'g')
WHERE "contact_phone" ~ '^[0-9]{10}$';--> statement-breakpoint

-- C. Reconcile permanent-kill store status: a permanently-suspended store should read
--    'terminated' (matching terminateRetailer), not the legacy 'suspended'.
UPDATE "retailer_stores" SET "status" = 'terminated'
WHERE "permanent_suspend" = true AND "status" = 'suspended';
