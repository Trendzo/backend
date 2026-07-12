-- Retailer account closure/reopen flow. Replaces the destructive single-click
-- delete with a request → admin-approval lifecycle.
--   * retailer_account_status gains 'closed' — a REVERSIBLE closed state (records
--     kept, store suspended not terminated) that the owner/manager can reopen.
--   * change_request_field gains 'account_deletion' and 'account_reopen' — action
--     requests (no requestedValue) that flow through the existing change-request
--     approve/reject queue. Approving 'account_deletion' suspends the store and
--     closes every store account; 'account_reopen' restores them to active.
ALTER TYPE "public"."retailer_account_status" ADD VALUE IF NOT EXISTS 'closed';--> statement-breakpoint
ALTER TYPE "public"."change_request_field" ADD VALUE IF NOT EXISTS 'account_deletion';--> statement-breakpoint
ALTER TYPE "public"."change_request_field" ADD VALUE IF NOT EXISTS 'account_reopen';
