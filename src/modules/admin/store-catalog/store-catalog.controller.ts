/**
 * Admin store-catalog (per-store read + light edit) — listings/variants/inventory/orders.
 */
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  inventoryAdjustments,
  inventoryReservations,
  orders,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  InventoryAdjustBody,
  InventoryListQuery,
  ListListingsQuery,
  OrdersListQuery,
  PatchListingBody,
  PatchVariantBody,
  ReservationsQuery,
} from './store-catalog.validators.js';

type Auth = AccessTokenPayload;

async function loadStoreOr404(storeId: string) {
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

async function notifyOwners(
  storeId: string,
  payload: { title: string; body?: string; deepLink?: string; data?: Record<string, unknown> },
): Promise<void> {
  const owners = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, storeId),
  });
  await Promise.all(
    owners.map((o) =>
      notify({
        recipientKind: 'retailer',
        recipientId: o.id,
        kind: 'system',
        title: payload.title,
        body: payload.body ?? null,
        deepLink: payload.deepLink ?? null,
        payload: payload.data ?? null,
      }),
    ),
  );
}

export async function listListings(input: {
  storeId: string;
  query: z.infer<typeof ListListingsQuery>;
}) {
  await loadStoreOr404(input.storeId);
  const conditions = [eq(productListings.storeId, input.storeId)];
  if (input.query.status) conditions.push(eq(productListings.status, input.query.status));
  const rows = await db.query.productListings.findMany({
    where: and(...conditions),
    orderBy: desc(productListings.createdAt),
    with: {
      brand: { columns: { name: true } },
      category: { columns: { label: true } },
      variants: {
        columns: {
          id: true,
          sku: true,
          attributesLabel: true,
          stock: true,
          pricePaise: true,
          isActive: true,
        },
      },
    },
  });
  return ok(rows);
}

export async function getListing(input: { storeId: string; listingId: string }) {
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, input.listingId),
      eq(productListings.storeId, input.storeId),
    ),
    with: {
      variants: true,
      variantGroups: { orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)] },
      brand: true,
      category: true,
    },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  return ok(listing);
}

export async function patchListing(input: {
  auth: Auth;
  storeId: string;
  listingId: string;
  body: z.infer<typeof PatchListingBody>;
  requestId: string;
}) {
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, input.listingId),
      eq(productListings.storeId, input.storeId),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  const [updated] = await db
    .update(productListings)
    .set(compact(input.body))
    .where(eq(productListings.id, listing.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'listing.update',
    resourceKind: 'product_listing',
    resourceId: listing.id,
    before: { name: listing.name, status: listing.status },
    after: compact(input.body) as Record<string, unknown>,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Listing updated by admin',
    body: `"${listing.name}" was edited by ClosetX admin.`,
    deepLink: `/retailer/listings/${listing.id}`,
    data: { listingId: listing.id },
  });
  return ok(updated);
}

export async function patchVariant(input: {
  auth: Auth;
  storeId: string;
  variantId: string;
  body: z.infer<typeof PatchVariantBody>;
  requestId: string;
}) {
  const variant = await db.query.variants.findFirst({
    where: eq(variants.id, input.variantId),
    with: { listing: { columns: { storeId: true, name: true } } },
  });
  if (!variant || variant.listing.storeId !== input.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant not found in this store');
  }
  const [updated] = await db
    .update(variants)
    .set(compact(input.body))
    .where(eq(variants.id, variant.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'variant.update',
    resourceKind: 'variant',
    resourceId: variant.id,
    before: { sku: variant.sku, pricePaise: variant.pricePaise, isActive: variant.isActive },
    after: compact(input.body) as Record<string, unknown>,
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Variant updated by admin',
    body: `Variant on "${variant.listing.name}" updated.`,
    deepLink: `/retailer/listings/${variant.listingId}`,
  });
  return ok(updated);
}

