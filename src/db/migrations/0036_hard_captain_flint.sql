CREATE TABLE "pos_printer_configs" (
	"store_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"connection" text DEFAULT 'client' NOT NULL,
	"host" text,
	"port" integer DEFAULT 9100 NOT NULL,
	"paper_width" integer DEFAULT 80 NOT NULL,
	"chars_per_line" integer DEFAULT 48 NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"header_text" text,
	"footer_text" text DEFAULT 'Thank you! Please visit again.',
	"show_gst_breakup" boolean DEFAULT true NOT NULL,
	"show_qr" boolean DEFAULT false NOT NULL,
	"auto_print_on_sale" boolean DEFAULT true NOT NULL,
	"cash_drawer_enabled" boolean DEFAULT false NOT NULL,
	"cash_drawer_pin" integer DEFAULT 0 NOT NULL,
	"cash_drawer_only_on_cash" boolean DEFAULT true NOT NULL,
	"cash_drawer_on_sale" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_printer_configs_connection_guard" CHECK ("pos_printer_configs"."connection" in ('network','client','browser')),
	CONSTRAINT "pos_printer_configs_paper_guard" CHECK ("pos_printer_configs"."paper_width" in (58, 80)),
	CONSTRAINT "pos_printer_configs_pin_guard" CHECK ("pos_printer_configs"."cash_drawer_pin" in (0, 1)),
	CONSTRAINT "pos_printer_configs_port_guard" CHECK ("pos_printer_configs"."port" > 0 AND "pos_printer_configs"."port" <= 65535),
	CONSTRAINT "pos_printer_configs_copies_guard" CHECK ("pos_printer_configs"."copies" >= 1 AND "pos_printer_configs"."copies" <= 5)
);
--> statement-breakpoint
ALTER TABLE "pos_printer_configs" ADD CONSTRAINT "pos_printer_configs_store_id_retailer_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."retailer_stores"("id") ON DELETE cascade ON UPDATE no action;