-- 0078: Native OS push device tokens (FCM/APNs) for targeted push to a single
-- consumer or the assigned driver. Separate from the VAPID web-push
-- `push_subscriptions` table (endpoint + p256dh + auth); a native token is one string.

CREATE TABLE IF NOT EXISTS "device_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "recipient_kind" "actor_type" NOT NULL,
  "recipient_id" text NOT NULL,
  "token" text NOT NULL,
  "platform" "push_subscription_platform" NOT NULL,
  "app_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "device_tokens_recipient_idx"
  ON "device_tokens" ("recipient_kind", "recipient_id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "device_tokens_token_active_uniq"
  ON "device_tokens" ("token") WHERE "revoked_at" IS NULL;
