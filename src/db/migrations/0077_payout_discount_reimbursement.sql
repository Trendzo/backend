-- Retailers stop absorbing platform-funded discounts.
--
-- payout-math summed `orders.grand_total_paise` as the payout base. That figure is
-- already net of coupon, loyalty redemption and promo discounts, so every rupee the
-- platform discounted came straight out of the retailer's payout — while commission and
-- TCS were charged on the PRE-discount `items_subtotal_paise`. Two hits per order.
--
-- The reimbursement is recorded as its own column rather than being folded into
-- `gross_paise`: gross must keep reconciling to the sum of order grand totals, and the
-- retailer's statement needs this visible as a separate line.
--
-- Hand-authored rather than generated: the schema is ahead of the migration journal in
-- places, and `drizzle-kit generate` would bundle that unrelated drift into this file.

ALTER TABLE "payouts"
  ADD COLUMN IF NOT EXISTS "discount_reimbursement_paise" bigint NOT NULL DEFAULT 0;
