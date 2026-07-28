-- 0065: Default payout cadence 7 → 15 days.
--
-- New/upcoming stores now settle every 15 days by default (was 7). App code
-- already supplies the value on store creation; this keeps the DB column default
-- in sync as a fallback. Existing stores were set to 15 by a one-off data script.
ALTER TABLE "retailer_stores" ALTER COLUMN "payout_cadence_days" SET DEFAULT 15;
