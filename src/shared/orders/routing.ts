/**
 * Order routing (MODULES.md §8 Order Routing + Acceptance Window).
 *
 * MVP model: each order is created for a specific store at placement time
 * (consumer chose that store's variant), so "routing" here is the acceptance-
 * window timer + reroute audit trail. `dispatchOrder()` is idempotent and
 * stamps `acceptanceDeadlineAt` + a `pending` entry in `routingHistory`.
 * `rerouteOrder()` is the explicit admin / sweeper-driven transition that
 * marks the current candidate as `rejected` or `timeout` and either picks the
 * next candidate (currently a no-op — single-candidate orders) or moves the
 * order to `cancelled` once `routing_max_attempts` is reached.
 *
 * Cancellation through this path writes a transition with `reason='routing_exhausted'`.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db as Db } from '@/db/client.js';
import { orders, platformConfig } from '@/db/schema/index.js';

const DEFAULT_ACCEPTANCE_WINDOW_SECONDS = 180;
const DEFAULT_ROUTING_MAX_ATTEMPTS = 3;

async function readConfigNumber(key: string, fallback: number): Promise<number> {
  const row = await Db.query.platformConfig.findFirst({ where: eq(platformConfig.key, key) });
  if (!row) return fallback;
  return typeof row.value === 'number' ? (row.value as number) : fallback;
}

/**
 * Idempotent. Sets `acceptanceDeadlineAt` and appends one `pending` row to
 * `routingHistory` if this is the first dispatch. Re-calls are no-ops.
 */
export async function dispatchOrder(orderId: string): Promise<void> {
  const order = await Db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) return;
  if (order.acceptanceDeadlineAt) return; // already dispatched
  const acceptanceWindowSeconds = await readConfigNumber(
    'acceptance_window_seconds',
    DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  );
  const deadline = new Date(Date.now() + acceptanceWindowSeconds * 1000);
  const history = (order.routingHistory ?? []) as Array<{
    candidateStoreId: string;
    decidedAt: string;
    decision: 'accepted' | 'rejected' | 'timeout' | 'pending';
    reason?: string;
  }>;
  history.push({
    candidateStoreId: order.storeId,
    decidedAt: new Date().toISOString(),
    decision: 'pending',
  });
  await Db.update(orders)
    .set({ acceptanceDeadlineAt: deadline, routingHistory: history })
    .where(eq(orders.id, orderId));
}

/**
 * Mark the current candidate as `rejected` or `timeout`; increment routingAttempts;
 * cancel the order once max attempts is reached.
 *
 * Returns the final routing decision so callers (sweeper / admin) can branch.
 */
export interface RerouteResult {
  orderId: string;
  attempts: number;
  cancelled: boolean;
}

export async function rerouteOrder(
  orderId: string,
  reason: 'timeout' | 'rejected',
  actorSub: string | null = null,
): Promise<RerouteResult> {
  const order = await Db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.status !== 'pending' && order.status !== 'routing') {
    return { orderId, attempts: order.routingAttempts, cancelled: false };
  }

  const maxAttempts = await readConfigNumber('routing_max_attempts', DEFAULT_ROUTING_MAX_ATTEMPTS);
  const history = (order.routingHistory ?? []) as Array<{
    candidateStoreId: string;
    decidedAt: string;
    decision: 'accepted' | 'rejected' | 'timeout' | 'pending';
    reason?: string;
  }>;
  // Update the most recent pending entry (or the last entry) to reflect the rejection.
  if (history.length > 0) {
    const last = history[history.length - 1]!;
    last.decision = reason;
    last.decidedAt = new Date().toISOString();
    last.reason = reason === 'timeout' ? 'acceptance_window_expired' : 'retailer_rejected';
  }
  const nextAttempts = order.routingAttempts + 1;

  if (nextAttempts >= maxAttempts) {
    // Out of retries — cancel via the orchestrator (releases reservations, fails
    // pending payments, creates the cancellation refund), not a raw transition.
    await Db.update(orders)
      .set({ routingAttempts: nextAttempts, routingHistory: history })
      .where(eq(orders.id, orderId));
    const { cancelOrder } = await import('./cancel.js');
    await cancelOrder(Db, {
      orderId,
      actorType: actorSub ? 'admin' : 'system',
      actorId: actorSub ?? 'system',
      reason: 'routing_exhausted',
      metadata: { attempts: nextAttempts, lastReason: reason },
    });
    return { orderId, attempts: nextAttempts, cancelled: true };
  }

  // Still have budget — extend the acceptance window and stay pending.
  const acceptanceWindowSeconds = await readConfigNumber(
    'acceptance_window_seconds',
    DEFAULT_ACCEPTANCE_WINDOW_SECONDS,
  );
  const newDeadline = new Date(Date.now() + acceptanceWindowSeconds * 1000);
  history.push({
    candidateStoreId: order.storeId,
    decidedAt: new Date().toISOString(),
    decision: 'pending',
  });
  await Db.update(orders)
    .set({
      routingAttempts: nextAttempts,
      acceptanceDeadlineAt: newDeadline,
      routingHistory: history,
    })
    .where(eq(orders.id, orderId));
  return { orderId, attempts: nextAttempts, cancelled: false };
}

/** Find pending orders whose acceptance window has expired. */
export async function findExpiredAcceptances(): Promise<
  Array<{
    id: string;
    storeId: string;
    acceptanceDeadlineAt: Date;
    routingAttempts: number;
  }>
> {
  const rows = await Db.select({
    id: orders.id,
    storeId: orders.storeId,
    acceptanceDeadlineAt: orders.acceptanceDeadlineAt,
    routingAttempts: orders.routingAttempts,
  })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ['pending', 'routing']),
        sql`${orders.acceptanceDeadlineAt} IS NOT NULL`,
        lt(orders.acceptanceDeadlineAt, new Date()),
      ),
    )
    .limit(100);
  return rows
    .filter((r): r is { id: string; storeId: string; acceptanceDeadlineAt: Date; routingAttempts: number } =>
      r.acceptanceDeadlineAt !== null,
    );
}

/**
 * Sweeper. Process all expired acceptance windows. Wire from app boot via
 * `setInterval` (60s default). Safe to call concurrently across pods — each
 * reroute uses a single UPDATE so the loser sees `status !== 'pending'`.
 */
export async function processAcceptanceWindowSweep(): Promise<{ swept: number; cancelled: number }> {
  const expired = await findExpiredAcceptances();
  let cancelled = 0;
  for (const row of expired) {
    try {
      const r = await rerouteOrder(row.id, 'timeout', null);
      if (r.cancelled) cancelled++;
    } catch (e) {
      // Best-effort sweeper — log and continue.
      // eslint-disable-next-line no-console
      console.error('[acceptance-sweep] failed for', row.id, (e as Error).message);
    }
  }
  return { swept: expired.length, cancelled };
}
