-- 0062: Make the acceptance uniqueness kind-aware + reconcile legacy rows.
--
-- Incident: the pre-kind backend served the newest retailer_terms row of ANY kind as
-- "the terms", so an accept recorded doc_kind='terms' against a PRIVACY version id.
-- The old partial unique index (store_id, terms_version) then made every genuine
-- privacy accept for that version a silent no-op (onConflictDoNothing).
--
-- Order matters:
--   1. Re-point doc_kind at the version's REAL kind (bootstrap-version rows, which
--      have no retailer_terms row, are untouched — their doc_kind is already right).
--   2. Drop exact duplicates that step 1 may have created, keeping the earliest.
--   3. Swap the unique index to (store_id, doc_kind, terms_version).
UPDATE "retailer_terms_acceptances" a
SET "doc_kind" = t."kind"
FROM "retailer_terms" t
WHERE a."terms_version" = t."id" AND a."doc_kind" <> t."kind";
--> statement-breakpoint
DELETE FROM "retailer_terms_acceptances" a
USING "retailer_terms_acceptances" b
WHERE a."decision" = 'accepted' AND b."decision" = 'accepted'
  AND a."store_id" = b."store_id" AND a."doc_kind" = b."doc_kind"
  AND a."terms_version" = b."terms_version" AND a."id" > b."id";
--> statement-breakpoint
DROP INDEX IF EXISTS "retailer_terms_acceptances_store_version_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retailer_terms_acceptances_store_kind_version_idx"
  ON "retailer_terms_acceptances" ("store_id", "doc_kind", "terms_version")
  WHERE "decision" = 'accepted';
