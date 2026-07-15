/**
 * Account-level terminate/reinstate with the store cascade — ONE implementation.
 *
 * Two endpoints exist for the same intent (`POST /admin/retailers/:id/terminate` from
 * the retailers list, `POST /admin/retailers/:id/ban` from the retailer detail page)
 * and each used to carry its own copy of this logic. Worse, they were asymmetric:
 * ban terminated EVERY store owned by the retailer (matched by legalEntityId) while
 * unban restored only the single `retailer.storeId`.
 *
 * Cascade rules (each direction is the exact inverse of the other):
 *  - Terminating an account terminates its onboarding/active/paused stores, stamping
 *    `suspendReason` with the `account_termination[<prior-status>]:` marker so the
 *    reinstate can tell WHICH stores this cascade killed and what they were before.
 *  - An independently SUSPENDED store is left suspended (the account lock already cuts
 *    access; its own suspension — and reason — must survive an account round-trip).
 *  - An independently TERMINATED store carries no marker and is never revived by an
 *    account reinstate — a store banned for cause stays banned.
 *  - Reinstate restores marker-bearing stores to their PRIOR status (onboarding goes
 *    back to onboarding, not straight to active — the go-live gate still applies).
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { accountTransition, storeTransition } from './transitions.js';

const CASCADE_MARKER = 'account_termination';
const MARKER_RE = /^account_termination\[(onboarding|active|paused)\]:/;

export async function terminateRetailerCascade(
  database: typeof Db,
  retailerId: string,
  opts: { reason: string; actorId: string },
): Promise<typeof retailerAccounts.$inferSelect> {
  const retailer = await database.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  // Central guard: throws 409 'Cannot terminate an account in …' when already terminated.
  const accountPatch = accountTransition(retailer.status, 'terminate', opts);

  const updated = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(retailerAccounts)
      .set(accountPatch)
      .where(eq(retailerAccounts.id, retailer.id))
      .returning();
    // Per-store so each marker can encode that store's prior status. Store count per
    // retailer is 1 in the MVP; the loop stays correct if that ever grows.
    const stores = await tx.query.retailerStores.findMany({
      where: and(
        eq(retailerStores.legalEntityId, retailer.id),
        inArray(retailerStores.status, ['onboarding', 'active', 'paused']),
      ),
      columns: { id: true, status: true },
    });
    for (const store of stores) {
      await tx
        .update(retailerStores)
        .set(
          storeTransition(store.status, 'terminate', {
            reason: `${CASCADE_MARKER}[${store.status}]: ${opts.reason}`,
            actorId: opts.actorId,
          }),
        )
        .where(eq(retailerStores.id, store.id));
    }
    return row!;
  });
  return updated;
}

export async function reinstateRetailerCascade(
  database: typeof Db,
  retailerId: string,
): Promise<typeof retailerAccounts.$inferSelect> {
  const retailer = await database.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  // Central guard: only a terminated account can be reinstated. This is deliberately
  // STATUS-based, which also unlocks accounts terminated via reject / staff-deactivate /
  // policy enforcement — paths the old boolean-keyed guard refused ("Retailer is not
  // banned") even though the middleware had locked them out.
  const accountPatch = accountTransition(retailer.status, 'reinstate');

  const updated = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(retailerAccounts)
      .set(accountPatch)
      .where(eq(retailerAccounts.id, retailer.id))
      .returning();
    // ONLY stores this cascade terminated (identified by the marker) are revived —
    // a store independently banned for cause carries no marker and stays terminated.
    const killed = await tx.query.retailerStores.findMany({
      where: and(
        eq(retailerStores.legalEntityId, retailer.id),
        eq(retailerStores.status, 'terminated'),
        like(retailerStores.suspendReason, `${CASCADE_MARKER}[%`),
      ),
      columns: { id: true, suspendReason: true },
    });
    for (const store of killed) {
      const prior = MARKER_RE.exec(store.suspendReason ?? '')?.[1];
      if (prior === 'onboarding') {
        // Back to where it was — NOT straight to active; go-live gating still applies.
        await tx
          .update(retailerStores)
          .set({
            status: 'onboarding',
            suspendReason: null,
            suspendedAt: null,
            suspendedByAccountId: null,
          })
          .where(eq(retailerStores.id, store.id));
      } else {
        await tx
          .update(retailerStores)
          .set(storeTransition('terminated', 'reinstate'))
          .where(eq(retailerStores.id, store.id));
      }
    }
    return row!;
  });
  return updated;
}
