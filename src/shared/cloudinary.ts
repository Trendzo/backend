import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';

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

export type UploadOptions = {
  /** Cloudinary folder path. Defaults to `closetx/uploads`. */
  folder?: string;
  /** Override the auto-generated public_id (asset key). */
  publicId?: string;
  /** `auto` (default) lets Cloudinary detect images / videos / raw files. */
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
};

export type UploadResult = {
  url: string;
  publicId: string;
  width?: number | undefined;
  height?: number | undefined;
  format?: string | undefined;
  bytes: number;
  resourceType: string;
};

/**
 * Upload a buffer to Cloudinary via their streaming uploader. Returns the secure URL
 * and a few useful metadata fields. Errors propagate as AppError so the global error
 * handler turns them into the standard envelope.
 */
export async function uploadToCloudinary(
  buffer: Buffer,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  ensureConfigured();

  // Cloudinary's SDK default request timeout is 60s; the streaming uploader doesn't
  // honour `timeout` directly, so we layer a Promise.race + a polite stream cleanup.
  // 120s gives slow upstreams (mobile + 3G) a fair chance for ~25 MB images while
  // still bounding the request — far better than the SDK default that surfaces as
  // "Request Timeout" with no detail mid-upload.
  const UPLOAD_TIMEOUT_MS = 120_000;

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
        // Trim the round-trip: skip the eager-derivation we don't use, and don't
        // wait for analysis the SDK doesn't need for our flow.
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
        finish(() =>
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
            resourceType: result.resource_type,
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
