import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { aiCatalogSubmissions, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { uploadObject } from '@/shared/storage/index.js';
import { virtualTryOn } from '@/shared/vertex-tryon.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { createListing, createVariant } from '@/modules/retailer/listings/listings.controller.js';
import { generateMockupViews } from '@/shared/ai-catalog/generate-views.js';
import type {
  DecisionBody,
  ListQuery,
  MockupsBody,
  PublishBody,
  SubmissionBody,
  TryOnBody,
} from './ai-catalog-beta.validators.js';

type Auth = AccessTokenPayload;

// Cap on open (unpublished) beta drafts per store — bounds generation cost.
const MAX_OPEN_DRAFTS = 30;
const BETA_FOLDER = 'closetx/ai-catalog-beta';
const TRYON_FOLDER = 'closetx/ai-tryon-beta';

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
 * BETA: create a submission with NO listing (product-last flow), generate a
 * multi-angle set (optionally printing a design onto plain apparel first), and
 * leave it in `ready_for_review`.
 */
export async function createSubmission(input: {
  auth: Auth;
  body: z.infer<typeof SubmissionBody>;
}) {
  const { auth, body } = input;
  const store = await loadStore(auth.sub);

  const openDrafts = await db.query.aiCatalogSubmissions.findMany({
    where: and(
      eq(aiCatalogSubmissions.storeId, store.id),
      isNull(aiCatalogSubmissions.listingId),
      inArray(aiCatalogSubmissions.status, ['processing', 'ready_for_review', 'accepted']),
    ),
    columns: { id: true },
  });
  if (openDrafts.length >= MAX_OPEN_DRAFTS) {
    throw new AppError(
      429,
      ErrorCode.RateLimited,
      `Too many open drafts (${openDrafts.length}/${MAX_OPEN_DRAFTS}). Publish or reject some first.`,
    );
  }

  const referenceImageUrls = [
    ...body.apparelImageUrls,
    ...(body.apparelBackImageUrl ? [body.apparelBackImageUrl] : []),
    ...(body.designImageUrl ? [body.designImageUrl] : []),
    ...(body.patternCloseupUrl ? [body.patternCloseupUrl] : []),
    ...(body.logoCloseupUrl ? [body.logoCloseupUrl] : []),
    ...(body.tagLabelUrl ? [body.tagLabelUrl] : []),
  ];
  const basePrompt = body.prompt?.trim() ?? '';

  const id = newId('aic');
  await db.insert(aiCatalogSubmissions).values({
    id,
    storeId: store.id,
    listingId: null,
    mode: body.mode,
    prompt: basePrompt,
    referenceImageUrls,
    rawPhotos: referenceImageUrls,
    outputUrls: [],
    status: 'processing',
  });

  try {
    const { printedUrl, views } = await generateMockupViews(body, BETA_FOLDER);
    const outputUrls = [...(printedUrl ? [printedUrl] : []), ...views.map((v) => v.url)];

    const [row] = await db
      .update(aiCatalogSubmissions)
      .set({ outputUrls, status: 'ready_for_review', errorMessage: null })
      .where(eq(aiCatalogSubmissions.id, id))
      .returning();
    if (!row) throw AppError.internal('submission update returned no row');
    return ok(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await db
      .update(aiCatalogSubmissions)
      .set({ status: 'failed', errorMessage: message })
      .where(eq(aiCatalogSubmissions.id, id));
    throw err instanceof AppError
      ? err
      : new AppError(502, ErrorCode.InternalError, `Generation failed: ${message}`);
  }
}

/** Approve or deny a submission that is awaiting review. */
export async function decide(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof DecisionBody>;
}) {
  const { auth, id, body } = input;
  const store = await loadStore(auth.sub);

  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(eq(aiCatalogSubmissions.id, id), eq(aiCatalogSubmissions.storeId, store.id)),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  if (sub.status !== 'ready_for_review') {
    throw new AppError(409, ErrorCode.InvalidState, 'Submission not ready for review');
  }

  const [row] = await db
    .update(aiCatalogSubmissions)
    .set({
      status: body.decision === 'accept' ? 'accepted' : 'rejected',
      ...(body.decision === 'reject' && body.revisionNotes
        ? { revisionNotes: body.revisionNotes }
        : {}),
    })
    .where(eq(aiCatalogSubmissions.id, sub.id))
    .returning();
  if (!row) throw AppError.internal('submission update returned no row');
  return ok({ id: row.id, status: row.status });
}

/**
 * Add product details and create the product from an accepted submission.
 * Reuses the real listing-creation path (createListing + createVariant), then
 * links the submission to the new listing.
 */
export async function publish(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PublishBody>;
}) {
  const { auth, id, body } = input;
  const store = await loadStore(auth.sub);

  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(eq(aiCatalogSubmissions.id, id), eq(aiCatalogSubmissions.storeId, store.id)),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  if (sub.status !== 'accepted') {
    throw new AppError(409, ErrorCode.InvalidState, 'Submission must be accepted before publishing');
  }
  if (sub.listingId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Submission already published to a listing');
  }

  const galleryUrls =
    body.selectedImageUrls && body.selectedImageUrls.length > 0
      ? body.selectedImageUrls
      : (sub.outputUrls ?? []);
  if (galleryUrls.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'No images available to publish');
  }

  const listingRes = await createListing({
    auth,
    body: {
      name: body.name,
      ...(body.description !== undefined && { description: body.description }),
      ...(body.descriptionLong !== undefined && { descriptionLong: body.descriptionLong }),
      brandId: body.brandId,
      categoryId: body.categoryId,
      gender: body.gender,
      listingPolicy: body.listingPolicy,
      galleryUrls,
      occasion: body.occasion,
      ageGroups: body.ageGroups,
      ...(body.hsn !== undefined && { hsn: body.hsn }),
      variantMode: 'single',
    },
  });
  const listing = listingRes.data;

  const variantRes = await createVariant({
    auth,
    listingId: listing.id,
    body: {
      attributes: {},
      attributesLabel: 'Default',
      pricePaise: body.pricePaise,
      ...(body.compareAtPrice !== undefined && { compareAtPrice: body.compareAtPrice }),
      stock: body.stock,
      imageUrls: [],
    },
  });
  const variant = variantRes.data;

  await db
    .update(aiCatalogSubmissions)
    .set({ listingId: listing.id })
    .where(eq(aiCatalogSubmissions.id, sub.id));

  return ok({ listing, variant });
}

