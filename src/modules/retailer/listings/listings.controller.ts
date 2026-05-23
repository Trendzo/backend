/**
 * Retailer listings + variants CRUD, bulk-status, audit, effective-pricing.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  attributeTemplates,
  brands,
  cartEvents,
  categories,
  inventoryAdjustments,
  listingAuditEntries,
  listingViews,
  orderItems,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import { previewListingEffectivePricing } from '@/shared/discounts/preview-effective-price.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkCreateVariantsBody,
  BulkStatusBody,
  CreateListingBody,
  CreateVariantBody,
  ListQuery,
  PatchListingBody,
  PatchVariantBody,
} from './listings.validators.js';

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

function attributesKey(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

function assertSubsetOfGallery(picked: string[], gallery: string[]): void {
  const allowed = new Set(gallery);
  const stray = picked.filter((u) => !allowed.has(u));
  if (stray.length > 0) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Variant images must come from the listing gallery — unknown URL: ${stray[0]!}`,
    );
  }
}

function assertCanPublish(retailerStatus: string, storeStatus: string): void {
  if (retailerStatus !== 'active') {
    throw new AppError(
      403,
      ErrorCode.RetailerNotApproved,
      'Your retailer account is not approved yet — wait for admin approval',
    );
  }
  if (storeStatus !== 'active' && storeStatus !== 'onboarding') {
    throw new AppError(
      403,
      ErrorCode.StoreNotActive,
      `Your store is ${storeStatus}, must be active or onboarding to manage products`,
    );
  }
}

export async function createListing(input: {
  auth: Auth;
  body: z.infer<typeof CreateListingBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  assertCanPublish(retailer.status, store.status);

  const body = input.body;
  const [brand, category] = await Promise.all([
    db.query.brands.findFirst({ where: eq(brands.id, body.brandId) }),
    db.query.categories.findFirst({ where: eq(categories.id, body.categoryId) }),
  ]);
  if (!brand) throw new AppError(404, ErrorCode.NotFound, `Brand ${body.brandId} not found`);
  if (!category) throw new AppError(404, ErrorCode.NotFound, `Category ${body.categoryId} not found`);
  if (body.templateId) {
    const tpl = await db.query.attributeTemplates.findFirst({
      where: eq(attributeTemplates.id, body.templateId),
    });
    if (!tpl) throw new AppError(404, ErrorCode.NotFound, `Template ${body.templateId} not found`);
  }

  const id = newId(IdPrefix.Listing);
  const [created] = await db
    .insert(productListings)
    .values({
      id,
      storeId: store.id,
      brandId: body.brandId,
      categoryId: body.categoryId,
      name: body.name,
      ...(body.description !== undefined && { description: body.description }),
      ...(body.hsn !== undefined && { hsn: body.hsn }),
      ...(body.templateId !== undefined && { templateId: body.templateId }),
      gender: body.gender,
      badge: body.badge,
      listingPolicy: body.listingPolicy,
      galleryUrls: body.galleryUrls,
      occasion: body.occasion,
      ...(body.ageGroup !== undefined && body.ageGroup !== null && { ageGroup: body.ageGroup }),
      status: 'draft',
    })
    .returning();
  if (!created) throw AppError.internal('listing insert returned no row');
  return ok(created);
}

export async function listListings(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const where = input.query.status
    ? and(eq(productListings.storeId, store.id), eq(productListings.status, input.query.status))
    : eq(productListings.storeId, store.id);

  const rows = await db.query.productListings.findMany({
    where,
    with: { variants: true, brand: true, category: true },
    orderBy:
      input.query.sort === 'name_asc'
        ? (t, { asc }) => [asc(t.name)]
        : (t, { desc }) => [desc(t.createdAt)],
  });

  const downIds = rows.filter((r) => r.status === 'taken_down').map((r) => r.id);
  const reasons = new Map<string, string | null>();
  if (downIds.length > 0) {
    const audits = await db.query.listingAuditEntries.findMany({
      where: and(
        inArray(listingAuditEntries.listingId, downIds),
        eq(listingAuditEntries.action, 'takedown'),
      ),
      orderBy: (t, { desc }) => [desc(t.at)],
    });
    const seen = new Set<string>();
    for (const a of audits) {
      if (!seen.has(a.listingId)) {
        reasons.set(a.listingId, a.note);
        seen.add(a.listingId);
      }
    }
  }
  const enriched = rows.map((r) =>
    r.status === 'taken_down' ? { ...r, takedownReason: reasons.get(r.id) ?? null } : r,
  );
  return ok(enriched);
}

export async function patchListing(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchListingBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const existing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.id),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (existing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  const body = input.body;

  if (body.brandId) {
    const brand = await db.query.brands.findFirst({ where: eq(brands.id, body.brandId) });
    if (!brand) throw new AppError(404, ErrorCode.NotFound, `Brand ${body.brandId} not found`);
  }
  if (body.categoryId) {
    const cat = await db.query.categories.findFirst({
      where: eq(categories.id, body.categoryId),
    });
    if (!cat) throw new AppError(404, ErrorCode.NotFound, `Category ${body.categoryId} not found`);
  }
  if (body.templateId) {
    const tpl = await db.query.attributeTemplates.findFirst({
      where: eq(attributeTemplates.id, body.templateId),
    });
    if (!tpl) throw new AppError(404, ErrorCode.NotFound, `Template ${body.templateId} not found`);
  }

  if (
    body.listingPolicy !== undefined &&
    body.listingPolicy !== existing.listingPolicy &&
    store.delegationModeEnabled
  ) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Listing policy is controlled by platform delegation settings — turn off delegation to set it per-listing',
    );
  }

  if (body.templateId !== undefined && body.templateId !== existing.templateId) {
    const variantCount = await db.$count(variants, eq(variants.listingId, existing.id));
    if (variantCount > 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot change attribute template after variants have been added — delete or deactivate all variants first',
      );
    }
  }

  if (body.status === 'active') {
    assertCanPublish(retailer.status, store.status);

    const effectiveGallery = body.galleryUrls ?? existing.galleryUrls;
    const variantCount = await db.$count(variants, eq(variants.listingId, existing.id));
    const missing: string[] = [];
    if (variantCount < 1) missing.push('at least one variant (size/colour with price and stock)');
    if (effectiveGallery.length < 1) missing.push('at least one gallery image');
    if (missing.length > 0) {
      throw new AppError(
        409,
        ErrorCode.CannotPublishIncomplete,
        `Cannot publish — needs ${missing.join(' and ')}.`,
      );
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(productListings)
      .set({ ...compact(body), updatedAt: new Date() })
      .where(eq(productListings.id, existing.id))
      .returning();
    if (body.galleryUrls !== undefined) {
      const allowed = new Set(body.galleryUrls);
      const childVariants = await tx.query.variants.findMany({
        where: eq(variants.listingId, existing.id),
      });
      for (const v of childVariants) {
        const pruned = v.imageUrls.filter((u) => allowed.has(u));
        if (pruned.length !== v.imageUrls.length) {
          await tx.update(variants).set({ imageUrls: pruned }).where(eq(variants.id, v.id));
        }
      }
    }
    if (body.status === 'active' && existing.status !== 'active') {
      await tx.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: existing.id,
        action: 'publish',
        actorKind: 'retailer',
        actorId: input.auth.sub,
      });
      if (store.status === 'onboarding') {
        await tx
          .update(retailerStores)
          .set({ status: 'active' })
          .where(eq(retailerStores.id, store.id));
      }
    } else if (body.status === 'draft' && existing.status === 'active') {
      await tx.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: existing.id,
        action: 'unpublish',
        actorKind: 'retailer',
        actorId: input.auth.sub,
      });
    }
    return row;
  });
  return ok(updated);
}

export async function deleteListing(input: { auth: Auth; id: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const existing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.id),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (existing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }
  if (existing.status !== 'draft') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only draft listings can be deleted');
  }
  await db.delete(productListings).where(eq(productListings.id, existing.id));
  return ok({ id: existing.id, deleted: true });
}

export async function createVariant(input: {
  auth: Auth;
  listingId: string;
  body: z.infer<typeof CreateVariantBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.listingId),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  assertSubsetOfGallery(input.body.imageUrls, listing.galleryUrls);

  const newKey = attributesKey(input.body.attributes);
  const existingForCombo = await db.query.variants.findMany({
    where: eq(variants.listingId, listing.id),
    columns: { attributes: true },
  });
  if (
    existingForCombo.some(
      (v) => attributesKey(v.attributes as Record<string, string>) === newKey,
    )
  ) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A variant with attributes '${input.body.attributesLabel}' already exists on this listing`,
    );
  }

  const id = newId(IdPrefix.Variant);
  try {
    const [created] = await db
      .insert(variants)
      .values({
        id,
        listingId: listing.id,
        attributes: input.body.attributes,
        attributesLabel: input.body.attributesLabel,
        ...(input.body.sku !== undefined && { sku: input.body.sku }),
        pricePaise: input.body.pricePaise,
        stock: input.body.stock,
        imageUrls: input.body.imageUrls,
        reserved: 0,
      })
      .returning();
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        `SKU '${input.body.sku ?? '?'}' already exists on this listing`,
      );
    }
    throw err;
  }
}

export async function bulkCreateVariants(input: {
  auth: Auth;
  listingId: string;
  body: z.infer<typeof BulkCreateVariantsBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.listingId),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  for (const v of input.body.variants) {
    assertSubsetOfGallery(v.imageUrls, listing.galleryUrls);
  }

  const existingForBulk = await db.query.variants.findMany({
    where: eq(variants.listingId, listing.id),
    columns: { attributes: true },
  });
  const existingKeys = new Set(
    existingForBulk.map((v) => attributesKey(v.attributes as Record<string, string>)),
  );
  const seenInBatch = new Set<string>();
  for (const v of input.body.variants) {
    const key = attributesKey(v.attributes);
    if (existingKeys.has(key)) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Variant '${v.attributesLabel}' duplicates an existing variant on this listing`,
      );
    }
    if (seenInBatch.has(key)) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Variant '${v.attributesLabel}' appears more than once in this batch`,
      );
    }
    seenInBatch.add(key);
  }

  const rows = input.body.variants.map((v) => ({
    id: newId(IdPrefix.Variant),
    listingId: listing.id,
    attributes: v.attributes,
    attributesLabel: v.attributesLabel,
    ...(v.sku !== undefined && { sku: v.sku }),
    pricePaise: v.pricePaise,
    stock: v.stock,
    imageUrls: v.imageUrls,
    reserved: 0,
  }));

  try {
    const created = await db.insert(variants).values(rows).returning();
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(409, ErrorCode.SkuTaken, 'One or more SKUs already exist on this listing');
    }
    throw err;
  }
}

export async function listVariants(input: { auth: Auth; listingId: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.listingId),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  const rows = await db.query.variants.findMany({ where: eq(variants.listingId, listing.id) });
  return ok(rows);
}

export async function getEffectivePricing(input: { auth: Auth; listingId: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.listingId),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  const rows = await previewListingEffectivePricing(db, store.id, listing.id);
  return ok(rows);
}

export async function patchVariant(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchVariantBody>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const existing = await db.query.variants.findFirst({
    where: eq(variants.id, input.id),
    with: { listing: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  if (existing.listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant');
  }

  if (input.body.stock !== undefined && input.body.stock < existing.reserved) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot set stock below currently reserved (${existing.reserved})`,
    );
  }
  if (input.body.imageUrls !== undefined) {
    assertSubsetOfGallery(input.body.imageUrls, existing.listing.galleryUrls);
  }

  try {
    const [updated] = await db
      .update(variants)
      .set(compact(input.body))
      .where(eq(variants.id, existing.id))
      .returning();
    if (input.body.stock !== undefined) {
      await db.insert(inventoryAdjustments).values({
        id: newId(IdPrefix.InventoryAdjustment),
        variantId: existing.id,
        delta: input.body.stock - existing.stock,
        newStock: input.body.stock,
        reason: 'manual_edit',
        actorKind: 'retailer',
        actorId: input.auth.sub,
      });
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (input.body.pricePaise !== undefined && input.body.pricePaise !== existing.pricePaise) {
      before.pricePaise = existing.pricePaise;
      after.pricePaise = input.body.pricePaise;
    }
    if (input.body.sku !== undefined && input.body.sku !== existing.sku) {
      before.sku = existing.sku;
      after.sku = input.body.sku;
    }
    if (input.body.isActive !== undefined && input.body.isActive !== existing.isActive) {
      before.isActive = existing.isActive;
      after.isActive = input.body.isActive;
    }
    if (Object.keys(after).length > 0) {
      await db.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: existing.listingId,
        action: 'variant.edit',
        actorKind: 'retailer',
        actorId: input.auth.sub,
        before,
        after,
        note: `variant=${existing.id}`,
      });
    }
    return ok(updated);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        `SKU '${input.body.sku ?? '?'}' already exists on this listing`,
      );
    }
    throw err;
  }
}

export async function deleteVariant(input: { auth: Auth; id: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const existing = await db.query.variants.findFirst({
    where: eq(variants.id, input.id),
    with: { listing: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  if (existing.listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant');
  }
  if (existing.reserved > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot delete: ${existing.reserved} unit(s) reserved by open orders. Deactivate instead.`,
    );
  }
  const linked = await db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.variantId, existing.id))
    .limit(1);
  if (linked.length > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Cannot delete: variant has order history. Deactivate instead to keep records intact.',
    );
  }

  await db.transaction(async (tx) => {
    // Clean dependent rows that have no historical value (events + inventory log).
    await tx.delete(cartEvents).where(eq(cartEvents.variantId, existing.id));
    await tx.delete(listingViews).where(eq(listingViews.variantId, existing.id));
    await tx.delete(inventoryAdjustments).where(eq(inventoryAdjustments.variantId, existing.id));
    await tx.delete(variants).where(eq(variants.id, existing.id));
    await tx.insert(listingAuditEntries).values({
      id: newId('lae'),
      listingId: existing.listingId,
      action: 'variant.delete',
      actorKind: 'retailer',
      actorId: input.auth.sub,
      before: {
        id: existing.id,
        sku: existing.sku,
        attributesLabel: existing.attributesLabel,
        pricePaise: existing.pricePaise,
        stock: existing.stock,
      },
      after: null,
      note: `variant=${existing.id}`,
    });
  });
  return ok({ id: existing.id, deleted: true });
}

export async function bulkStatus(input: { auth: Auth; body: z.infer<typeof BulkStatusBody> }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  assertCanPublish(retailer.status, store.status);

  let updated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const id of input.body.ids) {
      const listing = await tx.query.productListings.findFirst({
        where: and(eq(productListings.id, id), eq(productListings.storeId, store.id)),
      });
      if (!listing) {
        skipped++;
        continue;
      }

      if (input.body.status === 'active') {
        const gallery = listing.galleryUrls ?? [];
        const variantCount = await tx.$count(variants, eq(variants.listingId, id));
        if (variantCount < 1 || gallery.length < 1) {
          skipped++;
          continue;
        }
      }

      await tx
        .update(productListings)
        .set({ status: input.body.status })
        .where(eq(productListings.id, id));
      updated++;
    }
    if (input.body.status === 'active' && updated > 0 && store.status === 'onboarding') {
      await tx
        .update(retailerStores)
        .set({ status: 'active' })
        .where(eq(retailerStores.id, store.id));
    }
  });

  return ok({ updated, skipped });
}

/**
 * Recent price changes across every listing owned by the caller's store.
 * Filters `listing_audit_entries` to action='variant.edit' rows whose before/after
 * carry a `pricePaise` field (other variant edits — SKU, isActive — are skipped).
 */
