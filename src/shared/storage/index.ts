import type { Readable } from 'node:stream';
import { env } from '@/config/env.js';
import { cloudinaryDriver } from './drivers/cloudinary.driver.js';
import type { ResourceKind, StorageDriver, UploadOptions, UploadResult } from './types.js';

/**
 * The single upload service. Every module that stores or removes a file goes through
 * here — no other file in the codebase may import a storage vendor SDK (enforced by the
 * `no-restricted-imports` ESLint rule).
 *
 * Which backend runs is `STORAGE_DRIVER`, resolved once at module load. Flipping it needs
 * no code change, which is what makes the S3 rollout revertible with an env var and a
 * restart.
 */

function resolveDriver(): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 'cloudinary':
      return cloudinaryDriver;
    case 's3':
    case 'memory':
      // Implementations land in a later step; until then the enum value is accepted but
      // still resolves to the legacy driver, so nothing can silently run half-migrated.
      return cloudinaryDriver;
  }
}

const driver = resolveDriver();

/** Which backend is live. Useful in logs and tests. */
export const storageDriverName = driver.name;

/**
 * Store bytes and return the canonical URL plus the metadata callers persist.
 *
 * Accepts a stream so large uploads (reels) needn't be held in memory; drivers that can
 * only take a buffer collect it themselves.
 */
export function uploadObject(
  body: Buffer | Readable,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  return driver.upload(body, opts);
}

/** Remove an object. Missing keys are a no-op, matching the previous behaviour. */
export function deleteObject(
  publicId: string,
  kind: Exclude<ResourceKind, 'auto'> = 'image',
): Promise<void> {
  return driver.delete(publicId, kind);
}

/** Short-lived read URL for a `private` object. */
export function getSignedReadUrl(publicId: string, expiresInSec?: number): Promise<string> {
  return driver.signedReadUrl(publicId, expiresInSec);
}

/** The stable unauthenticated URL for a `public` object. */
export function publicUrlFor(publicId: string): string {
  return driver.publicUrl(publicId);
}

/**
 * Whether uploads can actually run. Replaces the six copies of `isCloudinaryConfigured()`
 * that were scattered across the invoicing, settlement and POS modules — those call sites
 * degrade gracefully (skip PDF archival) rather than failing the request, so they need to
 * ask before trying.
 */
export function isStorageConfigured(): boolean {
  return driver.isConfigured();
}

export type { UploadOptions, UploadResult, ResourceKind, Visibility } from './types.js';
