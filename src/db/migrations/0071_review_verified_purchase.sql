-- 0071: Verified-purchase flag on product reviews.
--
-- A review is a "verified purchase" when its author had a real (non-cancelled)
-- order containing the reviewed listing. The flag drives the consumer "Verified
-- Purchase" badge AND public visibility: the product detail read only returns
-- verified reviews, so a review written by someone who never bought the item is
-- recorded (and visible to its author under "My reviews") but never shown to
-- other shoppers. The flag is derived server-side at create time.
ALTER TABLE "product_reviews"
  ADD COLUMN IF NOT EXISTS "verified_purchase" boolean NOT NULL DEFAULT false;

-- Backfill existing rows (incl. seeded demo reviews) so they don't all vanish
-- from the now-gated public read. A row is verified when the same consumer has
-- an order_item for that listing in an order that isn't cancelled/payment-failed.
UPDATE "product_reviews" pr
SET "verified_purchase" = true
WHERE EXISTS (
  SELECT 1
  FROM "order_items" oi
  JOIN "orders" o ON o.id = oi.order_id
  WHERE oi.listing_id = pr.listing_id
    AND o.consumer_id = pr.consumer_id
    AND o.status NOT IN ('cancelled', 'payment_failed')
);
