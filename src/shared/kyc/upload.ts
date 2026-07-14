/**
 * The single guard + upsert for a KYC document upload.
 *
 * There are TWO retailer upload routes — `/retailer/kyc/:id/documents` (by kind) and
 * `/retailer/store/documents/:id/upload` (by document id). The second had NO cycle-status
 * guard at all, so a retailer could overwrite a document on an approved cycle and silently
 * flip a `verified` doc back to `pending_review`. Both now go through the guard here so it
 * cannot drift again.
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { kycDocuments } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { isWritableCycle } from './state.js';

/** Uploads are only accepted while the cycle awaits the retailer (pending/rejected/overdue). */
export function assertCycleAcceptsUploads(status: string): void {
  if (!isWritableCycle(status)) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      status === 'submitted'
        ? 'This KYC cycle is under review — wait for the outcome before changing documents'
        : 'This KYC cycle is closed and is not accepting uploads',
    );
  }
}

/**
 * Upsert a document by kind. A re-upload of a rejected document returns it to
 * `pending_review`, which is what lets the retailer fix only what actually failed.
 */
export async function upsertKycDocument(
  database: typeof Db,
  cycleId: string,
  kind: string,
  url: string,
) {
  const existing = await database.query.kycDocuments.findFirst({
    where: and(eq(kycDocuments.reverificationId, cycleId), eq(kycDocuments.kind, kind)),
  });
  const now = new Date();
  if (existing) {
    const [doc] = await database
      .update(kycDocuments)
      .set({
        url,
        status: 'pending_review',
        uploadedAt: now,
        // A fresh file supersedes the previous review outcome.
        reviewedAt: null,
        reviewerNote: null,
      })
      .where(eq(kycDocuments.id, existing.id))
      .returning();
    return doc;
  }
  const [doc] = await database
    .insert(kycDocuments)
    .values({
      id: newId(IdPrefix.KycDocument),
      reverificationId: cycleId,
      kind,
      url,
      status: 'pending_review',
      uploadedAt: now,
    })
    .returning();
  return doc;
}
