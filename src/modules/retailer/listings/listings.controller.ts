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
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import { LONG_DESC_MAX_BYTES, sanitizeRichText } from '@/shared/sanitize/rich-text.js';
import { previewListingEffectivePricing } from '@/shared/discounts/preview-effective-price.js';
import { generateSku } from '@/shared/sku.js';
import {
  assertGroupDeletable,
  defaultVariantIdentity,
  deriveVariantIdentity,
  getOrCreateDefaultGroup,
  insertDefaultGroup,
  resolveGroupId,
} from '@/shared/variant-groups.js';
import { bumpTemplateUsage } from '@/modules/retailer/catalog/catalog.controller.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkCreateGroupVariantsBody,
  BulkCreateVariantsBody,
  BulkStatusBody,
  CreateGroupBody,
  CreateGroupVariantBody,
  CreateListingBody,
  CreateVariantBody,
  DefaultVariantBody,
  ListQuery,
  PatchGroupBody,
  PatchListingBody,
  PatchVariantBody,
  SkuAvailableQuery,
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

/** Max images in a listing gallery (variant images auto-append into this union). */
const GALLERY_MAX = 20;

/**
 * Variant images live in the listing gallery (single source of truth). Any
 * variant image not yet in the gallery is appended; throws if that would exceed
 * the cap. Returns the new gallery (unchanged reference semantics not relied on).
 */
function mergeIntoGallery(gallery: string[], variantImages: string[]): string[] {
  const merged = [...gallery];
  const seen = new Set(gallery);
  for (const u of variantImages) {
    if (!seen.has(u)) {
      merged.push(u);
      seen.add(u);
    }
  }
  if (merged.length > GALLERY_MAX) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Too many images — a product gallery holds at most ${GALLERY_MAX}`,
    );
  }
  return merged;
}

/** Store-wide SKU existence check (optionally excluding one variant id). */
async function skuExistsInStore(
  storeId: string,
  sku: string,
  excludeVariantId?: string,
): Promise<boolean> {
  const rows = await db.query.variants.findMany({
    where: and(eq(variants.storeId, storeId), eq(variants.sku, sku)),
    columns: { id: true },
  });
  return rows.some((r) => r.id !== excludeVariantId);
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

/**
 * A variant is publishable when it carries everything a shopper needs: a price,
 * a SKU, a stock figure, and at least one image (its own, or it inherits the
 * listing cover). Mirrored client-side in the wizard.
 */
function isVariantComplete(
  v: { pricePaise: number; sku: string | null; stock: number; imageUrls: string[] },
  galleryLength: number,
): boolean {
  return (
    v.pricePaise > 0 &&
    !!v.sku &&
    v.stock !== null &&
    v.stock !== undefined &&
    (v.imageUrls.length > 0 || galleryLength > 0)
  );
}

function assertVariantComplete(
  v: { pricePaise: number; sku: string | null; stock: number; imageUrls: string[] },
  galleryLength: number,
): void {
  const missing: string[] = [];
  if (!(v.pricePaise > 0)) missing.push('a price');
  if (!v.sku) missing.push('a SKU');
  if (v.stock === null || v.stock === undefined) missing.push('a stock figure');
  if (v.imageUrls.length === 0 && galleryLength === 0) missing.push('an image');
  if (missing.length > 0) {
    throw new AppError(
      409,
      ErrorCode.CannotPublishIncomplete,
      `Cannot publish this variant — needs ${missing.join(', ')}.`,
    );
  }
}

type ListingPublishFields = {
  name: string;
  description: string | null;
  descriptionLong: string | null;
  galleryUrls: string[];
  listingPolicy: string | null;
};

/**
 * A listing can go live only when its required fields are filled AND it has at
 * least one complete, active variant. Throws CannotPublishIncomplete listing
 * exactly what's missing.
 */
function assertListingPublishable(
  l: ListingPublishFields,
  variantRows: { pricePaise: number; sku: string | null; stock: number; imageUrls: string[]; isActive: boolean }[],
): void {
  const missing: string[] = [];
  if (!l.name?.trim()) missing.push('a product name');
  if (!l.description?.trim()) missing.push('a short description');
  if (!l.descriptionLong?.trim()) missing.push('a full description');
  if (l.galleryUrls.length < 1) missing.push('at least one image');
  if (!l.listingPolicy) missing.push('a return policy');
  const hasLive = variantRows.some(
    (v) => v.isActive && isVariantComplete(v, l.galleryUrls.length),
  );
  if (!hasLive) missing.push('at least one complete, active variant (price, SKU, stock, image)');
  if (missing.length > 0) {
    throw new AppError(
      409,
      ErrorCode.CannotPublishIncomplete,
      `Cannot publish — needs ${missing.join(', ')}.`,
    );
  }
}

/**
 * Variant rows for the publishable check, with EFFECTIVE activity: a variant
 * counts as live only when both it and its parent group are active.
 */
async function loadVariantPublishRows(listingId: string) {
  const rows = await db.query.variants.findMany({
    where: eq(variants.listingId, listingId),
    columns: {
      id: true,
      sku: true,
      pricePaise: true,
      stock: true,
      imageUrls: true,
      isActive: true,
    },
    with: { group: { columns: { isActive: true } } },
  });
  return rows.map((v) => ({ ...v, isActive: v.isActive && v.group.isActive }));
}

/**
 * Sanitize-on-write for the rich long description. `undefined` = field not in
 * the request (leave untouched); `null` = explicit clear; a string is run
 * through the HTML allow-list and may normalize to null when content-free.
 */
function sanitizeLongDescription(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const clean = sanitizeRichText(raw);
  if (clean !== null && Buffer.byteLength(clean, 'utf8') > LONG_DESC_MAX_BYTES) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Full description is too long (max ${Math.floor(LONG_DESC_MAX_BYTES / 1000)}KB)`,
    );
  }
  return clean;
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

  const descriptionLong = sanitizeLongDescription(body.descriptionLong);

  // A template means retailer-defined axes; the wizard's mode choice wins
  // otherwise. The two must agree — 'custom' without a template is fine (manual
  // axes), but a template on a non-custom listing is contradictory.
  const variantModeResolved = body.variantMode ?? (body.templateId ? 'custom' : 'single');
  if (body.templateId && variantModeResolved !== 'custom') {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      "A listing with an attribute template must use variantMode 'custom'",
    );
  }

  const id = newId(IdPrefix.Listing);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productListings)
      .values({
        id,
        storeId: store.id,
        brandId: body.brandId,
        categoryId: body.categoryId,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        ...(descriptionLong !== undefined && { descriptionLong }),
        ...(body.hsn !== undefined && { hsn: body.hsn }),
        ...(body.templateId !== undefined && { templateId: body.templateId }),
        gender: body.gender,
        listingPolicy: body.listingPolicy,
        galleryUrls: body.galleryUrls,
        occasion: body.occasion,
        ageGroups: body.ageGroups,
        variantMode: variantModeResolved,
        status: 'draft',
      })
      .returning();
    if (!row) throw AppError.internal('listing insert returned no row');
    // Every listing owns a default group from birth (single-product and
    // custom-template variants land there).
    await insertDefaultGroup(tx, row.id, store.id);
    return row;
  });
  if (body.templateId) await bumpTemplateUsage(body.templateId);
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
    with: {
      variants: true,
      variantGroups: { orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)] },
      brand: true,
      category: true,
    },
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

