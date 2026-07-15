/**
 * The consequence of an ignored KYC cycle: once the grace period lapses the store is
 * PAUSED. Paused means "no new orders, existing orders still fulfil" —
 * `compute-quote.ts` already throws for any non-`active` store (so the cart preview and
 * order placement both refuse it), while retailer order fulfilment gates on the ACCOUNT
 * status, not the store. So this reuses the real lever; there is no new gate to build.
 *
 * `pauseReason` is the marker that separates an automatic KYC pause from a manual admin
 * pause — a KYC approval must never un-pause a store an admin paused deliberately.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { retailerStores } from '@/db/schema/index.js';
import { recordAudit, type AuditParams } from '@/shared/audit.js';
import { storeTransition } from '@/shared/lifecycle/transitions.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';

/** Marker written to `retailer_stores.pause_reason` by the KYC auto-pause. */
export const KYC_PAUSE_REASON = 'kyc_overdue';

const SYSTEM_ACTOR = { kind: 'system', sub: 'system' } as unknown as AuditParams['actor'];

/**
 * Pause a store whose KYC went past its grace period. Only an `active` store can be
 * paused; anything else (onboarding / already paused / suspended / terminated) is left
 * alone. Idempotent — a store already paused for KYC is a no-op.
 */
export async function pauseStoreForKyc(database: typeof Db, storeId: string): Promise<boolean> {
  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
    columns: { id: true, status: true, legalName: true, pauseReason: true },
  });
  if (!store || store.status !== 'active') return false;

  await database
    .update(retailerStores)
    .set(
      // Stay listed, but un-buyable: the store can still fulfil what it already sold.
      storeTransition(store.status, 'pause', {
        reason: KYC_PAUSE_REASON,
        visibility: 'visible',
      }),
    )
    .where(eq(retailerStores.id, store.id));

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'store.pause',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: { status: store.status },
    after: { status: 'paused', pauseReason: KYC_PAUSE_REASON },
    impersonatedStoreId: store.id,
    note: 'KYC re-verification overdue past its grace period',
  }).catch(() => undefined);

  await notifyStoreAccounts({
    storeId: store.id,
    kind: 'kyc',
    title: 'Store paused — KYC overdue',
    body: 'Your KYC re-verification is past its grace period, so your store has been paused. You can still fulfil existing orders, but you will not receive new ones until KYC is approved.',
    deepLink: '/retailer/store/kyc',
  }).catch(() => undefined);

  return true;
}

/**
 * Undo a KYC auto-pause once the cycle is approved. Deliberately refuses to touch a
 * store that a human paused (or suspended/terminated) — only a pause this module
 * created, identified by `pauseReason`, is lifted.
 *
 * The `retailer_stores` CHECK constraint requires the pause columns to be NULL whenever
 * status is not 'paused', so they must all be cleared here.
 */
export async function resumeStoreAfterKyc(database: typeof Db, storeId: string): Promise<boolean> {
  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
    columns: { id: true, status: true, pauseReason: true },
  });
  if (!store || store.status !== 'paused' || store.pauseReason !== KYC_PAUSE_REASON) return false;

  await database
    .update(retailerStores)
    .set(storeTransition(store.status, 'resume'))
    .where(eq(retailerStores.id, store.id));

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'store.resume',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: { status: 'paused', pauseReason: KYC_PAUSE_REASON },
    after: { status: 'active' },
    impersonatedStoreId: store.id,
    note: 'KYC re-verification approved',
  }).catch(() => undefined);

  return true;
}
