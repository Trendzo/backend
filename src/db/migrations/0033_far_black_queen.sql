-- NOTE: drizzle-kit generated this migration with a large catch-up diff (moodboards,
-- referrals, consumer_loyalty, loyalty_transactions.balance_version_after, referral_code)
-- because those schema changes were previously applied to the database via `db:push`
-- without a generated migration. All of that already exists in the live DB, so this file
-- is trimmed to the only real delta: phone-OTP consumers sign up with just a verified
-- phone, so email/name/password_hash become nullable.
ALTER TABLE "consumers" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consumers" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consumers" ALTER COLUMN "password_hash" DROP NOT NULL;