/** Single listing with variants + brand + category — the wizard's edit load. */
export async function getListing(input: { auth: Auth; id: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);

  const row = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.id),
    with: {
      variants: true,
      variantGroups: { orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.name)] },
      brand: true,
      category: true,
    },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (row.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  if (row.status === 'taken_down') {
    const lastTakedown = await db.query.listingAuditEntries.findFirst({
      where: and(
        eq(listingAuditEntries.listingId, row.id),
        eq(listingAuditEntries.action, 'takedown'),
      ),
      orderBy: (t, { desc }) => [desc(t.at)],
    });
    return ok({ ...row, takedownReason: lastTakedown?.note ?? null });
  }
  return ok(row);
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

  if (body.variantMode !== undefined && body.variantMode !== existing.variantMode) {
    const effectiveTemplateId =
      body.templateId !== undefined ? body.templateId : existing.templateId;
    if (effectiveTemplateId && body.variantMode !== 'custom') {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Detach the attribute template before changing the variant structure',
      );
    }
    if (body.variantMode === 'single') {
      // Single-product = the default group only. Named color groups must be
      // cleared first (the wizard does this in its save reconciliation).
      const namedGroups = await db.query.variantGroups.findMany({
        where: eq(variantGroups.listingId, existing.id),
        columns: { id: true, isDefault: true, name: true },
      });
      const named = namedGroups.filter((g) => !g.isDefault);
      if (named.length > 0) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot switch to a single product while color groups exist (${named
            .map((g) => g.name)
            .join(', ')}) — delete them first`,
        );
      }
    }
  }

  if (body.status === 'active') {
    assertCanPublish(retailer.status, store.status);

    // Validate against the listing as it WILL be after this patch (fields in the
    // same request may complete the requirements).
    const variantRows = await loadVariantPublishRows(existing.id);
    assertListingPublishable(
      {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        descriptionLong:
          body.descriptionLong !== undefined
            ? sanitizeLongDescription(body.descriptionLong) ?? null
            : existing.descriptionLong,
        galleryUrls: body.galleryUrls ?? existing.galleryUrls,
        listingPolicy: body.listingPolicy ?? existing.listingPolicy,
      },
      variantRows,
    );
  }

  // Sanitized-or-null replaces the raw client HTML; null survives compact()
  // so an explicit clear reaches the DB.
  const sanitizedBody = {
    ...body,
    descriptionLong: sanitizeLongDescription(body.descriptionLong),
  };

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(productListings)
      .set({ ...compact(sanitizedBody), updatedAt: new Date() })
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
  if (
    body.templateId !== undefined &&
    body.templateId !== null &&
    body.templateId !== existing.templateId
  ) {
    await bumpTemplateUsage(body.templateId);
  }
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
  // A draft can still own variants and groups (every listing owns at least its
  // default group) — clear them and their no-history dependents first.
  const childVariants = await db.query.variants.findMany({
    where: eq(variants.listingId, existing.id),
    columns: { id: true, reserved: true },
  });
  if (childVariants.some((v) => v.reserved > 0)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Cannot delete: stock is reserved by open orders.',
    );
  }
  const childIds = childVariants.map((v) => v.id);
  if (childIds.length > 0) {
    const linked = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(inArray(orderItems.variantId, childIds))
      .limit(1);
    if (linked.length > 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot delete: this product has order history. Retire it instead.',
      );
    }
  }
  await db.transaction(async (tx) => {
    if (childIds.length > 0) {
      await tx.delete(cartEvents).where(inArray(cartEvents.variantId, childIds));
      await tx.delete(listingViews).where(inArray(listingViews.variantId, childIds));
      await tx
        .delete(inventoryAdjustments)
        .where(inArray(inventoryAdjustments.variantId, childIds));
      await tx.delete(variants).where(inArray(variants.id, childIds));
    }
    await tx.delete(variantGroups).where(eq(variantGroups.listingId, existing.id));
    await tx.delete(productListings).where(eq(productListings.id, existing.id));
  });
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
    with: { brand: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

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

  // Auto-generate a store-unique SKU when the retailer left it blank.
  const sku =
    input.body.sku ??
    (await generateSku(
      { brand: listing.brand?.name ?? null, name: listing.name, attributesLabel: input.body.attributesLabel },
      (candidate) => skuExistsInStore(store.id, candidate),
    ));

  // Variant images live in the listing gallery — append any new ones (cap 20).
  const newGallery = mergeIntoGallery(listing.galleryUrls, input.body.imageUrls);

  // Explicit group, or color-attribute match, else the default group.
  const groupId = await resolveGroupId(db, listing, {
    groupId: input.body.groupId,
    attributes: input.body.attributes,
  });

  const id = newId(IdPrefix.Variant);
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(variants)
        .values({
          id,
          listingId: listing.id,
          storeId: store.id,
          groupId,
          attributes: input.body.attributes,
          attributesLabel: input.body.attributesLabel,
          sku,
          pricePaise: input.body.pricePaise,
          ...(input.body.compareAtPrice !== undefined && {
            compareAtPrice: input.body.compareAtPrice,
          }),
          stock: input.body.stock,
          imageUrls: input.body.imageUrls,
          reserved: 0,
        })
        .returning();
      if (newGallery.length !== listing.galleryUrls.length) {
        await tx
          .update(productListings)
          .set({ galleryUrls: newGallery, updatedAt: new Date() })
          .where(eq(productListings.id, listing.id));
      }
      return row;
    });
    if (listing.templateId) await bumpTemplateUsage(listing.templateId, { incrementCount: false });
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        `SKU '${sku}' already exists in your store`,
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
    with: { brand: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }

  // Append every batch image into the listing gallery union (cap 20).
  const allImages = input.body.variants.flatMap((v) => v.imageUrls);
  const newGallery = mergeIntoGallery(listing.galleryUrls, allImages);

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

  // The bulk path is the custom-template flow — everything lands in the
  // listing's default group (color-attribute routing is the single-create path).
  const defaultGroup = await getOrCreateDefaultGroup(db, listing.id, store.id);

  // Auto-generate store-unique SKUs for rows that omitted one; `allocated`
  // dedupes within the batch before any row hits the DB.
  const allocated = new Set<string>();
  const rows: (typeof variants.$inferInsert)[] = [];
  for (const v of input.body.variants) {
    const sku =
      v.sku ??
      (await generateSku(
        { brand: listing.brand?.name ?? null, name: listing.name, attributesLabel: v.attributesLabel },
        (candidate) => skuExistsInStore(store.id, candidate),
        allocated,
      ));
    rows.push({
      id: newId(IdPrefix.Variant),
      listingId: listing.id,
      storeId: store.id,
      groupId: defaultGroup.id,
      attributes: v.attributes,
      attributesLabel: v.attributesLabel,
      sku,
      pricePaise: v.pricePaise,
      ...(v.compareAtPrice !== undefined && { compareAtPrice: v.compareAtPrice }),
      stock: v.stock,
      imageUrls: v.imageUrls,
      reserved: 0,
    });
  }

  try {
    const created = await db.transaction(async (tx) => {
      const inserted = await tx.insert(variants).values(rows).returning();
      if (newGallery.length !== listing.galleryUrls.length) {
        await tx
          .update(productListings)
          .set({ galleryUrls: newGallery, updatedAt: new Date() })
          .where(eq(productListings.id, listing.id));
      }
      return inserted;
    });
    if (listing.templateId) await bumpTemplateUsage(listing.templateId, { incrementCount: false });
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(409, ErrorCode.SkuTaken, 'One or more SKUs already exist in your store');
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
    with: { listing: true, group: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  if (existing.listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant');
  }

  // Identity rules by listing mode: the system path derives attributes/label
  // from (group, size) — raw identity edits are custom-template-only, and
  // size/group moves are system-path-only.
  const isCustom = existing.listing.variantMode === 'custom';
  if (!isCustom && (input.body.attributes !== undefined || input.body.attributesLabel !== undefined)) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Attributes are system-managed on this product — change the size or color group instead',
    );
  }
  if (isCustom && (input.body.size !== undefined || input.body.groupId !== undefined)) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      'Size and group apply to system-structured products — edit attributes instead',
    );
  }

  // Re-derive identity on a size change or a move between groups.
  let derived: { attributes: Record<string, string>; attributesLabel: string } | null = null;
  let targetGroupId: string | null = null;
  if (input.body.size !== undefined || input.body.groupId !== undefined) {
    let group = existing.group;
    if (input.body.groupId !== undefined && input.body.groupId !== existing.groupId) {
      const moved = await db.query.variantGroups.findFirst({
        where: eq(variantGroups.id, input.body.groupId),
      });
      if (!moved || moved.listingId !== existing.listingId) {
        throw new AppError(404, ErrorCode.NotFound, 'Variant group not found on this listing');
      }
      group = moved;
      targetGroupId = moved.id;
    }
    const size = input.body.size ?? existing.attributes.size;
    if (!size) {
      throw new AppError(
        422,
        ErrorCode.ValidationError,
        'A size is required when moving this variant into a color group',
      );
    }
    derived = deriveVariantIdentity(group, size);

    // The new (group, size) combo must not collide with a sibling.
    const newKey = attributesKey(derived.attributes);
    const siblings = await db.query.variants.findMany({
      where: eq(variants.listingId, existing.listingId),
      columns: { id: true, attributes: true },
    });
    if (
      siblings.some(
        (v) => v.id !== existing.id && attributesKey(v.attributes) === newKey,
      )
    ) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `A variant '${derived.attributesLabel}' already exists on this product`,
      );
    }
  }

  if (input.body.stock !== undefined && input.body.stock < existing.reserved) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot set stock below currently reserved (${existing.reserved})`,
    );
  }

  // compare-at must exceed the (possibly being-changed) selling price.
  if (input.body.compareAtPrice != null) {
    const effectivePrice = input.body.pricePaise ?? existing.pricePaise;
    if (input.body.compareAtPrice <= effectivePrice) {
      throw new AppError(
        422,
        ErrorCode.ValidationError,
        'Compare-at price must be greater than the selling price',
      );
    }
  }

  // New variant images auto-append into the listing gallery (single source of truth).
  let newGallery: string[] | null = null;
  if (input.body.imageUrls !== undefined) {
    const merged = mergeIntoGallery(existing.listing.galleryUrls, input.body.imageUrls);
    if (merged.length !== existing.listing.galleryUrls.length) newGallery = merged;
  }

  try {
    const {
      size: _size,
      groupId: _groupId,
      attributes: _attrs,
      attributesLabel: _label,
      ...scalarPatch
    } = input.body;
    const [updated] = await db
      .update(variants)
      .set({
        ...compact(scalarPatch),
        ...(isCustom &&
          input.body.attributes !== undefined && { attributes: input.body.attributes }),
        ...(isCustom &&
          input.body.attributesLabel !== undefined && {
            attributesLabel: input.body.attributesLabel,
          }),
        ...(derived !== null && {
          attributes: derived.attributes,
          attributesLabel: derived.attributesLabel,
        }),
        ...(targetGroupId !== null && { groupId: targetGroupId }),
      })
      .where(eq(variants.id, existing.id))
      .returning();
    if (newGallery) {
      await db
        .update(productListings)
        .set({ galleryUrls: newGallery, updatedAt: new Date() })
        .where(eq(productListings.id, existing.listingId));
    }
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
    if (
      input.body.compareAtPrice !== undefined &&
      input.body.compareAtPrice !== existing.compareAtPrice
    ) {
      before.compareAtPrice = existing.compareAtPrice;
      after.compareAtPrice = input.body.compareAtPrice;
    }
    if (input.body.sku !== undefined && input.body.sku !== existing.sku) {
      before.sku = existing.sku;
      after.sku = input.body.sku;
    }
    if (input.body.isActive !== undefined && input.body.isActive !== existing.isActive) {
      before.isActive = existing.isActive;
      after.isActive = input.body.isActive;
    }
    if (derived !== null && derived.attributesLabel !== existing.attributesLabel) {
      before.attributesLabel = existing.attributesLabel;
      after.attributesLabel = derived.attributesLabel;
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
        `SKU '${input.body.sku ?? '?'}' already exists in your store`,
      );
    }
    throw err;
  }
}

