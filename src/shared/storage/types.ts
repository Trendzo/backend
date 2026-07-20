import type { Readable } from 'node:stream';

/**
 * How the bytes are treated. Mirrors Cloudinary's `resource_type` vocabulary because
 * `store_media.resource_type` persists these values as a column AND filters on them
 * (see media.controller.ts) — changing the words would silently break the media-library
 * type filter against existing rows.
 */
export type ResourceKind = 'image' | 'video' | 'raw' | 'auto';

/**
 * `public` objects are readable at `S3_PUBLIC_BASE_URL/<key>` with no credentials —
 * required for anything an external service fetches server-side (Google Vertex pulls
 * AI try-on inputs this way). `private` objects have no public URL at all and are read
 * only through a short-lived signed URL.
 */
export type Visibility = 'public' | 'private';

export type UploadOptions = {
  /** Logical prefix, e.g. `closetx/reels`. Normalised; the `closetx/` stem is stripped. */
  folder?: string | undefined;
  /**
   * Deterministic key stem. When set, re-uploading overwrites the same object — this is
   * what invoice reissue relies on. Omit for a generated, collision-free key.
   */
  publicId?: string | undefined;
  resourceType?: ResourceKind | undefined;
  /** Client-declared content type. A hint only — sniffed bytes win. */
  contentType?: string | undefined;
  /** Original filename. Used for Content-Disposition, never for the extension. */
  filename?: string | undefined;
  /** Defaults to `public`. */
  visibility?: Visibility | undefined;
  /** Render and store a poster frame as a second object. Video only. */
  videoThumbnail?: boolean | undefined;
};

export type UploadResult = {
  url: string;
  /** The storage key. Under the S3 driver this is the object key minus `S3_KEY_PREFIX`. */
  publicId: string;
  width?: number | undefined;
  height?: number | undefined;
  format?: string | undefined;
  bytes: number;
  resourceType: string;
  /** Video duration in seconds (video uploads only). */
  duration?: number | undefined;
  /** Resolved content type — sniffed from the bytes, not the client's claim. */
  contentType?: string | undefined;
  /** Set when `videoThumbnail` was requested and a poster frame was stored. */
  thumbnailUrl?: string | undefined;
  thumbnailPublicId?: string | undefined;
};

/**
 * The contract every backend satisfies. Only files under `drivers/` may import a vendor
 * SDK; everything else in the codebase goes through `shared/storage/index.ts`.
 */
export interface StorageDriver {
  readonly name: 'cloudinary' | 's3' | 'memory';
  /** False when required config is missing. Callers that degrade gracefully check this. */
  isConfigured(): boolean;
  upload(body: Buffer | Readable, opts: UploadOptions): Promise<UploadResult>;
  delete(publicId: string, kind?: Exclude<ResourceKind, 'auto'>): Promise<void>;
  /** Short-lived read URL for a `private` object. */
  signedReadUrl(publicId: string, expiresInSec?: number): Promise<string>;
  /** The stable unauthenticated URL for a `public` object. */
  publicUrl(publicId: string): string;
}