export async function listSubmissions(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const { auth, query } = input;
  const store = await loadStore(auth.sub);
  const conditions = [eq(aiCatalogSubmissions.storeId, store.id)];
  if (query.status) conditions.push(eq(aiCatalogSubmissions.status, query.status));
  const rows = await db.query.aiCatalogSubmissions.findMany({
    where: and(...conditions),
    orderBy: desc(aiCatalogSubmissions.at),
    limit: query.limit,
  });
  return ok(rows);
}

export async function getSubmission(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const store = await loadStore(auth.sub);
  const sub = await db.query.aiCatalogSubmissions.findFirst({
    where: and(eq(aiCatalogSubmissions.id, id), eq(aiCatalogSubmissions.storeId, store.id)),
  });
  if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
  return ok(sub);
}

/**
 * BETA quick mockups — stateless. Generate the multi-angle set (design-print +
 * angles, same as a submission) and return the image URLs WITHOUT creating a
 * submission row or a product.
 */
export async function quickMockups(input: { auth: Auth; body: z.infer<typeof MockupsBody> }) {
  await loadStore(input.auth.sub);
  const { printedUrl, views } = await generateMockupViews(input.body, BETA_FOLDER);
  return ok({ printed: printedUrl, images: views });
}

/**
 * BETA customer virtual try-on — stateless. A person photo + 1-2 garment photos;
 * garments are layered (each result becomes the next "person", e.g. top then
 * bottom). Returns the final image plus each layering step. Uses Vertex's
 * dedicated virtual-try-on-001 model.
 */
export async function tryOn(input: { auth: Auth; body: z.infer<typeof TryOnBody> }) {
  await loadStore(input.auth.sub);
  const steps: string[] = [];
  let personUrl = input.body.personImageUrl;
  for (const garmentUrl of input.body.garmentImageUrls) {
    const out = await virtualTryOn(personUrl, garmentUrl);
    const buffer = Buffer.from(out.base64, 'base64');
    // The returned URL is fed straight back in as the next iteration's person image,
    // which Vertex fetches SERVER-SIDE — so it must be publicly reachable, not signed.
    const uploaded = await uploadObject(buffer, {
      folder: TRYON_FOLDER,
      resourceType: 'image',
      contentType: 'image/png',
    });
    steps.push(uploaded.url);
    personUrl = uploaded.url;
  }
  return ok({ result: steps[steps.length - 1] ?? null, steps });
}