/**
 * Publish a single variant/SKU. Sets isActive=true (only if the variant is
 * complete) and, if the parent listing isn't live yet, publishes the listing
 * too (it's now publishable thanks to this variant). Allows a retailer to take
 * one SKU live at a time.
 */
export async function publishVariant(input: { auth: Auth; listingId: string; vid: string }) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  assertCanPublish(retailer.status, store.status);

  const existing = await db.query.variants.findFirst({
    where: eq(variants.id, input.vid),
    with: { listing: true, group: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
  if (existing.listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant');
  }
  if (existing.listingId !== input.listingId) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant not found on this listing');
  }

  const listing = existing.listing;
  assertVariantComplete(existing, listing.galleryUrls.length);

  // If the listing isn't live yet, it must be publishable as a whole — but this
  // variant is about to become a complete active one, so feed that in (its
  // effective visibility still depends on the parent group's switch).
  if (listing.status !== 'active') {
    const others = await loadVariantPublishRows(listing.id);
    const projected = others.map((v) =>
      v.id === existing.id ? { ...v, isActive: existing.group.isActive } : v,
    );
    assertListingPublishable(
      {
        name: listing.name,
        description: listing.description,
        descriptionLong: listing.descriptionLong,
        galleryUrls: listing.galleryUrls,
        listingPolicy: listing.listingPolicy,
      },
      projected,
    );
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(variants)
      .set({ isActive: true })
      .where(eq(variants.id, existing.id))
      .returning();
    if (listing.status !== 'active') {
      await tx
        .update(productListings)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(productListings.id, listing.id));
      await tx.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: listing.id,
        action: 'publish',
        actorKind: 'retailer',
        actorId: input.auth.sub,
        note: `via variant=${existing.id}`,
      });
      if (store.status === 'onboarding') {
        await tx
          .update(retailerStores)
          .set({ status: 'active' })
          .where(eq(retailerStores.id, store.id));
      }
    }
    return row;
  });
  return ok(updated);
}

