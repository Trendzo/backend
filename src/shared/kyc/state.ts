/**
 * The KYC cycle state machine, in one place so no guard can drift from another.
 *
 *   pending ──submit──▶ submitted ──per-doc review──▶ approved   (terminal)
 *      │                    │                    └──▶ rejected
 *      │                    └────────────────────────────┘
 *      │        retailer re-uploads the rejected docs, re-submits (same cycle)
 *      │
 *      └──dueAt passes──▶ overdue ──submit──▶ submitted
 *                            └── gracePeriodEndsAt passes ──▶ store auto-paused
 *
 * The load-bearing rule: `rejected` is a WORKING state, not a dead end. Previously
 * upload + submit both required `pending`, so a rejected retailer was 409'd on both
 * and the only escape was an admin re-trigger that discarded all their documents.
 */
export type KycCycleStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'overdue';
export type KycDocStatus = 'missing' | 'pending_review' | 'verified' | 'rejected';

/** Cycle states in which the retailer may upload documents and submit. */
const WRITABLE: ReadonlySet<string> = new Set<KycCycleStatus>(['pending', 'rejected', 'overdue']);

/** Cycle states an admin may review/decide. Review only happens after submission. */
const DECIDABLE: ReadonlySet<string> = new Set<KycCycleStatus>(['submitted']);

/** Cycle states that still await the RETAILER — these are what can go overdue. */
const AWAITING_RETAILER: ReadonlySet<string> = new Set<KycCycleStatus>([
  'pending',
  'rejected',
  'overdue',
]);

export function isWritableCycle(status: string): boolean {
  return WRITABLE.has(status);
}

export function isDecidableCycle(status: string): boolean {
  return DECIDABLE.has(status);
}

export function awaitsRetailer(status: string): boolean {
  return AWAITING_RETAILER.has(status);
}

/**
 * A cycle may be submitted once every required document is uploaded and none is
 * still rejected. `verified` documents survive a resubmission — the retailer only
 * has to replace what actually failed.
 */
export function canSubmit(docs: { kind: string; status: string }[], requiredKinds: readonly string[]): boolean {
  return requiredKinds.every((kind) => {
    const doc = docs.find((d) => d.kind === kind);
    return !!doc && (doc.status === 'pending_review' || doc.status === 'verified');
  });
}

/** An approval requires every required document to be individually verified. */
export function allRequiredVerified(
  docs: { kind: string; status: string }[],
  requiredKinds: readonly string[],
): boolean {
  return requiredKinds.every((kind) => docs.find((d) => d.kind === kind)?.status === 'verified');
}
