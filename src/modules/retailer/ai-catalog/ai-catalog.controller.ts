import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  aiCatalogSubmissions,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { uploadObject } from '@/shared/storage/index.js';
import { generateCatalogImage } from '@/shared/ai-image.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AcceptBody,
  GenerateBody,
  ListQuery,
  QuotaQuery,
  RegenerateBody,
} from './ai-catalog.validators.js';

type Auth = AccessTokenPayload;

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

/**
 * Per-listing quota: one generation attempt per variant. Only ROOT submissions
 * (parentSubmissionId IS NULL) count — a regeneration consumes the parent's
 * single revision allowance, not a fresh attempt.
 *
 * `failed` submissions do NOT count: a provider error is not the retailer's
 * fault, so they get a free retry. Every other terminal or in-flight state
 * does count, including `rejected` (the retailer used the slot to look) and
 * `processing` (in-flight; otherwise parallel POSTs could double-spend).
 */
async function getListingQuota(storeId: string, listingId: string) {
  const [variantRow] = await db
    .select({ c: count() })
    .from(variants)
    .where(eq(variants.listingId, listingId));
  const variantCount = variantRow?.c ?? 0;

  const [attemptRow] = await db
    .select({ c: count() })
    .from(aiCatalogSubmissions)
    .where(
      and(
        eq(aiCatalogSubmissions.storeId, storeId),
        eq(aiCatalogSubmissions.listingId, listingId),
        isNull(aiCatalogSubmissions.parentSubmissionId),
        inArray(aiCatalogSubmissions.status, [
          'submitted',
          'processing',
          'ready_for_review',
          'accepted',
          'rejected',
          'regenerating',
        ]),
      ),
    );
  const usedAttempts = attemptRow?.c ?? 0;

  return {
    listingId,
    variantCount,
    usedAttempts,
    remaining: Math.max(0, variantCount - usedAttempts),
  };
}

async function runGeneration(
  submissionId: string,
  input: {
    prompt: string;
    mode: 'with_model' | 'without_model';
    referenceImageUrls: string[];
    posePreferences?: string[];
    revisionNotes?: string | null;
  },
): Promise<void> {
  try {
    const gen = await generateCatalogImage(input);
    const buffer = Buffer.from(gen.base64, 'base64');
    const upload = await uploadObject(buffer, {
      folder: 'closetx/ai-catalog',
      resourceType: 'image',
      contentType: 'image/png',
    });
    await db
      .update(aiCatalogSubmissions)
      .set({
        outputUrls: [upload.url],
        status: 'ready_for_review',
        thirdPartyRequestId: gen.thirdPartyRequestId,
        costPaise: gen.costPaise,
        errorMessage: null,
      })
      .where(eq(aiCatalogSubmissions.id, submissionId));
  } catch (err) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown error';
    await db
      .update(aiCatalogSubmissions)
      .set({ status: 'failed', errorMessage: message })
      .where(eq(aiCatalogSubmissions.id, submissionId));
    throw err;
  }
}

export async function listSubmissions(input: {
  auth: Auth;
  query: z.infer<typeof ListQuery>;
}) {
  const { auth, query } = input;
  const store = await loadStore(auth.sub);
  const conditions = [eq(aiCatalogSubmissions.storeId, store.id)];
  if (query.listingId)
    conditions.push(eq(aiCatalogSubmissions.listingId, query.listingId));
  if (query.status) conditions.push(eq(aiCatalogSubmissions.status, query.status));
  const rows = await db.query.aiCatalogSubmissions.findMany({
    where: and(...conditions),
    orderBy: desc(aiCatalogSubmissions.at),
    limit: query.limit,
  });
  return ok(rows);
}

export async function getQuota(input: { auth: Auth; query: z.infer<typeof QuotaQuery> }) {
  const { auth, query } = input;
  const store = await loadStore(auth.sub);
  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, query.listingId),
      eq(productListings.storeId, store.id),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  const quota = await getListingQuota(store.id, listing.id);
  return ok(quota);
}