/** Live store-wide SKU availability check for the wizard's Step 1. */
export async function skuAvailable(input: {
  auth: Auth;
  query: z.infer<typeof SkuAvailableQuery>;
}) {
  const retailer = await loadRetailer(input.auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const taken = await skuExistsInStore(store.id, input.query.sku, input.query.excludeVariantId);
  return ok({ available: !taken });
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

  // At-least-one-variant: a live listing must keep at least one complete,
  // effectively-active variant. (Draft listings may go to zero.)
  if (existing.listing.status === 'active') {
    const rows = await loadVariantPublishRows(existing.listingId);
    const liveOthers = rows.filter(
      (v) =>
        v.id !== existing.id &&
        v.isActive &&
        isVariantComplete(v, existing.listing.galleryUrls.length),
    );
    if (liveOthers.length === 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot delete the last live variant of a published product — unpublish the product first or deactivate the variant instead.',
      );
    }
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
        const variantRows = await loadVariantPublishRows(id);
        // Soft-skip (no throw) any listing that isn't publishable.
        try {
          assertListingPublishable(
            {
              name: listing.name,
              description: listing.description,
              descriptionLong: listing.descriptionLong,
              galleryUrls: listing.galleryUrls,
              listingPolicy: listing.listingPolicy,
            },
            variantRows,
          );
        } catch {
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

// ===== Variant groups (system color → size hierarchy) =====

async function loadOwnedListing(auth: Auth, listingId: string) {
  const retailer = await loadRetailer(auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, listingId),
    with: { brand: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
  }
  return { retailer, store, listing };
}

async function loadOwnedGroup(auth: Auth, groupId: string) {
  const retailer = await loadRetailer(auth.sub);
  const store = await loadOwnedStore(retailer.storeId);
  const group = await db.query.variantGroups.findFirst({
    where: eq(variantGroups.id, groupId),
    with: { listing: true },
  });
  if (!group) throw new AppError(404, ErrorCode.NotFound, 'Variant group not found');
  if (group.storeId !== store.id) {
    throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant group');
  }
  return { retailer, store, group };
}

/** The child's size value under either key casing (legacy rows used "Size"). */
function sizeOfVariant(attrs: Record<string, string>): string | null {
  for (const key of Object.keys(attrs)) {
    if (key.toLowerCase() === 'size') return attrs[key] ?? null;
  }
  return null;
}

export async function createGroup(input: {
  auth: Auth;
  listingId: string;
  body: z.infer<typeof CreateGroupBody>;
}) {
  const { store, listing } = await loadOwnedListing(input.auth, input.listingId);
  if (listing.variantMode === 'custom') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This product uses custom options — color groups apply to the standard colors & sizes structure',
    );
  }

  const siblings = await db.query.variantGroups.findMany({
    where: eq(variantGroups.listingId, listing.id),
  });
  if (siblings.some((g) => g.name.toLowerCase() === input.body.name.toLowerCase())) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A color "${input.body.name}" already exists on this product`,
    );
  }

  const [created] = await db
    .insert(variantGroups)
    .values({
      id: newId(IdPrefix.VariantGroup),
      listingId: listing.id,
      storeId: store.id,
      name: input.body.name,
      ...(input.body.colorHex !== undefined && { colorHex: input.body.colorHex }),
      sortOrder: input.body.sortOrder ?? siblings.length,
    })
    .returning();
  if (!created) throw AppError.internal('variant group insert returned no row');
  return ok(created);
}

export async function patchGroup(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchGroupBody>;
}) {
  const { group } = await loadOwnedGroup(input.auth, input.id);

  if (input.body.name !== undefined && group.isDefault) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'The default group is system-managed and cannot be renamed',
    );
  }

  if (input.body.name !== undefined && input.body.name.toLowerCase() !== group.name.toLowerCase()) {
    const siblings = await db.query.variantGroups.findMany({
      where: eq(variantGroups.listingId, group.listingId),
      columns: { id: true, name: true },
    });
    if (
      siblings.some(
        (g) => g.id !== group.id && g.name.toLowerCase() === input.body.name!.toLowerCase(),
      )
    ) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `A color "${input.body.name}" already exists on this product`,
      );
    }
  }

  const renamed = input.body.name !== undefined && input.body.name !== group.name;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(variantGroups)
      .set({ ...compact(input.body), updatedAt: new Date() })
      .where(eq(variantGroups.id, group.id))
      .returning();

    // A rename cascades into every child's derived identity. Historical
    // snapshots (orders, POS) are copies and stay untouched.
    if (renamed && row) {
      const children = await tx.query.variants.findMany({
        where: eq(variants.groupId, group.id),
      });
      for (const child of children) {
        const size = sizeOfVariant(child.attributes);
        const identity = size
          ? deriveVariantIdentity(row, size)
          : { attributes: { color: row.name }, attributesLabel: row.name };
        await tx
          .update(variants)
          .set({ attributes: identity.attributes, attributesLabel: identity.attributesLabel })
          .where(eq(variants.id, child.id));
      }
      await tx.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: group.listingId,
        action: 'variant.edit',
        actorKind: 'retailer',
        actorId: input.auth.sub,
        before: { groupName: group.name },
        after: { groupName: row.name },
        note: `group=${group.id} renamed; ${children.length} variant(s) relabelled`,
      });
    }
    return row;
  });
  return ok(updated);
}

export async function deleteGroup(input: { auth: Auth; id: string }) {
  const { group } = await loadOwnedGroup(input.auth, input.id);
  const { childIds } = await assertGroupDeletable(db, group);

  await db.transaction(async (tx) => {
    if (childIds.length > 0) {
      await tx.delete(cartEvents).where(inArray(cartEvents.variantId, childIds));
      await tx.delete(listingViews).where(inArray(listingViews.variantId, childIds));
      await tx
        .delete(inventoryAdjustments)
        .where(inArray(inventoryAdjustments.variantId, childIds));
      await tx.delete(variants).where(inArray(variants.id, childIds));
    }
    await tx.delete(variantGroups).where(eq(variantGroups.id, group.id));
    await tx.insert(listingAuditEntries).values({
      id: newId('lae'),
      listingId: group.listingId,
      action: 'variant.delete',
      actorKind: 'retailer',
      actorId: input.auth.sub,
      before: { groupName: group.name, variantCount: childIds.length },
      after: null,
      note: `group=${group.id} deleted with ${childIds.length} variant(s)`,
    });
  });
  return ok({ id: group.id, deleted: true, variantsDeleted: childIds.length });
}

/** Insert one size variant under a group; identity is server-derived. */
async function insertGroupVariant(
  store: { id: string },
  listing: {
    id: string;
    name: string;
    galleryUrls: string[];
    brand: { name: string } | null;
  },
  group: { id: string; name: string; isDefault: boolean },
  body: z.infer<typeof CreateGroupVariantBody>,
  allocated?: Set<string>,
) {
  const identity = deriveVariantIdentity(group, body.size);

  const newKey = attributesKey(identity.attributes);
  const siblings = await db.query.variants.findMany({
    where: eq(variants.listingId, listing.id),
    columns: { attributes: true },
  });
  if (siblings.some((v) => attributesKey(v.attributes) === newKey)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A variant '${identity.attributesLabel}' already exists on this product`,
    );
  }

  const sku =
    body.sku ??
    (await generateSku(
      {
        brand: listing.brand?.name ?? null,
        name: listing.name,
        attributesLabel: identity.attributesLabel,
      },
      (candidate) => skuExistsInStore(store.id, candidate),
      allocated,
    ));

  const newGallery = mergeIntoGallery(listing.galleryUrls, body.imageUrls);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(variants)
      .values({
        id: newId(IdPrefix.Variant),
        listingId: listing.id,
        storeId: store.id,
        groupId: group.id,
        attributes: identity.attributes,
        attributesLabel: identity.attributesLabel,
        sku,
        pricePaise: body.pricePaise,
        ...(body.compareAtPrice !== undefined && { compareAtPrice: body.compareAtPrice }),
        stock: body.stock,
        imageUrls: body.imageUrls,
        reserved: 0,
      })
      .returning();
    if (newGallery.length !== listing.galleryUrls.length) {
      await tx
        .update(productListings)
        .set({ galleryUrls: newGallery, updatedAt: new Date() })
        .where(eq(productListings.id, listing.id));
    }
    return row;
  });
  // Keep the in-memory gallery in sync for multi-insert callers.
  listing.galleryUrls = newGallery;
  return created;
}

