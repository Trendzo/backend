/**
 * Admin variants: create, bulk create, bulk deactivate.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { productListings, retailerAccounts, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify, notifySummaryToStoreOwners } from '@/shared/notify.js';
import { resolveGroupId } from '@/shared/variant-groups.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkCreateBody,
  BulkDeactivateBody,
  CreateVariantBody,
} from './store-variants.validators.js';

type Auth = AccessTokenPayload;

async function notifyOwners(
  storeId: string,
  payload: { title: string; body?: string; deepLink?: string },
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
      }),
    ),
  );
}

export async function createVariant(input: {
  auth: Auth;
  storeId: string;
  listingId: string;
  body: z.infer<typeof CreateVariantBody>;
  requestId: string;
}) {
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, input.listingId),
      eq(productListings.storeId, input.storeId),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  const gallery = new Set(listing.galleryUrls);
  const stray = input.body.imageUrls.filter((u) => !gallery.has(u));
  if (stray.length > 0) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Variant image not in listing gallery: ${stray[0]}`,
    );
  }
  const groupId = await resolveGroupId(db, listing, {
    groupId: input.body.groupId,
    attributes: input.body.attributes,
    createMissing: true,
  });
  const id = newId(IdPrefix.Variant);
  try {
    const [created] = await db
      .insert(variants)
      .values({
        id,
        listingId: listing.id,
        storeId: listing.storeId,
        groupId,
        attributes: input.body.attributes,
        attributesLabel: input.body.attributesLabel,
        ...(input.body.sku !== undefined && { sku: input.body.sku }),
        pricePaise: input.body.pricePaise,
        stock: input.body.stock,
        imageUrls: input.body.imageUrls,
        reserved: 0,
      })
      .returning();
    await recordAudit({
      actor: input.auth,
      action: 'variant.create',
      resourceKind: 'variant',
      resourceId: id,
      after: { attributesLabel: input.body.attributesLabel, pricePaise: input.body.pricePaise },
      impersonatedStoreId: input.storeId,
      requestId: input.requestId,
    });
    await notifyOwners(input.storeId, {
      title: 'Admin added a variant',
      body: `${listing.name} · ${input.body.attributesLabel}`,
      deepLink: `/retailer/listings/${listing.id}`,
    });
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        `SKU '${input.body.sku ?? '?'}' already exists`,
      );
    }
    throw err;
  }
}

export async function bulkCreate(input: {
  auth: Auth;
  storeId: string;
  listingId: string;
  body: z.infer<typeof BulkCreateBody>;
  requestId: string;
}) {
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, input.listingId),
      eq(productListings.storeId, input.storeId),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  const gallery = new Set(listing.galleryUrls);
  for (const v of input.body.variants) {
    const stray = v.imageUrls.filter((u) => !gallery.has(u));
    if (stray.length > 0) {
      throw new AppError(
        422,
        ErrorCode.ValidationError,
        `Variant image not in gallery: ${stray[0]}`,
      );
    }
  }
  const rows: (typeof variants.$inferInsert)[] = [];
  for (const v of input.body.variants) {
    const groupId = await resolveGroupId(db, listing, {
      groupId: v.groupId,
      attributes: v.attributes,
      createMissing: true,
    });
    rows.push({
      id: newId(IdPrefix.Variant),
      listingId: listing.id,
      storeId: listing.storeId,
      groupId,
      attributes: v.attributes,
      attributesLabel: v.attributesLabel,
      ...(v.sku !== undefined && { sku: v.sku }),
      pricePaise: v.pricePaise,
      stock: v.stock,
      imageUrls: v.imageUrls,
      reserved: 0,
    });
  }
  try {
    const created = await db.insert(variants).values(rows).returning();
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action: 'added variants on',
      count: created.length,
      deepLink: `/retailer/listings/${listing.id}`,
      sampleIds: created.map((c) => c.id),
    });
    for (const c of created) {
      await recordAudit({
        actor: input.auth,
        action: 'variant.create',
        resourceKind: 'variant',
        resourceId: c.id,
        after: { attributesLabel: c.attributesLabel },
        impersonatedStoreId: input.storeId,
        requestId: input.requestId,
      });
    }
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        'One or more SKUs already exist on this listing',
      );
    }
    throw err;
  }
}

export async function bulkDeactivate(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkDeactivateBody>;
  requestId: string;
}) {
  const found = await db
    .select({ id: variants.id, isActive: variants.isActive })
    .from(variants)
    .innerJoin(productListings, eq(variants.listingId, productListings.id))
    .where(
      and(
        inArray(variants.id, input.body.variantIds),
        eq(productListings.storeId, input.storeId),
      ),
    );
  const ownedIds = new Set(found.filter((v) => v.isActive).map((v) => v.id));
  if (ownedIds.size === 0) return ok({ updated: 0, skipped: input.body.variantIds.length });
  await db
    .update(variants)
    .set({ isActive: false })
    .where(inArray(variants.id, Array.from(ownedIds)));
  for (const vid of ownedIds) {
    await recordAudit({
      actor: input.auth,
      action: 'variant.deactivate',
      resourceKind: 'variant',
      resourceId: vid,
      impersonatedStoreId: input.storeId,
      requestId: input.requestId,
    });
  }
  await notifySummaryToStoreOwners({
    storeId: input.storeId,
    action: 'deactivated variants',
    count: ownedIds.size,
    sampleIds: Array.from(ownedIds),
  });
  return ok({
    updated: ownedIds.size,
    skipped: input.body.variantIds.length - ownedIds.size,
  });
}
