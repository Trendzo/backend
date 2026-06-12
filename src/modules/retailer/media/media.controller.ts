/**
 * Retailer media library. Records every retailer image upload so the product
 * wizard can offer a Shopify-style "pick from already-uploaded" picker.
 *
 * The generic /uploads endpoint is unauthenticated and fire-and-forget; this
 * module is the retailer-scoped equivalent that ALSO persists a store_media row.
 */
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts, storeMedia } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { uploadToCloudinary } from '@/shared/cloudinary.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { getAuth } from '@/shared/auth/middleware.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { ListMediaQuery, UploadMediaQuery } from './media.validators.js';

type Auth = AccessTokenPayload;

const LISTING_GALLERY_MAX_BYTES = 5 * 1024 * 1024;
const LISTING_GALLERY_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
    columns: { storeId: true },
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

/**
 * Upload one file to Cloudinary and record it in the store's media library.
 * Takes `req` directly because multipart access (`req.file()`) is Fastify-specific.
 */
export async function uploadMedia(req: FastifyRequest) {
  const storeId = await getStoreId(getAuth(req).sub);

  const parsedQuery = UploadMediaQuery.safeParse(req.query);
  if (!parsedQuery.success) {
    throw AppError.validation('Bad query params', parsedQuery.error.format());
  }

  const file = await req.file();
  if (!file) {
    throw AppError.validation('No file in request — expected multipart/form-data with a `file` field');
  }

  const buffer = await file.toBuffer();
  if (file.file.truncated) {
    throw AppError.validation('File too large — limit is 25 MB');
  }

  const purpose = parsedQuery.data.purpose;
  if (purpose === 'listing-gallery' || purpose === 'listing-description') {
    if (buffer.length > LISTING_GALLERY_MAX_BYTES) {
      throw AppError.validation('File too large — listing images are capped at 5 MB');
    }
    if (!LISTING_GALLERY_MIMES.has(file.mimetype)) {
      throw AppError.validation(
        `Unsupported format '${file.mimetype}' — listing images must be JPEG, PNG, or WebP`,
      );
    }
  }

  const folderSuffix = parsedQuery.data.folder ?? 'uploads';
  const folder = `closetx/${folderSuffix.replace(/^\/+|\/+$/g, '')}`;

  const result = await uploadToCloudinary(buffer, { folder });

  const [row] = await db
    .insert(storeMedia)
    .values({
      id: newId(IdPrefix.Media),
      storeId,
      url: result.url,
      publicId: result.publicId,
      folder: parsedQuery.data.folder ?? null,
      resourceType: result.resourceType,
      mimetype: file.mimetype,
      width: result.width ?? null,
      height: result.height ?? null,
      bytes: result.bytes,
      alt: parsedQuery.data.alt ?? null,
    })
    .returning();
  if (!row) throw AppError.internal('media insert returned no row');

  return ok({
    id: row.id,
    url: row.url,
    publicId: row.publicId,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    resourceType: row.resourceType,
    mimetype: row.mimetype,
    folder: row.folder,
    createdAt: row.createdAt,
  });
}

export async function listMedia(input: { auth: Auth; query: z.infer<typeof ListMediaQuery> }) {
  const storeId = await getStoreId(input.auth.sub);
  const { limit, cursor, folder, type } = input.query;

  const conds = [eq(storeMedia.storeId, storeId), isNull(storeMedia.deletedAt)];
  if (folder) conds.push(eq(storeMedia.folder, folder));
  if (type) conds.push(eq(storeMedia.resourceType, type));
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!Number.isNaN(cursorDate.getTime())) conds.push(lt(storeMedia.createdAt, cursorDate));
  }

  const rows = await db.query.storeMedia.findMany({
    where: and(...conds),
    orderBy: desc(storeMedia.createdAt),
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;

  return ok({
    items: items.map((m) => ({
      id: m.id,
      url: m.url,
      publicId: m.publicId,
      width: m.width,
      height: m.height,
      bytes: m.bytes,
      resourceType: m.resourceType,
      mimetype: m.mimetype,
      folder: m.folder,
      createdAt: m.createdAt,
    })),
    nextCursor,
  });
}

/**
 * Soft-delete: only flags deletedAt. The Cloudinary asset and URL survive so any
 * listing/variant still referencing this URL keeps rendering.
 */
export async function deleteMedia(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);
  const [row] = await db
    .update(storeMedia)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(storeMedia.id, input.id),
        eq(storeMedia.storeId, storeId),
        isNull(storeMedia.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Media not found');
  return ok({ id: row.id, deleted: true });
}
