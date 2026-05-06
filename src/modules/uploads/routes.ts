import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { uploadToCloudinary } from '@/shared/cloudinary.js';

const QuerySchema = z.object({
  /** Sub-folder under `closetx/`. Defaults to `uploads`. */
  folder: z.string().trim().min(1).max(120).optional(),
  /** Force a specific resource type. `auto` is fine for most callers. */
  resourceType: z.enum(['auto', 'image', 'video', 'raw']).optional(),
});

/**
 * Single media-upload endpoint for the platform. Accepts one file in a multipart body,
 * pushes it to Cloudinary, and returns the public URL plus a bit of metadata. Any
 * authenticated user (admin / retailer / consumer) can call it; the uploaded asset's
 * public URL is returned for the caller to wire into whatever record they're building
 * (product gallery, store photo, support attachment, etc.).
 */
const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth('admin', 'retailer', 'consumer'));

  app.post('/', async (req) => {
    // Pull a single file from the multipart body. `@fastify/multipart` is registered
    // at app level with a 25 MB-per-file ceiling.
    const file = await req.file();
    if (!file) {
      throw AppError.validation('No file in request — expected multipart/form-data with a `file` field');
    }

    // The plugin truncates if the limit is hit; check after reading.
    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      throw AppError.validation('File too large — limit is 25 MB');
    }

    const parsedQuery = QuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw AppError.validation('Bad query params', parsedQuery.error.format());
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
  });
};

export default uploadRoutes;
