ALTER TABLE "product_listings" DROP CONSTRAINT "product_listings_brand_id_brands_id_fk";
--> statement-breakpoint
ALTER TABLE "product_listings" ALTER COLUMN "brand_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_listings" ADD CONSTRAINT "product_listings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_lower_idx" ON "brands" USING btree (lower("name"));