ALTER TABLE "variants" ADD COLUMN IF NOT EXISTS "attributes_out_of_template" boolean NOT NULL DEFAULT false;
