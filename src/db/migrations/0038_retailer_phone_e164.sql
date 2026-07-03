-- Retailer phone → canonical E.164 for international phone-OTP login.
-- Hand-authored (do NOT db:push): backfill existing India-only phones, then enforce a
-- 1:1 phone→account so MSG91 OTP login resolves exactly one retailer.

-- A. Backfill retailer_accounts.phone to E.164. Existing data is India-only, so bare
--    10-digit numbers get +91; already country-coded values keep their code. Staff/access
--    accounts store phone='' and are left untouched (not OTP-capable).
UPDATE "retailer_accounts" SET "phone" =
	CASE
		WHEN "phone" LIKE '+%' THEN '+' || regexp_replace("phone", '\D', '', 'g')
		WHEN length(regexp_replace("phone", '\D', '', 'g')) = 10 THEN '+91' || regexp_replace("phone", '\D', '', 'g')
		ELSE '+' || regexp_replace("phone", '\D', '', 'g')
	END
WHERE "phone" <> '';--> statement-breakpoint
-- B. Same for pending applications' owner phone (copied to retailer_accounts on approval).
UPDATE "retailer_applications" SET "owner_phone" =
	CASE
		WHEN "owner_phone" LIKE '+%' THEN '+' || regexp_replace("owner_phone", '\D', '', 'g')
		WHEN length(regexp_replace("owner_phone", '\D', '', 'g')) = 10 THEN '+91' || regexp_replace("owner_phone", '\D', '', 'g')
		ELSE '+' || regexp_replace("owner_phone", '\D', '', 'g')
	END
WHERE "owner_phone" <> '';--> statement-breakpoint
-- C. 1:1 phone→account (partial: excludes '' staff/access rows). If a real duplicate phone
--    survives the backfill this CREATE fails loudly — resolve by hand, as two accounts must
--    not share one login phone.
CREATE UNIQUE INDEX "retailer_accounts_phone_idx" ON "retailer_accounts" USING btree ("phone") WHERE "retailer_accounts"."phone" <> '';