export async function getSubmission(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const store = await loadStore(auth.sub);
  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(
      eq(aiCatalogSubmissions.id, id),
      eq(aiCatalogSubmissions.storeId, store.id),
    ),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');

  // Surface the child submission id so the review page can deep-link to the revision.
  const child = await db.query.aiCatalogSubmissions.findFirst({
    where: eq(aiCatalogSubmissions.parentSubmissionId, sub.id),
    columns: { id: true, status: true },
  });
  return ok({ ...sub, childSubmissionId: child?.id ?? null });
}

export async function createSubmission(input: {
  auth: Auth;
  body: z.infer<typeof GenerateBody>;
}) {
  const { auth, body } = input;
  const store = await loadStore(auth.sub);

  const listing = await db.query.productListings.findFirst({
    where: and(
      eq(productListings.id, body.listingId),
      eq(productListings.storeId, store.id),
    ),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

  if (body.targetVariantId) {
    const variant = await db.query.variants.findFirst({
      where: and(
        eq(variants.id, body.targetVariantId),
        eq(variants.listingId, listing.id),
      ),
    });
    if (!variant)
      throw new AppError(404, ErrorCode.NotFound, 'Variant not found on this listing');
  }

  const quota = await getListingQuota(store.id, listing.id);
  if (quota.variantCount === 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Listing has no variants yet — add at least one variant before generating images.',
    );
  }
  if (quota.remaining <= 0) {
    throw new AppError(
      429,
      ErrorCode.RateLimited,
      `Per-listing quota exhausted (${quota.usedAttempts}/${quota.variantCount} attempts used).`,
    );
  }

  const id = newId('aic');
  await db.insert(aiCatalogSubmissions).values({
    id,
    storeId: store.id,
    listingId: listing.id,
    targetVariantId: body.targetVariantId ?? null,
    mode: body.mode,
    prompt: body.prompt,
    referenceImageUrls: body.referenceImageUrls,
    rawPhotos: body.referenceImageUrls,
    outputUrls: [],
    status: 'processing',
  });

  await runGeneration(id, {
    prompt: body.prompt,
    mode: body.mode,
    referenceImageUrls: body.referenceImageUrls,
    ...(body.posePreferences && { posePreferences: body.posePreferences }),
  });

  const row = await db.query.aiCatalogSubmissions.findFirst({
    where: eq(aiCatalogSubmissions.id, id),
  });
  return ok(row);
}

export async function regenerateSubmission(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof RegenerateBody>;
}) {
  const { auth, id, body } = input;
  const store = await loadStore(auth.sub);

  const parent = await db.query.aiCatalogSubmissions.findFirst({
    where: and(
      eq(aiCatalogSubmissions.id, id),
      eq(aiCatalogSubmissions.storeId, store.id),
    ),
  });
  if (!parent) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  if (parent.parentSubmissionId) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Cannot regenerate a revision — only the original submission can be revised once.',
    );
  }
  // Allow regenerate when parent is reviewable OR when an earlier
  // regeneration attempt failed and left the parent stranded in `regenerating`.
  if (parent.status !== 'ready_for_review' && parent.status !== 'regenerating') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Parent submission must be in ready_for_review to regenerate.',
    );
  }
  // Failed prior children don't block — provider errors shouldn't burn the
  // one-revision allowance. Successful prior child blocks: accept or reject it first.
  const existingChild = await db.query.aiCatalogSubmissions.findFirst({
    where: and(
      eq(aiCatalogSubmissions.parentSubmissionId, parent.id),
      inArray(aiCatalogSubmissions.status, [
        'submitted',
        'processing',
        'ready_for_review',
        'accepted',
        'rejected',
        'regenerating',
      ]),
    ),
  });
  if (existingChild) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'A revision already exists for this submission. Accept or reject it.',
    );
  }

  const newSubId = newId('aic');
  await db.insert(aiCatalogSubmissions).values({
    id: newSubId,
    storeId: store.id,
    listingId: parent.listingId,
    targetVariantId: parent.targetVariantId,
    mode: parent.mode,
    prompt: parent.prompt,
    referenceImageUrls: parent.referenceImageUrls,
    rawPhotos: parent.rawPhotos,
    revisionNotes: body.revisionNotes,
    outputUrls: [],
    status: 'processing',
    parentSubmissionId: parent.id,
  });

  // Flip parent to `regenerating` so list/detail UI can show the linkage.
  await db
    .update(aiCatalogSubmissions)
    .set({ status: 'regenerating' })
    .where(eq(aiCatalogSubmissions.id, parent.id));

  try {
    await runGeneration(newSubId, {
      prompt: parent.prompt,
      mode: parent.mode,
      referenceImageUrls: parent.referenceImageUrls,
      revisionNotes: body.revisionNotes,
    });
  } catch (err) {
    // Child generation failed (provider error). Revert parent to its prior
    // reviewable state so the retailer can either accept the original
    // output or retry the revision.
    await db
      .update(aiCatalogSubmissions)
      .set({ status: 'ready_for_review' })
      .where(eq(aiCatalogSubmissions.id, parent.id));
    throw err;
  }

  const row = await db.query.aiCatalogSubmissions.findFirst({
    where: eq(aiCatalogSubmissions.id, newSubId),
  });
  return ok(row);
}

