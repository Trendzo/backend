import type { FastifyRequest } from 'fastify';
import { AppError } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { uploadObject } from '@/shared/storage/index.js';
import { assertListingMedia, assertNotTruncated } from '@/shared/uploads/limits.js';
import { UploadQuery } from './uploads.validators.js';

/**
 * Single media-upload endpoint for the platform. Accepts one file in a multipart body,
 * stores it, and returns the public URL plus a bit of metadata. Any authenticated user
 * (admin / retailer / consumer) can call it; the uploaded asset's public URL is returned
 * for the caller to wire into whatever record they're building (product gallery, store
 * photo, support attachment, etc.).
 *
 * Takes `req` directly — multipart body access (`req.file()`) is Fastify-specific.
 */
export async function uploadMedia(req: FastifyRequest) {
  const parsedQuery = UploadQuery.safeParse(req.query);
  if (!parsedQuery.success) {
    throw AppError.validation('Bad query params', parsedQuery.error.format());
  }

  // Pull a single file from the multipart body. `@fastify/multipart` is registered
  // at app level with a 25 MB-per-file ceiling.
  const file = await req.file();
  if (!file) {
    throw AppError.validation(
      'No file in request — expected multipart/form-data with a `file` field',
    );
  }

  // The plugin truncates if the limit is hit; check after reading.
  const buffer = await file.toBuffer();
  assertNotTruncated(file.file.truncated);
  assertListingMedia(parsedQuery.data.purpose, buffer.length, file.mimetype);

  const folderSuffix = parsedQuery.data.folder ?? 'uploads';
  const folder = `closetx/${folderSuffix.replace(/^\/+|\/+$/g, '')}`;

  const result = await uploadObject(buffer, {
    folder,
    contentType: file.mimetype,
    filename: file.filename,
    ...(parsedQuery.data.resourceType !== undefined && {
      resourceType: parsedQuery.data.resourceType,
    }),
  });

  return ok({
    url: result.url,
    publicId: result.publicId,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
    resourceType: result.resourceType,
    mimetype: file.mimetype,
    filename: file.filename,
  });
}