export async function createGroupVariant(input: {
  auth: Auth;
  listingId: string;
  groupId: string;
  body: z.infer<typeof CreateGroupVariantBody>;
}) {
  const { store, listing } = await loadOwnedListing(input.auth, input.listingId);
  if (listing.variantMode === 'custom') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This product uses custom options — add variants through the custom flow',
    );
  }
  const group = await db.query.variantGroups.findFirst({
    where: eq(variantGroups.id, input.groupId),
  });
  if (!group || group.listingId !== listing.id) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant group not found on this listing');
  }

  try {
    const created = await insertGroupVariant(store, listing, group, input.body);
    return ok(created);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(409, ErrorCode.SkuTaken, 'That SKU already exists in your store');
    }
    throw err;
  }
}

export async function bulkCreateGroupVariants(input: {
  auth: Auth;
  listingId: string;
  groupId: string;
  body: z.infer<typeof BulkCreateGroupVariantsBody>;
}) {
  const { store, listing } = await loadOwnedListing(input.auth, input.listingId);
  if (listing.variantMode === 'custom') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'This product uses custom options — add variants through the custom flow',
    );
  }
  const group = await db.query.variantGroups.findFirst({
    where: eq(variantGroups.id, input.groupId),
  });
  if (!group || group.listingId !== listing.id) {
    throw new AppError(404, ErrorCode.NotFound, 'Variant group not found on this listing');
  }

  const seen = new Set<string>();
  for (const v of input.body.variants) {
    const k = v.size.toLowerCase();
    if (seen.has(k)) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Size '${v.size}' appears more than once in this batch`,
      );
    }
    seen.add(k);
  }

  const allocated = new Set<string>();
  const created = [];
  try {
    for (const v of input.body.variants) {
      created.push(await insertGroupVariant(store, listing, group, v, allocated));
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(409, ErrorCode.SkuTaken, 'One or more SKUs already exist in your store');
    }
    throw err;
  }
  return ok(created);
}

/**
 * Idempotent upsert of the single-product default variant — the backend half of
 * the at-least-one-variant philosophy. First call creates the variant in the
 * default group; later calls patch it in place.
 */
export async function upsertDefaultVariant(input: {
  auth: Auth;
  listingId: string;
  body: z.infer<typeof DefaultVariantBody>;
}) {
  const { store, listing } = await loadOwnedListing(input.auth, input.listingId);
  if (listing.variantMode !== 'single') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'The default variant applies to single products only — manage variants directly instead',
    );
  }

  const body = input.body;
  const defaultGroup = await getOrCreateDefaultGroup(db, listing.id, store.id);
  const existing = await db.query.variants.findFirst({
    where: eq(variants.listingId, listing.id),
  });

  const newGallery = mergeIntoGallery(listing.galleryUrls, body.imageUrls);
  const galleryChanged = newGallery.length !== listing.galleryUrls.length;

  if (!existing) {
    const identity = defaultVariantIdentity();
    const sku =
      body.sku ??
      (await generateSku(
        { brand: listing.brand?.name ?? null, name: listing.name, attributesLabel: '' },
        (candidate) => skuExistsInStore(store.id, candidate),
      ));
    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(variants)
          .values({
            id: newId(IdPrefix.Variant),
            listingId: listing.id,
            storeId: store.id,
            groupId: defaultGroup.id,
            attributes: identity.attributes,
            attributesLabel: identity.attributesLabel,
            sku,
            pricePaise: body.pricePaise,
            ...(body.compareAtPrice != null && { compareAtPrice: body.compareAtPrice }),
            stock: body.stock,
            imageUrls: body.imageUrls,
            reserved: 0,
          })
          .returning();
        if (galleryChanged) {
          await tx
            .update(productListings)
            .set({ galleryUrls: newGallery, updatedAt: new Date() })
            .where(eq(productListings.id, listing.id));
        }
        return row;
      });
      return ok(created);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new AppError(409, ErrorCode.SkuTaken, `SKU '${sku}' already exists in your store`);
      }
      throw err;
    }
  }

  // Update path — same guards as patchVariant.
  if (body.stock < existing.reserved) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Cannot set stock below currently reserved (${existing.reserved})`,
    );
  }
  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(variants)
        .set({
          pricePaise: body.pricePaise,
          compareAtPrice: body.compareAtPrice ?? null,
          stock: body.stock,
          ...(body.sku !== undefined && { sku: body.sku }),
          imageUrls: body.imageUrls,
        })
        .where(eq(variants.id, existing.id))
        .returning();
      if (galleryChanged) {
        await tx
          .update(productListings)
          .set({ galleryUrls: newGallery, updatedAt: new Date() })
          .where(eq(productListings.id, listing.id));
      }
      if (body.stock !== existing.stock) {
        await tx.insert(inventoryAdjustments).values({
          id: newId(IdPrefix.InventoryAdjustment),
          variantId: existing.id,
          delta: body.stock - existing.stock,
          newStock: body.stock,
          reason: 'manual_edit',
          actorKind: 'retailer',
          actorId: input.auth.sub,
        });
      }
      if (body.pricePaise !== existing.pricePaise) {
        await tx.insert(listingAuditEntries).values({
          id: newId('lae'),
          listingId: existing.listingId,
          action: 'variant.edit',
          actorKind: 'retailer',
          actorId: input.auth.sub,
          before: { pricePaise: existing.pricePaise },
          after: { pricePaise: body.pricePaise },
          note: `variant=${existing.id}`,
        });
      }
      return row;
    });
    return ok(updated);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        ErrorCode.SkuTaken,
        `SKU '${body.sku ?? '?'}' already exists in your store`,
      );
    }
    throw err;
  }
}
