/**
 * The KYC deadline sweep. Until now `overdue` had ZERO writers — the status existed,
 * `dueAt`/`gracePeriodEndsAt` were written on every cycle, and nothing ever read them.
 * The "KYC overdue" critical banner could never fire and the auto-pause that
 * `platform_config.kyc_grace_period_days` documents was never built.
 *
 * Two passes, both idempotent:
 *   1. a cycle still awaiting the RETAILER, past `dueAt`  → `overdue` (+ notify)
 *   2. an `overdue` cycle past `gracePeriodEndsAt`        → auto-pause the store
 *
 * Deliberately does NOT mark a `submitted` cycle overdue: the ball is with the admin,
 * and a retailer must never be penalised for the reviewer's backlog.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { kycReverifications } from '@/db/schema/index.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import { pauseStoreForKyc } from './enforcement.js';

export type KycSweepCounts = { markedOverdue: number; storesPaused: number };

export async function sweepKycDeadlines(database: typeof Db): Promise<KycSweepCounts> {
  const now = new Date();
  const counts: KycSweepCounts = { markedOverdue: 0, storesPaused: 0 };

  // 1. Past due while still awaiting the retailer → overdue.
  const due = await database.query.kycReverifications.findMany({
    where: and(
      inArray(kycReverifications.status, ['pending', 'rejected']),
      lt(kycReverifications.dueAt, now),
    ),
    columns: { id: true, storeId: true },
  });
  for (const cycle of due) {
    await database
      .update(kycReverifications)
      .set({ status: 'overdue' })
      .where(eq(kycReverifications.id, cycle.id));
    counts.markedOverdue += 1;
    await notifyStoreAccounts({
      storeId: cycle.storeId,
      kind: 'kyc',
      title: 'KYC re-verification overdue',
      body: 'Your KYC documents are past their due date. Submit them before the grace period ends or your store will be paused.',
      deepLink: '/retailer/store/kyc',
    }).catch(() => undefined);
  }

  // 2. Overdue past the grace period → pause the store (no new orders; existing ones
  //    still fulfil). pauseStoreForKyc no-ops unless the store is currently active.
  const lapsed = await database.query.kycReverifications.findMany({
    where: and(
      eq(kycReverifications.status, 'overdue'),
      lt(kycReverifications.gracePeriodEndsAt, now),
    ),
    columns: { id: true, storeId: true },
  });
  for (const cycle of lapsed) {
    if (await pauseStoreForKyc(database, cycle.storeId)) counts.storesPaused += 1;
  }

  return counts;
}