export async function acceptSubmission(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof AcceptBody>;
}) {
  const { auth, id, body } = input;
  const store = await loadStore(auth.sub);

  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(
      eq(aiCatalogSubmissions.id, id),
      eq(aiCatalogSubmissions.storeId, store.id),
    ),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  if (sub.status !== 'ready_for_review') {
    throw new AppError(409, ErrorCode.InvalidState, 'Submission not ready for review');
  }
  const outputUrl = sub.outputUrls?.[0];
  if (!outputUrl) {
    throw new AppError(409, ErrorCode.InvalidState, 'No output image available to accept.');
  }

  const targetVariantId = body.targetVariantId ?? sub.targetVariantId;

  if (targetVariantId && sub.listingId) {
    const variant = await db.query.variants.findFirst({
      where: and(eq(variants.id, targetVariantId), eq(variants.listingId, sub.listingId)),
    });
    if (!variant)
      throw new AppError(404, ErrorCode.NotFound, 'Variant not found on this listing');
    const merged = [...new Set([...(variant.imageUrls ?? []), outputUrl])];
    await db.update(variants).set({ imageUrls: merged }).where(eq(variants.id, variant.id));
  } else if (sub.listingId) {
    const listing = await db.query.productListings.findFirst({
      where: and(
        eq(productListings.id, sub.listingId),
        eq(productListings.storeId, store.id),
      ),
    });
    if (listing) {
      const merged = [...new Set([...(listing.galleryUrls ?? []), outputUrl])];
      await db
        .update(productListings)
        .set({ galleryUrls: merged })
        .where(eq(productListings.id, listing.id));
    }
  }

  await db
    .update(aiCatalogSubmissions)
    .set({ status: 'accepted', targetVariantId: targetVariantId ?? null })
    .where(eq(aiCatalogSubmissions.id, sub.id));

  // If this is a revision child, mark the parent accepted too so quota math
  // is unambiguous (the attempt has resolved).
  if (sub.parentSubmissionId) {
    await db
      .update(aiCatalogSubmissions)
      .set({ status: 'accepted' })
      .where(eq(aiCatalogSubmissions.id, sub.parentSubmissionId));
  }

  return ok({ id: sub.id, status: 'accepted' });
}

export async function rejectSubmission(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const store = await loadStore(auth.sub);

  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(
      eq(aiCatalogSubmissions.id, id),
      eq(aiCatalogSubmissions.storeId, store.id),
    ),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  if (sub.status !== 'ready_for_review') {
    throw new AppError(409, ErrorCode.InvalidState, 'Submission not ready for review');
  }

  await db
    .update(aiCatalogSubmissions)
    .set({ status: 'rejected' })
    .where(eq(aiCatalogSubmissions.id, sub.id));

  // Resolving a revision rejects its parent attempt too, freeing... nothing
  // (rejection still consumes the slot), but keeping state consistent.
  if (sub.parentSubmissionId) {
    await db
      .update(aiCatalogSubmissions)
      .set({ status: 'rejected' })
      .where(eq(aiCatalogSubmissions.id, sub.parentSubmissionId));
  }

  return ok({ id: sub.id, status: 'rejected' });
}
