-- 0060: Privacy Policy pipeline — reuse the legal-document tables with a kind column.
--
-- `retailer_terms` now stores versions of BOTH legal documents ('terms' | 'privacy');
-- `retailer_terms_acceptances.doc_kind` mirrors it on the decision log. Purely
-- additive: every existing row backfills to 'terms', so the live T&C flow is
-- untouched. Version ids stay globally unique, so the partial unique index on
-- (store_id, terms_version) WHERE decision='accepted' still enforces one accept
-- per (store, version) across both kinds.
ALTER TABLE "retailer_terms" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'terms';
--> statement-breakpoint
ALTER TABLE "retailer_terms_acceptances" ADD COLUMN IF NOT EXISTS "doc_kind" text NOT NULL DEFAULT 'terms';
