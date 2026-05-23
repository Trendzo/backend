import type { FastifyRequest } from 'fastify';
import { AppError } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { uploadToCloudinary } from '@/shared/cloudinary.js';
import { UploadQuery } from './uploads.validators.js';

const LISTING_GALLERY_MAX_BYTES = 5 * 1024 * 1024;
const LISTING_GALLERY_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Single media-upload endpoint for the platform. Accepts one file in a multipart body,
 * pushes it to Cloudinary, and returns the public URL plus a bit of metadata. Any
 * authenticated user (admin / retailer / consumer) can call it; the uploaded asset's
 * public URL is returned for the caller to wire into whatever record they're building
 * (product gallery, store photo, support attachment, etc.).
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
  if (file.file.truncated) {
    throw AppError.validation('File too large — limit is 25 MB');
  }

  // Listing-gallery has a tighter 5 MB cap + format filter per US-5.2.4.
  if (parsedQuery.data.purpose === 'listing-gallery') {
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

  const result = await uploadToCloudinary(buffer, {
    folder,
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
