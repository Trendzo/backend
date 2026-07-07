-- Add consumers.avatar_url (optional profile photo).
-- Hand-authored (do NOT db:push). The column was added to the Drizzle schema
-- (identity.ts: avatarUrl: text('avatar_url')) but never migrated or pushed to the
-- live DB, so any read of a consumer row — e.g. consumer OTP login, which SELECTs the
-- full column set — 500'd with `column "avatar_url" does not exist`.
-- Nullable, no default: matches text('avatar_url') in the schema. IF NOT EXISTS keeps
-- it a no-op on any environment where a stray db:push already added it.
ALTER TABLE "consumers" ADD COLUMN IF NOT EXISTS "avatar_url" text;
