/**
 * ONE wire shape for a KYC cycle, used by the admin and the retailer endpoints alike.
 *
 * The old admin/retailer serializers each dropped fields that exist in the DB and are
 * written on every decision — `decisionReason` on the cycle, `reviewerNote`/`reviewedAt`
 * per document. That is why a rejected retailer could never see WHY they failed. Both
 * are projected here.
 */
import { kycDocLabel } from './doc-kinds.js';

export type KycCycleRow = {
  id: string;
  storeId: string;
  status: string;
  dueAt: Date;
  gracePeriodEndsAt: Date;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedByAccountId: string | null;
  decisionReason: string | null;
  lastVerifiedAt: Date | null;
  documents: Array<{
    id: string;
    kind: string;
    url: string | null;
    status: string;
    uploadedAt: Date | null;
    reviewedAt?: Date | null;
    reviewerNote?: string | null;
  }>;
};

export function shapeKycCycle(row: KycCycleRow, store?: { legalName: string } | null) {
  return {
    id: row.id,
    storeId: row.storeId,
    storeName: store?.legalName ?? null,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    gracePeriodEndsAt: row.gracePeriodEndsAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByAccountId: row.decidedByAccountId,
    /** Why the cycle was rejected — the retailer needs this to act on it. */
    decisionReason: row.decisionReason,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    documents: row.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: kycDocLabel(d.kind),
      status: d.status,
      uploadedAt: d.uploadedAt?.toISOString() ?? null,
      fileUrl: d.url,
      /** Per-document review outcome — what the retailer must fix, and why. */
      reviewedAt: d.reviewedAt?.toISOString() ?? null,
      reviewerNote: d.reviewerNote ?? null,
    })),
  };
}
