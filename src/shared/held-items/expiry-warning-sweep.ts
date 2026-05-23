import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { heldItems, platformConfig } from '@/db/schema/index.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';

/**
 * Sweep helper. Finds held_items in 'holding' approaching their expiry threshold
 * (now + holding_window_warning_days_before_expiry), fans out one inbox notification
 * per retailer account on the store, and stamps warningNotifiedAt so subsequent ticks
 * skip the row. Idempotent under crash: rows whose UPDATE didn't commit get retried
 * on the next tick.
 *
 * Registered as a setInterval in server.ts (15 min cadence — held-window warnings
 * are not minute-sensitive).
 */
const DEFAULT_WARN_DAYS = 3;
const TICK_LIMIT = 200;

export async function processHeldItemExpiryWarningSweep(): Promise<{ warned: number }> {
  const cfg = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'holding_window_warning_days_before_expiry'),
  });
  const warnDays =
    cfg && typeof cfg.value === 'number' && cfg.value > 0 ? cfg.value : DEFAULT_WARN_DAYS;

  const now = new Date();
  const threshold = new Date(now.getTime() + warnDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: heldItems.id,
      storeId: heldItems.storeId,
      returnId: heldItems.returnId,
      holdingWindowExpiresAt: heldItems.holdingWindowExpiresAt,
    })
    .from(heldItems)
    .where(
      and(
        eq(heldItems.status, 'holding'),
        isNull(heldItems.warningNotifiedAt),
        lte(heldItems.holdingWindowExpiresAt, threshold),
      ),
    )
    .limit(TICK_LIMIT);

  let warned = 0;
  for (const r of rows) {
    await notifyStoreAccounts({
      storeId: r.storeId,
      kind: 'system',
      title: 'Held item expiring soon',
      body: `Held item ${r.id} expires ${r.holdingWindowExpiresAt.toISOString().slice(0, 10)}. Restock, redeliver, or record disposition before then.`,
      deepLink: '/retailer/held-items',
      payload: { heldItemId: r.id, returnId: r.returnId },
    });
    // Stamp after the fan-out commits. If a stamp fails, the next tick reruns
    // notify (rare-but-acceptable duplicate); if notify fails, we never stamp.
    await db
      .update(heldItems)
      .set({ warningNotifiedAt: sql`now()` })
      .where(eq(heldItems.id, r.id));
    warned += 1;
  }

  return { warned };
}
