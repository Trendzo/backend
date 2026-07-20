import type { Readable } from 'node:stream';
import { buildObjectKey, thumbnailKeyFor } from '../keys.js';
import { imageDimensions, sniffContentType } from '../probe.js';
import type { ResourceKind, StorageDriver, UploadOptions, UploadResult } from '../types.js';

/**
 * In-process storage. Keeps the test suite hermetic: key derivation, sniffing, the size
 * and format guards, and the error mapping are all exercised for real, while nothing
 * touches the network.
 *
 * This is a real third value of `STORAGE_DRIVER`, not test-only scaffolding — which is
 * why it lives beside the other drivers rather than under test/.
 */

const BASE = 'https://memory.test';

type StoredObject = { body: Buffer; contentType: string };

/** Exposed so tests can assert on what was written, and reset between cases. */
export const memoryObjects = new Map<string, StoredObject>();

function kindFor(contentType: string, requested: ResourceKind | undefined): string {
  if (requested !== undefined && requested !== 'auto') return requested;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'raw';
}

async function collect(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

export const memoryDriver: StorageDriver = {
  name: 'memory',

  isConfigured(): boolean {
    return true;
  },

  async upload(body, opts: UploadOptions): Promise<UploadResult> {
    const buffer = await collect(body);
    const contentType = await sniffContentType(buffer, opts.contentType);
    const dims = imageDimensions(buffer);
    const publicId = buildObjectKey({
      folder: opts.folder,
      publicId: opts.publicId,
      contentType,
    });
    memoryObjects.set(publicId, { body: buffer, contentType });

    let thumbnailUrl: string | undefined;
    let thumbnailPublicId: string | undefined;
    if (opts.videoThumbnail === true) {
      thumbnailPublicId = thumbnailKeyFor(publicId);
      memoryObjects.set(thumbnailPublicId, {
        body: Buffer.alloc(0),
        contentType: 'image/jpeg',
      });
      thumbnailUrl = `${BASE}/${thumbnailPublicId}`;
    }

    return {
      url: `${BASE}/${publicId}`,
      publicId,
      width: dims?.width,
      height: dims?.height,
      format: contentType.split('/')[1],
      bytes: buffer.length,
      resourceType: kindFor(contentType, opts.resourceType),
      contentType,
      thumbnailUrl,
      thumbnailPublicId,
    };
  },

  async delete(publicId: string): Promise<void> {
    memoryObjects.delete(publicId);
  },

  async signedReadUrl(publicId: string, expiresInSec = 300): Promise<string> {
    return `${BASE}/${publicId}?signed=1&expires=${expiresInSec}`;
  },

  publicUrl(publicId: string): string {
    return `${BASE}/${publicId}`;
  },
};