export async function listInventory(input: {
  storeId: string;
  query: z.infer<typeof InventoryListQuery>;
}) {
  const store = await loadStoreOr404(input.storeId);
  const conditions = [eq(productListings.storeId, input.storeId)];
  if (input.query.status) conditions.push(eq(productListings.status, input.query.status));
  if (input.query.categoryId) conditions.push(eq(productListings.categoryId, input.query.categoryId));
  if (input.query.q) {
    const term = `%${input.query.q}%`;
    conditions.push(or(ilike(productListings.name, term), ilike(variants.sku, term))!);
  }

  const all = await db
    .select({
      id: variants.id,
      listingId: productListings.id,
      listingName: productListings.name,
      listingStatus: productListings.status,
      categoryId: productListings.categoryId,
      brandName: brands.name,
      sku: variants.sku,
      attributesLabel: variants.attributesLabel,
      pricePaise: variants.pricePaise,
      stock: variants.stock,
      reserved: variants.reserved,
      isActive: variants.isActive,
    })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .leftJoin(brands, eq(productListings.brandId, brands.id))
    .where(and(...conditions))
    .orderBy(productListings.name, variants.attributesLabel);

  const flag = input.query.flag;
  const lst = store.lowStockThreshold;
  const filtered =
    flag === 'out'
      ? all.filter((r) => r.stock === 0)
      : flag === 'oversold'
        ? all.filter((r) => r.stock - r.reserved < 0)
        : flag === 'low'
          ? all.filter((r) => r.stock > 0 && r.stock <= lst)
          : flag === 'in_stock'
            ? all.filter((r) => r.stock - r.reserved > 0)
            : all;

  const total = filtered.length;
  const start = (input.query.page - 1) * input.query.pageSize;
  const rows = filtered.slice(start, start + input.query.pageSize);
  return ok({
    rows,
    total,
    page: input.query.page,
    pageSize: input.query.pageSize,
    lowStockThreshold: lst,
  });
}

export async function listReservations(input: {
  storeId: string;
  variantId: string;
  query: z.infer<typeof ReservationsQuery>;
}) {
  const variant = await db.query.variants.findFirst({
    where: eq(variants.id, input.variantId),
    with: { listing: { columns: { storeId: true } } },
  });
  if (!variant || variant.listing.storeId !== input.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant not in store');
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
      and(
        eq(inventoryReservations.variantId, variant.id),
        isNull(inventoryReservations.releasedAt),
      ),
    )
    .orderBy(desc(inventoryReservations.reservedAt))
    .limit(input.query.limit);
  return ok(rows);
}

export async function inventoryAdjust(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof InventoryAdjustBody>;
  requestId: string;
}) {
  const variant = await db.query.variants.findFirst({
    where: eq(variants.id, input.body.variantId),
    with: { listing: { columns: { storeId: true, name: true } } },
  });
  if (!variant || variant.listing.storeId !== input.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant not in store');
  }
  const nextStock = variant.stock + input.body.delta;
  if (nextStock < variant.reserved) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Adjustment would drop stock below reservation (${variant.reserved}).`,
    );
  }
  await db.transaction(async (tx) => {
    await tx.update(variants).set({ stock: nextStock }).where(eq(variants.id, variant.id));
    await tx.insert(inventoryAdjustments).values({
      id: newId(IdPrefix.InventoryAdjustment),
      variantId: variant.id,
      delta: input.body.delta,
      newStock: nextStock,
      reason: 'audit_correction',
      actorKind: 'admin',
      actorId: input.auth.sub,
      note: input.body.note ?? `Admin adjustment (${input.auth.sub})`,
    });
  });
  await recordAudit({
    actor: input.auth,
    action: 'inventory.adjust',
    resourceKind: 'variant',
    resourceId: variant.id,
    before: { stock: variant.stock },
    after: { stock: nextStock },
    impersonatedStoreId: input.storeId,
    note: input.body.note ?? null,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Inventory adjusted by admin',
    body: `Stock on "${variant.listing.name}" / ${variant.attributesLabel} changed by ${input.body.delta}.`,
    deepLink: '/retailer/inventory',
  });
  return ok({ variantId: variant.id, stock: nextStock });
}

export async function listOrders(input: { storeId: string; query: z.infer<typeof OrdersListQuery> }) {
  await loadStoreOr404(input.storeId);
  const conditions = [eq(orders.storeId, input.storeId)];
  if (input.query.status) {
    conditions.push(eq(orders.status, input.query.status as never));
  }
  const rows = await db.query.orders.findMany({
    where: and(...conditions),
    orderBy: desc(orders.placedAt),
    limit: 200,
  });
  return ok(rows);
}

export async function getOrder(input: { storeId: string; orderId: string }) {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, input.orderId), eq(orders.storeId, input.storeId)),
    with: { items: true },
  });
  if (!order) throw new AppError(404, ErrorCode.NotFound, 'Order not found');
  return ok(order);
}
