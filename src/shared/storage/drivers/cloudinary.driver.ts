import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type { Readable } from 'node:stream';
import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';
import type { ResourceKind, StorageDriver, UploadOptions, UploadResult } from '../types.js';

/**
 * Legacy provider, kept behind the StorageDriver interface for the duration of the S3
 * migration. This is a near-verbatim move of the old `shared/cloudinary.ts` — the only
 * behavioural additions are the `videoThumbnail` option (which maps onto Cloudinary's
 * on-the-fly poster derivation) and `isConfigured()`.
 */

const UPLOAD_TIMEOUT_MS = 120_000;

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError(
      503,
      'internal_error',
      'Media uploads are not configured (missing Cloudinary credentials).',
    );
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

/**
 * Poster frame for a video, derived on the fly (`so_0`). No second object is stored —
 * which is precisely why the S3 driver has to render and upload a real one.
 */
function buildVideoThumbnailUrl(publicId: string): string {
  ensureConfigured();
  return cloudinary.url(publicId, {
    resource_type: 'video',
    format: 'jpg',
    start_offset: '0',
    secure: true,
  });
}

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function uploadBuffer(buffer: Buffer, opts: UploadOptions): Promise<UploadResult> {
  ensureConfigured();

  // Cloudinary's SDK default request timeout is 60s; the streaming uploader doesn't
  // honour `timeout` directly, so we layer an external timer + a polite stream cleanup.
  return new Promise<UploadResult>((resolve, reject) => {
    let settled = false;
    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      cb();
    };

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder ?? 'closetx/uploads',
        ...(opts.publicId !== undefined && { public_id: opts.publicId }),
        resource_type: opts.resourceType ?? 'auto',
        timeout: UPLOAD_TIMEOUT_MS,
        invalidate: false,
      },
      (error, result: UploadApiResponse | undefined) => {
        clearTimeout(timer);
        if (error) {
          finish(() =>
            reject(
              new AppError(
                502,
                'internal_error',
                `Cloudinary upload failed: ${error.message ?? 'unknown error'}`,
              ),
            ),
          );
          return;
        }
        if (!result) {
          finish(() => reject(new AppError(502, 'internal_error', 'Cloudinary returned no result')));
          return;
        }
        const wantsThumb = opts.videoThumbnail === true && result.resource_type === 'video';
        finish(() =>
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
            resourceType: result.resource_type,
            duration: result.duration,
            contentType: opts.contentType,
            ...(wantsThumb && {
              thumbnailUrl: buildVideoThumbnailUrl(result.public_id),
              // Derived, not stored — there is no separate asset to address.
              thumbnailPublicId: undefined,
            }),
          }),
        );
      },
    );

    const timer = setTimeout(() => {
      finish(() => {
        try {
          stream.destroy(new Error('upload timeout'));
        } catch {
          // ignore — we're already rejecting below
        }
        reject(
          new AppError(
            504,
            'internal_error',
            `Cloudinary upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s — try a smaller file or retry.`,
          ),
        );
      });
    }, UPLOAD_TIMEOUT_MS);

    stream.end(buffer);
  });
}

export const cloudinaryDriver: StorageDriver = {
  name: 'cloudinary',

  isConfigured(): boolean {
    return Boolean(
      env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
    );
  },

  async upload(body, opts) {
    return uploadBuffer(await toBuffer(body), opts);
  },

  /**
   * Best-effort: Cloudinary returns `{ result: 'not found' }` (no throw) for a missing
   * asset, so a stale publicId resolves silently; genuine failures surface as AppError.
   */
  async delete(publicId: string, kind: Exclude<ResourceKind, 'auto'> = 'image'): Promise<void> {
    ensureConfigured();
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: kind, invalidate: true });
    } catch (err) {
      throw new AppError(
        502,
        'internal_error',
        `Cloudinary delete failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
  },

  /** Cloudinary assets are public by delivery URL; there is no separate signed read. */
  async signedReadUrl(publicId: string): Promise<string> {
    ensureConfigured();
    return cloudinary.url(publicId, { secure: true });
  },

  publicUrl(publicId: string): string {
    ensureConfigured();
    return cloudinary.url(publicId, { secure: true });
  },
};