export async function recentPriceChanges(input: { auth: Auth }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const listingRows = await db
    .select({ id: productListings.id })
    .from(productListings)
    .where(eq(productListings.storeId, store.id));
  const listingIds = listingRows.map((r) => r.id);
  if (listingIds.length === 0) return ok([]);

  const rows = await db.query.listingAuditEntries.findMany({
    where: and(
      inArray(listingAuditEntries.listingId, listingIds),
      eq(listingAuditEntries.action, 'variant.edit'),
    ),
    orderBy: (t, { desc }) => [desc(t.at)],
    limit: 50,
  });
  const filtered = rows
    .filter((r) => {
      const before = r.before as Record<string, unknown> | null;
      const after = r.after as Record<string, unknown> | null;
      return before && after && 'pricePaise' in before && 'pricePaise' in after;
    })
    .map((r) => {
      const before = r.before as { pricePaise: number };
      const after = r.after as { pricePaise: number };
      // note is "variant=<id>"
      const variantId = r.note?.startsWith('variant=') ? r.note.slice('variant='.length) : null;
      return {
        id: r.id,
        listingId: r.listingId,
        variantId,
        beforePaise: before.pricePaise,
        afterPaise: after.pricePaise,
        actorKind: r.actorKind,
        actorId: r.actorId,
        at: r.at.toISOString(),
      };
    });
  return ok(filtered);
}

export async function listingAudit(input: { auth: Auth; id: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const listing = await db.query.productListings.findFirst({
    where: and(eq(productListings.id, input.id), eq(productListings.storeId, store.id)),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

  const rows = await db.query.listingAuditEntries.findMany({
    where: eq(listingAuditEntries.listingId, listing.id),
    orderBy: (t, { desc }) => [desc(t.at)],
  });
  return ok(rows);
}
