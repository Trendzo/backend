import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';
import { buildObjectKey, thumbnailKeyFor, withKeyPrefix } from '../keys.js';
import {
  imageDimensions,
  sniffContentType,
  toTempFile,
  videoPoster,
  videoProbe,
} from '../probe.js';
import type { ResourceKind, StorageDriver, UploadOptions, UploadResult } from '../types.js';

/**
 * S3 storage driver. The only file besides the Cloudinary driver permitted to import a
 * vendor SDK.
 *
 * Reads go through CloudFront (`S3_PUBLIC_BASE_URL`) — the bucket itself blocks all public
 * access, so that distribution is the only path to a readable object. Objects written with
 * `visibility: 'private'` are excluded from the public prefix and are readable only via a
 * presigned URL.
 */

const UPLOAD_TIMEOUT_MS = 120_000;
const VIDEO_UPLOAD_TIMEOUT_MS = 300_000;
const DEFAULT_SIGNED_URL_TTL_SEC = 300;

/** Objects under this prefix are not served by the CDN. */
const PRIVATE_PREFIX = 'private';

let client: S3Client | null = null;
function s3(): S3Client {
  if (client) return client;
  if (!env.S3_BUCKET || !env.S3_PUBLIC_BASE_URL) {
    throw new AppError(
      503,
      'internal_error',
      'Media uploads are not configured (missing S3 configuration).',
    );
  }
  client = new S3Client({
    region: env.AWS_REGION,
    // The SDK already retries throttles and transient 5xx and never retries 4xx; a second
    // retry layer on top would just multiply the wait.
    maxAttempts: 4,
    retryMode: 'adaptive',
    // Omitted entirely in AWS-hosted environments so the default provider chain picks up
    // the task/instance role rather than long-lived keys.
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return client;
}

/** Map a resolved content type onto the resource vocabulary `store_media` filters on. */
function kindFor(contentType: string, requested: ResourceKind | undefined): string {
  if (requested !== undefined && requested !== 'auto') return requested;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'raw';
}

function fullKey(publicId: string, visibility: 'public' | 'private'): string {
  const scoped = visibility === 'private' ? `${PRIVATE_PREFIX}/${publicId}` : publicId;
  return withKeyPrefix(scoped, env.S3_KEY_PREFIX);
}

function publicUrlFor(publicId: string): string {
  const base = (env.S3_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const key = withKeyPrefix(publicId, env.S3_KEY_PREFIX);
  // Each segment is encoded separately so slashes survive as path separators.
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function putObject(input: {
  body: Buffer | Readable;
  key: string;
  contentType: string;
  filename?: string | undefined;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const upload = new Upload({
      client: s3(),
      params: {
        Bucket: env.S3_BUCKET as string,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Render in-browser rather than downloading a hash-named file. Matters most for
        // invoice PDFs, whose stored URL users open directly.
        ...(input.filename !== undefined && {
          ContentDisposition: `inline; filename="${input.filename.replace(/"/g, '')}"`,
        }),
      },
      abortController: controller,
    });
    await upload.done();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AppError(
        504,
        'internal_error',
        `Upload timed out after ${input.timeoutMs / 1000}s — try a smaller file or retry.`,
      );
    }
    throw new AppError(
      502,
      'internal_error',
      `S3 upload failed: ${(err as Error)?.message ?? 'unknown error'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const s3Driver: StorageDriver = {
  name: 's3',

  isConfigured(): boolean {
    return Boolean(env.S3_BUCKET && env.S3_PUBLIC_BASE_URL);
  },

  async upload(body, opts: UploadOptions): Promise<UploadResult> {
    if (!this.isConfigured()) {
      throw new AppError(
        503,
        'internal_error',
        'Media uploads are not configured (missing S3 configuration).',
      );
    }
    const visibility = opts.visibility ?? 'public';
    const wantsVideo = opts.resourceType === 'video';

    // Video takes the temp-file path: ffprobe needs a path on disk anyway, and streaming
    // through a file keeps peak memory flat instead of holding a 100MB reel in the heap.
    if (wantsVideo || opts.videoThumbnail === true) {
      return uploadVideo(body, opts, visibility);
    }

    const buffer = Buffer.isBuffer(body) ? body : await collect(body);
    const contentType = await sniffContentType(buffer, opts.contentType);
    const dims = imageDimensions(buffer);
    const publicId = buildObjectKey({
      folder: opts.folder,
      publicId: opts.publicId,
      contentType,
    });

    await putObject({
      body: buffer,
      key: fullKey(publicId, visibility),
      contentType,
      filename: opts.filename,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });

    return {
      url: visibility === 'private' ? '' : publicUrlFor(publicId),
      publicId,
      width: dims?.width,
      height: dims?.height,
      format: contentType.split('/')[1],
      bytes: buffer.length,
      resourceType: kindFor(contentType, opts.resourceType),
      contentType,
    };
  },

  async delete(publicId: string): Promise<void> {
    // DeleteObject is idempotent — a missing key succeeds, matching the old Cloudinary
    // behaviour where a stale publicId resolved silently.
    try {
      await s3().send(
        new DeleteObjectCommand({
          Bucket: env.S3_BUCKET as string,
          Key: withKeyPrefix(publicId, env.S3_KEY_PREFIX),
        }),
      );
    } catch (err) {
      throw new AppError(
        502,
        'internal_error',
        `S3 delete failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
  },

  async signedReadUrl(publicId: string, expiresInSec = DEFAULT_SIGNED_URL_TTL_SEC) {
    // Private objects live under their own prefix; try that first, since only private
    // objects have a reason to be signed.
    const key = publicId.startsWith(`${PRIVATE_PREFIX}/`)
      ? withKeyPrefix(publicId, env.S3_KEY_PREFIX)
      : fullKey(publicId, 'private');
    return getSignedUrl(
      s3(),
      new GetObjectCommand({ Bucket: env.S3_BUCKET as string, Key: key }),
      { expiresIn: expiresInSec },
    );
  },

  publicUrl(publicId: string): string {
    return publicUrlFor(publicId);
  },
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

async function uploadVideo(
  body: Buffer | Readable,
  opts: UploadOptions,
  visibility: 'public' | 'private',
): Promise<UploadResult> {
  const { path, cleanup } = await toTempFile(body, '.video');
  try {
    const declared = opts.contentType;
    // Sniff from the head of the file rather than reading the whole thing back in.
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'r');
    let head: Buffer;
    let bytes: number;
    try {
      const stat = await handle.stat();
      bytes = stat.size;
      head = Buffer.alloc(Math.min(8192, bytes));
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
    const contentType = await sniffContentType(head, declared);
    const probe = await videoProbe(path);

    const publicId = buildObjectKey({
      folder: opts.folder,
      publicId: opts.publicId,
      contentType,
    });

    const { createReadStream } = await import('node:fs');
    await putObject({
      body: createReadStream(path),
      key: fullKey(publicId, visibility),
      contentType,
      filename: opts.filename,
      timeoutMs: VIDEO_UPLOAD_TIMEOUT_MS,
    });

    let thumbnailUrl: string | undefined;
    let thumbnailPublicId: string | undefined;
    if (opts.videoThumbnail === true) {
      const poster = await videoPoster(path);
      if (poster) {
        thumbnailPublicId = thumbnailKeyFor(publicId);
        await putObject({
          body: poster,
          key: fullKey(thumbnailPublicId, visibility),
          contentType: 'image/jpeg',
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        thumbnailUrl = visibility === 'private' ? '' : publicUrlFor(thumbnailPublicId);
      }
    }

    return {
      url: visibility === 'private' ? '' : publicUrlFor(publicId),
      publicId,
      width: probe.width ?? undefined,
      height: probe.height ?? undefined,
      format: contentType.split('/')[1],
      bytes,
      resourceType: kindFor(contentType, opts.resourceType),
      duration: probe.durationSec ?? undefined,
      contentType,
      thumbnailUrl,
      thumbnailPublicId,
    };
  } finally {
    await cleanup();
  }
}
