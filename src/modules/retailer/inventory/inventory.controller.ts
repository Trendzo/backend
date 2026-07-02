/**
 * Retailer-side inventory operations — flat across listings.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  inventoryAdjustments,
  inventoryReservations,
  listingAuditEntries,
  orderItems,
  orders,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  colorFromAttributes,
  insertDefaultGroup,
  resolveGroupId,
} from '@/shared/variant-groups.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import {
  classify,
  type ListingCreatePlan,
  type RawImportRow,
  type VariantCreatePlan,
} from './import-classifier.js';
import type {
  AdjustmentsQuery,
  BestSellersQuery,
  ExportQuery,
  ImportBody,
  ListQuery,
  ReservationsQuery,
  SettingsBody,
} from './inventory.validators.js';

type Auth = AccessTokenPayload;

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

async function fetchInventoryRows(
  storeId: string,
  lowStockThreshold: number,
  filters: {
    q?: string;
    status?: 'active' | 'draft' | 'retired' | 'taken_down';
    flag?: 'low' | 'out' | 'all' | 'oversold' | 'in_stock';
    categoryId?: string;
  } = {},
) {
  const conditions = [eq(productListings.storeId, storeId)];
  if (filters.status) conditions.push(eq(productListings.status, filters.status));
  if (filters.categoryId) conditions.push(eq(productListings.categoryId, filters.categoryId));
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(or(ilike(productListings.name, term), ilike(variants.sku, term))!);
  }

  const rows = await db
    .select({
      id: variants.id,
      listingId: productListings.id,
      listingName: productListings.name,
      listingStatus: productListings.status,
      categoryId: productListings.categoryId,
      categorySlug: categories.slug,
      brandName: brands.name,
      brandSlug: brands.slug,
      gender: productListings.gender,
      sku: variants.sku,
      attributesLabel: variants.attributesLabel,
      attributes: variants.attributes,
      pricePaise: variants.pricePaise,
      compareAtPrice: variants.compareAtPrice,
      stock: variants.stock,
      reserved: variants.reserved,
      isActive: variants.isActive,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .leftJoin(brands, eq(productListings.brandId, brands.id))
    .leftJoin(categories, eq(productListings.categoryId, categories.id))
    .where(and(...conditions))
    .orderBy(productListings.name, variants.attributesLabel);

  if (filters.flag === 'out') return rows.filter((r) => r.stock === 0);
  if (filters.flag === 'oversold') return rows.filter((r) => r.stock - r.reserved < 0);
  if (filters.flag === 'low') return rows.filter((r) => r.stock > 0 && r.stock <= lowStockThreshold);
  if (filters.flag === 'in_stock') return rows.filter((r) => r.stock - r.reserved > 0);
  return rows;
}

function csvCell(value: string | number | null | undefined): string {
  const v = value == null ? '' : String(value);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const INVENTORY_CSV_HEADER = [
  'sku',
  'product_name',
  'variant_label',
  'attributes',
  'brand',
  'category',
  'gender',
  'price_paise',
  'stock',
  'reserved',
  'status',
] as const;

export type InventoryCsvColumn = (typeof INVENTORY_CSV_HEADER)[number];

export async function listInventory(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const { q, status, flag, categoryId, page, pageSize } = input.query;
  const all = await fetchInventoryRows(store.id, store.lowStockThreshold, {
    ...(q !== undefined && { q }),
    ...(status !== undefined && { status }),
    ...(flag !== undefined && { flag }),
    ...(categoryId !== undefined && { categoryId }),
  });
  const total = all.length;
  const start = (page - 1) * pageSize;
  const rows = all.slice(start, start + pageSize);
  return ok({ rows, total, page, pageSize, lowStockThreshold: store.lowStockThreshold });
}

export async function patchSettings(input: { auth: Auth; body: z.infer<typeof SettingsBody> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const [updated] = await db
    .update(retailerStores)
    .set({ lowStockThreshold: input.body.lowStockThreshold })
    .where(eq(retailerStores.id, store.id))
    .returning({ lowStockThreshold: retailerStores.lowStockThreshold });
  return ok(updated);
}

export async function listReservations(input: {
  auth: Auth;
  variantId: string;
  query: z.infer<typeof ReservationsQuery>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const variant = await db.query.variants.findFirst({
    where: eq(variants.id, input.variantId),
    with: { listing: { columns: { storeId: true } } },
  });
  if (!variant || variant.listing.storeId !== store.id) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  }
  const rows = await db
    .select({
      id: inventoryReservations.id,
      qty: inventoryReservations.qty,
      ownerKind: inventoryReservations.ownerKind,
      ownerId: inventoryReservations.ownerId,
      reservedAt: inventoryReservations.reservedAt,
      expiresAt: inventoryReservations.expiresAt,
    })
    .from(inventoryReservations)
    .where(
      and(eq(inventoryReservations.variantId, variant.id), isNull(inventoryReservations.releasedAt)),
    )
    .orderBy(desc(inventoryReservations.reservedAt))
    .limit(input.query.limit);
  return ok(rows);
}

export async function listAdjustments(input: {
  auth: Auth;
  query: z.infer<typeof AdjustmentsQuery>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const storeVariants = await db.query.productListings.findMany({
    where: eq(productListings.storeId, store.id),
    with: { variants: { columns: { id: true } } },
  });
  const variantIds = storeVariants.flatMap((l) => l.variants.map((v) => v.id));
  if (variantIds.length === 0) return ok([]);

  const conditions = [inArray(inventoryAdjustments.variantId, variantIds)];
  if (input.query.variantId) conditions.push(eq(inventoryAdjustments.variantId, input.query.variantId));
  if (input.query.from) conditions.push(gte(inventoryAdjustments.at, new Date(input.query.from)));
  if (input.query.to) conditions.push(lte(inventoryAdjustments.at, new Date(input.query.to)));

  const rows = await db.query.inventoryAdjustments.findMany({
    where: and(...conditions),
    orderBy: desc(inventoryAdjustments.at),
    limit: input.query.limit,
  });
  return ok(rows);
}

export async function exportInventory(input: {
  auth: Auth;
  query: z.infer<typeof ExportQuery>;
  reply: FastifyReply;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const { q, status, flag, categoryId, cols } = input.query;
  const rows = await fetchInventoryRows(store.id, store.lowStockThreshold, {
    ...(q !== undefined && { q }),
    ...(status !== undefined && { status }),
    ...(flag !== undefined && { flag }),
    ...(categoryId !== undefined && { categoryId }),
  });

  const requested = cols ? new Set(cols.split(',').map((c) => c.trim()).filter(Boolean)) : null;
  let effectiveCols: InventoryCsvColumn[] = requested
    ? INVENTORY_CSV_HEADER.filter((c) => requested.has(c))
    : [...INVENTORY_CSV_HEADER];
  if (effectiveCols.length === 0) effectiveCols = [...INVENTORY_CSV_HEADER];
  const hasIdentifier =
    effectiveCols.includes('sku') ||
    (effectiveCols.includes('product_name') && effectiveCols.includes('variant_label')) ||
    (effectiveCols.includes('product_name') && effectiveCols.includes('attributes'));
  if (!hasIdentifier) effectiveCols = ['sku', ...effectiveCols];

  function cellFor(col: InventoryCsvColumn, r: (typeof rows)[number]): string | number | null {
    switch (col) {
      case 'sku':
        return r.sku;
      case 'product_name':
        return r.listingName;
      case 'variant_label':
        return r.attributesLabel;
      case 'attributes':
        return Object.entries((r.attributes ?? {}) as Record<string, string>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join('|');
      case 'brand':
        return r.brandSlug ?? '';
      case 'category':
        return r.categorySlug ?? '';
      case 'gender':
        return r.gender;
      case 'price_paise':
        return r.pricePaise;
      case 'stock':
        return r.stock;
      case 'reserved':
        return r.reserved;
      case 'status':
        return r.listingStatus;
    }
  }

  const lines = ['﻿' + effectiveCols.join(',')];
  for (const r of rows) {
    lines.push(effectiveCols.map((c) => csvCell(cellFor(c, r))).join(','));
  }

  const filename = `inventory-${store.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  void input.reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(lines.join('\n'));
  return input.reply;
}

export async function importInventory(input: { auth: Auth; body: z.infer<typeof ImportBody> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const ownedVariants = await db
    .select({
      id: variants.id,
      listingId: variants.listingId,
      sku: variants.sku,
      attributesLabel: variants.attributesLabel,
      attributes: variants.attributes,
      stock: variants.stock,
      reserved: variants.reserved,
      pricePaise: variants.pricePaise,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(eq(productListings.storeId, store.id));
  const ownedListings = await db
    .select({
      id: productListings.id,
      name: productListings.name,
      brandId: productListings.brandId,
      categoryId: productListings.categoryId,
      gender: productListings.gender,
    })
    .from(productListings)
    .where(eq(productListings.storeId, store.id));
  const allBrands = await db
    .select({ id: brands.id, slug: brands.slug, name: brands.name })
    .from(brands);
  const allCategories = await db
    .select({ id: categories.id, slug: categories.slug, label: categories.label })
    .from(categories);

  const rawRows: RawImportRow[] = input.body.rows.map((r) => ({
    ...(r.sku !== undefined && { sku: r.sku }),
    ...(r.productName !== undefined && { productName: r.productName }),
    ...(r.variantLabel !== undefined && { variantLabel: r.variantLabel }),
    ...(r.attributes !== undefined && { attributes: r.attributes }),
    ...(r.brand !== undefined && { brand: r.brand }),
    ...(r.category !== undefined && { category: r.category }),
    ...(r.gender !== undefined && { gender: r.gender }),
    ...(r.pricePaise !== undefined && { pricePaise: r.pricePaise }),
    stock: r.stock,
  }));

  const { plan, summary } = classify(rawRows, {
    variants: ownedVariants.map((v) => ({
      id: v.id,
      listingId: v.listingId,
      sku: v.sku,
      attributesLabel: v.attributesLabel,
      attributes: v.attributes as Record<string, string>,
      stock: v.stock,
      reserved: v.reserved,
      pricePaise: v.pricePaise,
    })),
    listings: ownedListings.map((l) => ({
      id: l.id,
      name: l.name,
      brandId: l.brandId,
      categoryId: l.categoryId,
      gender: l.gender as 'her' | 'him' | 'unisex',
    })),
    brands: allBrands,
    categories: allCategories,
  });

  const valid = plan
    .filter((p) => p.action === 'stock_update' && p.stockUpdate)
    .map((p) => ({
      row: p.row,
      sku: p.identifier,
      variantId: p.stockUpdate!.variantId,
      currentStock: p.stockUpdate!.currentStock,
      newStock: p.stockUpdate!.newStock,
      delta: p.stockUpdate!.delta,
    }));
  const errorList = plan
    .filter((p) => p.action === 'error' && p.error)
    .map((p) => ({
      row: p.row,
      sku: p.identifier,
      reason: p.error!.reason,
      ...(p.error!.detail && { detail: p.error!.detail }),
    }));

  if (input.body.dryRun) {
    return ok({ dryRun: true, applied: 0, summary, plan, valid, errors: errorList });
  }

  if (errorList.length > 0) {
    throw new AppError(422, ErrorCode.ValidationError, 'Validation failed - no rows applied', errorList);
  }

  if (summary.listingCreates > 500) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Too many listing creates in one batch (${summary.listingCreates}). Cap is 500 per upload - split the file.`,
    );
  }

  const createdListings: Array<{ row: number; listingId: string; name: string }> = [];
  const createdVariants: Array<{ row: number; variantId: string; listingId: string; sku: string | null }> = [];
  const updatedVariants: Array<{ row: number; variantId: string; delta: number; priceChanged: boolean }> = [];
  let priceUpdates = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'inv-import:' + store.id}))`);

    for (const p of plan) {
      if (p.action !== 'listing_create' || !p.listingCreate) continue;
      const lc: ListingCreatePlan = p.listingCreate;
      const lid = newId('lst');
      const csvHasColor = colorFromAttributes(lc.variant.attributes) !== null;
      await tx.insert(productListings).values({
        id: lid,
        storeId: store.id,
        brandId: lc.brandId,
        categoryId: lc.categoryId,
        name: lc.listingName,
        gender: lc.gender,
        variantMode: csvHasColor
          ? 'color_size'
          : Object.keys(lc.variant.attributes).length > 0
            ? 'custom'
            : 'single',
        status: 'draft',
      });
      createdListings.push({ row: p.row, listingId: lid, name: lc.listingName });
      await insertDefaultGroup(tx, lid, store.id);
      const groupId = await resolveGroupId(
        tx,
        { id: lid, storeId: store.id },
        { attributes: lc.variant.attributes, createMissing: true },
      );
      const vid = newId('var');
      await tx.insert(variants).values({
        id: vid,
        listingId: lid,
        storeId: store.id,
        groupId,
        ...(lc.variant.sku && { sku: lc.variant.sku }),
        attributes: lc.variant.attributes,
        attributesLabel: lc.variant.attributesLabel,
        pricePaise: lc.variant.pricePaise,
        stock: lc.variant.stock,
      });
      createdVariants.push({ row: p.row, variantId: vid, listingId: lid, sku: lc.variant.sku ?? null });
      if (lc.variant.stock > 0) {
        await tx.insert(inventoryAdjustments).values({
          id: newId(IdPrefix.InventoryAdjustment),
          variantId: vid,
          delta: lc.variant.stock,
          newStock: lc.variant.stock,
          reason: 'csv_import',
          actorKind: 'retailer',
          actorId: input.auth.sub,
        });
      }
      await tx.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: lid,
        action: 'created_via_csv',
        actorKind: 'retailer',
        actorId: input.auth.sub,
        note: `via CSV import row ${p.row}`,
      });
    }

    const nameToListingId = new Map<string, string>();
    for (const l of ownedListings) nameToListingId.set(l.name.trim().toLowerCase(), l.id);
    for (const c of createdListings) nameToListingId.set(c.name.trim().toLowerCase(), c.listingId);

    for (const p of plan) {
      if (p.action !== 'variant_create' || !p.variantCreate) continue;
      const vc: VariantCreatePlan = p.variantCreate;
      let listingId = vc.listingId;
      if (listingId.startsWith('__pending:')) {
        const resolved = nameToListingId.get(listingId.slice('__pending:'.length));
        if (!resolved) {
          throw new AppError(
            500,
            ErrorCode.InternalError,
            `Unresolved pending listing for row ${p.row}`,
          );
        }
        listingId = resolved;
      }
      const groupId = await resolveGroupId(
        tx,
        { id: listingId, storeId: store.id },
        { attributes: vc.attributes, createMissing: true },
      );
      const vid = newId('var');
      await tx.insert(variants).values({
        id: vid,
        listingId,
        storeId: store.id,
        groupId,
        ...(vc.sku && { sku: vc.sku }),
        attributes: vc.attributes,
        attributesLabel: vc.attributesLabel,
        pricePaise: vc.pricePaise,
        stock: vc.stock,
      });
      createdVariants.push({ row: p.row, variantId: vid, listingId, sku: vc.sku ?? null });
      if (vc.stock > 0) {
        await tx.insert(inventoryAdjustments).values({
          id: newId(IdPrefix.InventoryAdjustment),
          variantId: vid,
          delta: vc.stock,
          newStock: vc.stock,
          reason: 'csv_import',
          actorKind: 'retailer',
          actorId: input.auth.sub,
        });
      }
    }

    for (const p of plan) {
      if (p.action !== 'stock_update' || !p.stockUpdate) continue;
      const u = p.stockUpdate;
      const patch: Record<string, unknown> = {};
      const priceChanged =
        u.newPricePaise !== undefined && u.newPricePaise !== u.currentPricePaise;
      if (u.delta !== 0) patch.stock = u.newStock;
      if (priceChanged) patch.pricePaise = u.newPricePaise;
      if (Object.keys(patch).length > 0) {
        await tx.update(variants).set(patch).where(eq(variants.id, u.variantId));
      }
      if (u.delta !== 0) {
        await tx.insert(inventoryAdjustments).values({
          id: newId(IdPrefix.InventoryAdjustment),
          variantId: u.variantId,
          delta: u.delta,
          newStock: u.newStock,
          reason: 'csv_import',
          actorKind: 'retailer',
          actorId: input.auth.sub,
        });
      }
      if (priceChanged) {
        priceUpdates++;
        const owned = ownedVariants.find((v) => v.id === u.variantId);
        await tx.insert(listingAuditEntries).values({
          id: newId('lae'),
          listingId: owned?.listingId ?? '',
          action: 'variant.edit',
          actorKind: 'retailer',
          actorId: input.auth.sub,
          before: { pricePaise: u.currentPricePaise },
          after: { pricePaise: u.newPricePaise },
          note: `variant=${u.variantId} via CSV import row ${p.row}`,
        });
      }
      updatedVariants.push({ row: p.row, variantId: u.variantId, delta: u.delta, priceChanged });
    }
  });

  return ok({
    dryRun: false,
    applied: {
      stockUpdates: summary.stockUpdates,
      variantCreates: summary.variantCreates,
      listingCreates: summary.listingCreates,
      priceUpdates,
    },
    createdListings,
    createdVariants,
    updatedVariants,
    appliedTotal: summary.stockUpdates + summary.variantCreates + summary.listingCreates,
  });
}

export async function downloadTemplate(input: { reply: FastifyReply }) {
  const examples = [
    ['EXAMPLE-SKU-1', 'Linen Shirt (example)', 'M / White', 'Size=M|Color=White', '', '', '', '149900', '12', '0', ''],
    ['EXAMPLE-SKU-2', 'Linen Shirt (example)', 'M / Black', 'Size=M|Color=Black', '', '', '', '149900', '5', '0', ''],
    ['', 'Cotton Tee (example)', 'M / Black', 'Size=M|Color=Black', 'acme', 't-shirts', 'unisex', '89900', '8', '0', ''],
  ];
  const csv =
    '﻿' +
    [INVENTORY_CSV_HEADER.join(','), ...examples.map((row) => row.map(csvCell).join(','))].join('\n');
  void input.reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="inventory-template.csv"`)
    .send(csv);
  return input.reply;
}

export async function bestSellers(input: { auth: Auth; query: z.infer<typeof BestSellersQuery> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const since = new Date(Date.now() - input.query.days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      variantId: orderItems.variantId,
      listingName: productListings.name,
      attributesLabel: variants.attributesLabel,
      sku: variants.sku,
      stock: variants.stock,
      unitsSold: sql<number>`cast(sum(${orderItems.qty}) as int)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(variants, eq(orderItems.variantId, variants.id))
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(
      and(eq(orders.storeId, store.id), eq(orders.status, 'delivered'), gte(orders.deliveredAt, since)),
    )
    .groupBy(
      orderItems.variantId,
      productListings.name,
      variants.attributesLabel,
      variants.sku,
      variants.stock,
    )
    .orderBy(desc(sql`sum(${orderItems.qty})`))
    .limit(input.query.limit);

  return ok(rows);
}
