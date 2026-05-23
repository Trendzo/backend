/**
 * Admin store inventory CSV import + export.
 */
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  inventoryAdjustments,
  productListings,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notifySummaryToStoreOwners } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ExportQuery, ImportBody } from './store-inventory.validators.js';

type Auth = AccessTokenPayload;

async function loadStoreOr404(storeId: string) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

export async function csvImport(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof ImportBody>;
  requestId: string;
}) {
  const owned = await db
    .select({
      id: variants.id,
      sku: variants.sku,
      stock: variants.stock,
      reserved: variants.reserved,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(eq(productListings.storeId, input.storeId));
  const bySku = new Map<string, typeof owned>();
  for (const v of owned) {
    if (!v.sku) continue;
    const list = bySku.get(v.sku) ?? [];
    list.push(v);
    bySku.set(v.sku, list);
  }
  const errors: { row: number; sku: string; reason: string }[] = [];
  const toApply: { id: string; stock: number; prev: number }[] = [];
  input.body.rows.forEach((r, i) => {
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
    toApply.push({ id: v.id, stock: r.stock, prev: v.stock });
  });
  if (errors.length > 0) {
    throw new AppError(422, ErrorCode.ValidationError, 'Validation failed — no rows applied', errors);
  }
  await db.transaction(async (tx) => {
    for (const u of toApply) {
      await tx.update(variants).set({ stock: u.stock }).where(eq(variants.id, u.id));
      await tx.insert(inventoryAdjustments).values({
        id: newId(IdPrefix.InventoryAdjustment),
        variantId: u.id,
        delta: u.stock - u.prev,
        newStock: u.stock,
        reason: 'csv_import',
        actorKind: 'admin',
        actorId: input.auth.sub,
      });
    }
  });
  await recordAudit({
    actor: input.auth,
    action: 'inventory.csv_import',
    resourceKind: 'retailer_store',
    resourceId: input.storeId,
    after: { applied: toApply.length },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifySummaryToStoreOwners({
    storeId: input.storeId,
    action: 'updated stock via CSV on',
    count: toApply.length,
    deepLink: '/retailer/inventory',
  });
  return ok({ applied: toApply.length });
}

export async function csvExport(input: {
  storeId: string;
  query: z.infer<typeof ExportQuery>;
  reply: FastifyReply;
}) {
  await loadStoreOr404(input.storeId);
  const rows = await db
    .select({
      id: variants.id,
      listingName: productListings.name,
      listingStatus: productListings.status,
      sku: variants.sku,
      attributesLabel: variants.attributesLabel,
      stock: variants.stock,
      reserved: variants.reserved,
      pricePaise: variants.pricePaise,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(eq(productListings.storeId, input.storeId));

  const filtered = rows.filter((r) => {
    if (input.query.status && r.listingStatus !== input.query.status) return false;
    if (input.query.q) {
      const q = input.query.q.toLowerCase();
      if (
        !r.listingName.toLowerCase().includes(q) &&
        !(r.sku ?? '').toLowerCase().includes(q)
      )
        return false;
    }
    if (input.query.flag === 'out' && r.stock !== 0) return false;
    if (input.query.flag === 'low' && !(r.stock > 0 && r.stock <= 5)) return false;
    return true;
  });

  const escape = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['sku', 'product_name', 'variant_label', 'stock', 'reserved', 'price_paise', 'status'];
  const lines = [header.join(',')];
  for (const r of filtered) {
    lines.push(
      [
        escape(r.sku),
        escape(r.listingName),
        escape(r.attributesLabel),
        escape(r.stock),
        escape(r.reserved),
        escape(r.pricePaise),
        escape(r.listingStatus),
      ].join(','),
    );
  }
  const filename = `inventory-${input.storeId}-${new Date().toISOString().slice(0, 10)}.csv`;
  void input.reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(lines.join('\n'));
  return input.reply;
}
