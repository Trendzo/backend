/**
 * Retailer-side inventory operations — flat across listings.
 *
 * The Products tab edits *catalog metadata* (name, variants, gallery). Stock is its
 * own surface because the cadence is different (daily ops vs monthly catalog work)
 * and the operations are different (bulk CSV, low-stock scanning). All endpoints
 * here are scoped to the authenticated retailer's store; no cross-store reads.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { StockSchema } from '@/shared/validation/common.js';

/** Same loaders the parent retailer module uses, kept local so this stays a self-
 *  contained plugin. If they diverge, lift to a shared module. */
async function loadRetailer(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw AppError.unauthorized('Retailer account no longer exists');
  return retailer;
}

async function loadOwnedStore(retailerStoreId: string | null) {
  if (!retailerStoreId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found — create one first');
  }
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailerStoreId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

/** Fetch the flat inventory roster for a store: every variant joined with its
 *  listing/brand, sorted listing-then-variant for stable presentation. */
async function fetchInventoryRows(storeId: string) {
  const rows = await db
    .select({
      id: variants.id,
      listingId: productListings.id,
      listingName: productListings.name,
      listingStatus: productListings.status,
      brandName: brands.name,
      sku: variants.sku,
      attributesLabel: variants.attributesLabel,
      pricePaise: variants.pricePaise,
      stock: variants.stock,
      reserved: variants.reserved,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .leftJoin(brands, eq(productListings.brandId, brands.id))
    .where(eq(productListings.storeId, storeId))
    .orderBy(productListings.name, variants.attributesLabel);
  return rows;
}

/** RFC 4180-ish escape — quote any cell containing a delimiter, quote, or newline. */
function csvCell(value: string | number | null | undefined): string {
  const v = value == null ? '' : String(value);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const ImportRowSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  stock: StockSchema,
});

const ImportBodySchema = z.object({
  rows: z.array(ImportRowSchema).min(1).max(5_000),
});

const inventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/inventory — flat list across all the store's variants =====
  app.get('/', {}, async (req) => {
    const auth = getAuth(req);
    const retailer = await loadRetailer(auth.sub);
    const store = await loadOwnedStore(retailer.storeId);
    const rows = await fetchInventoryRows(store.id);
    return ok(rows);
  });

  // ===== GET /retailer/inventory/export — CSV download =====
  // Returns the same shape as the JSON list, RFC-4180-escaped, ready to round-trip
  // through Excel / Numbers / Sheets. Header row is fixed; the import endpoint only
  // requires `sku,stock`, but we export everything for context when editing.
  app.get('/export', {}, async (req, reply) => {
    const auth = getAuth(req);
    const retailer = await loadRetailer(auth.sub);
    const store = await loadOwnedStore(retailer.storeId);
    const rows = await fetchInventoryRows(store.id);

    const header = ['sku', 'product_name', 'variant_label', 'stock', 'reserved', 'price_paise', 'status'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.sku),
          csvCell(r.listingName),
          csvCell(r.attributesLabel),
          csvCell(r.stock),
          csvCell(r.reserved),
          csvCell(r.pricePaise),
          csvCell(r.listingStatus),
        ].join(','),
      );
    }

    const filename = `inventory-${store.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(lines.join('\n'));
    return reply;
  });

  // ===== POST /retailer/inventory/import — bulk stock update by SKU =====
  // Accepts a JSON `{ rows: [{sku, stock}] }` payload (the dashboard parses CSV
  // client-side so it can show a preview before submit). Per-row apply: bad rows
  // are reported but never abort the whole file. Reasons:
  //   - sku_not_found: no variant in this store has that SKU
  //   - sku_ambiguous: multiple variants share that SKU (we won't guess)
  //   - below_reserved: requested stock would violate the stock>=reserved CHECK
  app.post(
    '/import',
    { schema: { body: ImportBodySchema } },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const owned = await db
        .select({
          id: variants.id,
          sku: variants.sku,
          stock: variants.stock,
          reserved: variants.reserved,
        })
        .from(variants)
        .innerJoin(productListings, eq(variants.listingId, productListings.id))
        .where(and(eq(productListings.storeId, store.id)));

      // SKU → variants[]. Multiple matches are flagged at apply time, not here.
      const bySku = new Map<string, typeof owned>();
      for (const v of owned) {
        if (!v.sku) continue;
        const list = bySku.get(v.sku) ?? [];
        list.push(v);
        bySku.set(v.sku, list);
      }

      const errors: { row: number; sku: string; reason: string }[] = [];
      const toApply: { id: string; stock: number }[] = [];

      req.body.rows.forEach((r, i) => {
        const rowNum = i + 1;
        const matches = bySku.get(r.sku);
        if (!matches || matches.length === 0) {
          errors.push({ row: rowNum, sku: r.sku, reason: 'sku_not_found' });
          return;
        }
        if (matches.length > 1) {
          errors.push({ row: rowNum, sku: r.sku, reason: 'sku_ambiguous' });
          return;
        }
        const v = matches[0]!;
        if (r.stock < v.reserved) {
          errors.push({ row: rowNum, sku: r.sku, reason: 'below_reserved' });
          return;
        }
        toApply.push({ id: v.id, stock: r.stock });
      });

      let applied = 0;
      if (toApply.length > 0) {
        await db.transaction(async (tx) => {
          for (const u of toApply) {
            await tx.update(variants).set({ stock: u.stock }).where(eq(variants.id, u.id));
            applied += 1;
          }
        });
      }

      return ok({
        applied,
        skipped: errors.length,
        errors,
      });
    },
  );
};

export default inventoryRoutes;
