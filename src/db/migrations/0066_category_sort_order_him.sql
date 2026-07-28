-- 0066: Per-gender label + rail ordering for shared categories.
--
-- The category tree is mixed-gender: nodes both rails share are 'unisex', so the
-- same row renders in the HER rail and the HIM rail. Two things about a shared node
-- can still differ between rails:
--
--   label_him      — HER calls it "Shoes", HIM calls it "Footwear" (likewise
--                    Loungewear/Innerwear, Swimwear/Beachwear, Beauty/Grooming).
--                    NULL means both rails use `label`.
--   sort_order_him — HER puts Activewear before Outerwear and Bags before
--                    Accessories; HIM reverses both, so no single sort_order can
--                    produce the two rails. NULL means "same order as HER".
--
-- Without these two columns each divergent node would have to be duplicated per
-- gender, which would leave genuinely unisex products (a canvas sneaker, a fleece
-- hoodie) with no shared leaf to live in and therefore visible on only one rail.
ALTER TABLE "categories" ADD COLUMN "label_him" text;
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order_him" integer;
