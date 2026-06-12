/**
 * Admin store listings CRUD + bulk.
 */
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  attributeTemplates,
  brands,
  categories,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify, notifySummaryToStoreOwners } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  BulkDeleteBody,
  BulkStatusBody,
  CreateListingBody,
} from './store-listings.validators.js';

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

export async function createListing(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof CreateListingBody>;
  requestId: string;
}) {
  await loadStoreOr404(input.storeId);
  const [brand, category] = await Promise.all([
    db.query.brands.findFirst({ where: eq(brands.id, input.body.brandId) }),
    db.query.categories.findFirst({ where: eq(categories.id, input.body.categoryId) }),
  ]);
  if (!brand) throw new AppError(404, ErrorCode.NotFound, `Brand ${input.body.brandId} not found`);
  if (!category) {
    throw new AppError(404, ErrorCode.NotFound, `Category ${input.body.categoryId} not found`);
  }
  if (input.body.templateId) {
    const tpl = await db.query.attributeTemplates.findFirst({
      where: eq(attributeTemplates.id, input.body.templateId),
    });
    if (!tpl) {
      throw new AppError(404, ErrorCode.NotFound, `Template ${input.body.templateId} not found`);
    }
  }
  const id = newId(IdPrefix.Listing);
  const [created] = await db
    .insert(productListings)
    .values({
      id,
      storeId: input.storeId,
      brandId: input.body.brandId,
      categoryId: input.body.categoryId,
      name: input.body.name,
      ...(input.body.description !== undefined && { description: input.body.description }),
      ...(input.body.hsn !== undefined && { hsn: input.body.hsn }),
      ...(input.body.templateId !== undefined && { templateId: input.body.templateId }),
      gender: input.body.gender,
      listingPolicy: input.body.listingPolicy,
      galleryUrls: input.body.galleryUrls,
      status: 'draft',
    })
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'listing.create',
    resourceKind: 'product_listing',
    resourceId: id,
    after: { name: input.body.name, status: 'draft' },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin created a listing',
    body: `"${input.body.name}" was added by ClosetX admin.`,
    deepLink: `/retailer/listings/${id}`,
    data: { listingId: id },
  });
  return ok(created);
}

export async function deleteListing(input: {
  auth: Auth;
  storeId: string;
  listingId: string;
  requestId: string;
}) {
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, input.listingId),
      eq(productListings.storeId, input.storeId),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.status !== 'draft') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only draft listings can be deleted');
  }
  await db.delete(productListings).where(eq(productListings.id, listing.id));
  await recordAudit({
    actor: input.auth,
    action: 'listing.delete',
    resourceKind: 'product_listing',
    resourceId: listing.id,
    before: { name: listing.name, status: listing.status },
    impersonatedStoreId: input.storeId,
    requestId: input.requestId,
  });
  await notifyOwners(input.storeId, {
    title: 'Admin deleted a draft listing',
    body: `"${listing.name}" was removed.`,
  });
  return ok({ id: listing.id, deleted: true });
}

export async function bulkStatus(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkStatusBody>;
  requestId: string;
}) {
  let updated = 0;
  let skipped = 0;
  const updatedIds: string[] = [];

  await db.transaction(async (tx) => {
    for (const id of input.body.ids) {
      const listing = await tx.query.productListings.findFirst({
        where: and(eq(productListings.id, id), eq(productListings.storeId, input.storeId)),
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
      await recordAudit({
        actor: input.auth,
        action: `listing.${
          input.body.status === 'active'
            ? 'publish'
            : input.body.status === 'retired'
              ? 'retire'
              : 'unpublish'
        }`,
        resourceKind: 'product_listing',
        resourceId: id,
        before: { status: listing.status },
        after: { status: input.body.status },
        impersonatedStoreId: input.storeId,
        requestId: input.requestId,
      });
      updated++;
      updatedIds.push(id);
    }
  });

  if (updated > 0) {
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action:
        input.body.status === 'active'
          ? 'published'
          : input.body.status === 'retired'
            ? 'retired'
            : 'set to draft',
      count: updated,
      deepLink: '/retailer/listings',
      sampleIds: updatedIds,
    });
  }
  return ok({ updated, skipped });
}

export async function bulkDelete(input: {
  auth: Auth;
  storeId: string;
  body: z.infer<typeof BulkDeleteBody>;
  requestId: string;
}) {
  let deleted = 0;
  let skipped = 0;
  const deletedIds: string[] = [];

  await db.transaction(async (tx) => {
    for (const id of input.body.ids) {
      const listing = await tx.query.productListings.findFirst({
        where: and(eq(productListings.id, id), eq(productListings.storeId, input.storeId)),
      });
      if (!listing || listing.status !== 'draft') {
        skipped++;
        continue;
      }
      await tx.delete(productListings).where(eq(productListings.id, id));
      await recordAudit({
        actor: input.auth,
        action: 'listing.delete',
        resourceKind: 'product_listing',
        resourceId: id,
        before: { name: listing.name, status: listing.status },
        impersonatedStoreId: input.storeId,
        requestId: input.requestId,
      });
      deleted++;
      deletedIds.push(id);
    }
  });

  if (deleted > 0) {
    await notifySummaryToStoreOwners({
      storeId: input.storeId,
      action: 'deleted draft',
      count: deleted,
      sampleIds: deletedIds,
    });
  }
  return ok({ deleted, skipped });
}
