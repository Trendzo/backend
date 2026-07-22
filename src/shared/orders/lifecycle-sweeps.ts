/**
 * Lifecycle janitors — six idempotent sweeps that end every order/return/held-item
 * state nothing else ends. Wired as one 60s setInterval in server.ts (same pattern
 * as the acceptance + door-window sweeps). All batched (limit 100/tick, backlog
 * drains across ticks), per-row try/catch (one bad row never starves the rest),
 * and every mutation is UPDATE-guarded so an overlapping run loses cleanly.
 *
 *   1. auto-close        delivered → closed after the return window
 *   2. stale payments    pending/payment_failed abandoned → cancelled (+refund of
 *                        any wallet portion via cancelOrder's refund helper)
 *   3. verify window     standard returns the store sat on → auto-accept + refund
 *   4. held items        pre-expiry warning + holding → expired
 *   5. dispatch rot      unassigned-packed admin alert; stale driver claim auto-unassign
 *   6. pickup no-show    uncollected pickup orders → cancelled
 *
 * Ordering note (sweep 2): the wallet portion is debited inside the placement tx
 * even when the gateway remainder never succeeds — cancelOrder restores it. A
 * late gateway success after a sweep-cancel surfaces via payments-recon as a
 * discrepancy; `payment_abandon_minutes` (default 30) comfortably exceeds real
 * gateway pending windows.
 */
import { and, eq, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  customerIssues,
  heldItems,
  orderItems,
  orderTransitions,
  orders,
  payments,
  platformConfig,
  retailerStores,
  returns,
} from '@/db/schema/index.js';
import { markExpired } from '@/shared/held-items/dispositions.js';
import { sweepKycDeadlines } from '@/shared/kyc/sweep.js';
import { notifyAllAdmins } from '@/shared/notify-admins.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import { verifyReturn } from '@/shared/returns/verify-return.js';
import { cancelOrder } from './cancel.js';
import { OPEN_ISSUE_STATUSES } from './finalize-return.js';
import { notifyOffersChanged } from './offers-bus.js';
import { logTransitionMarker, transitionOrder } from './transition.js';

const BATCH = 100;

async function readConfigNumber(
  database: typeof Db,
  key: string,
  fallback: number,
): Promise<number> {
  const row = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, key),
  });
  if (!row) return fallback;
  return typeof row.value === 'number' ? (row.value as number) : fallback;
}

/** Latest transition into `toStatus` for an order — the true "time in status" anchor. */
async function lastEnteredStatusAt(
  database: typeof Db,
  orderId: string,
  toStatus: string,
): Promise<Date | null> {
  // NB: max() built from a raw sql`` expression comes back as a STRING — pg
  // doesn't run Drizzle's Date parser on it — so coerce to a real Date before
  // returning. Callers do date math (.getTime()) and would otherwise crash.
  const row = await database
    .select({ at: sql<string | null>`max(${orderTransitions.at})` })
    .from(orderTransitions)
    .where(and(eq(orderTransitions.orderId, orderId), eq(orderTransitions.toStatus, toStatus as never)));
  const at = row[0]?.at ?? null;
  return at ? new Date(at) : null;
}

/* ── 1. Auto-close ────────────────────────────────────────────────────────── */

/**
 * delivered → closed once the return window has fully elapsed AND nothing is
 * pending against the order (no pending returns, no open dispute). openReturn
 * requires status='delivered', so a closed order can no longer grow returns —
 * which is exactly why `order_close_after_days` must stay ≥ the return window.
 */
export async function sweepAutoCloseDelivered(database: typeof Db): Promise<number> {
  const days = await readConfigNumber(database, 'order_close_after_days', 7);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const candidates = await database.query.orders.findMany({
    where: and(eq(orders.status, 'delivered'), lt(orders.deliveredAt, cutoff)),
    columns: { id: true },
    limit: BATCH,
  });
  let closed = 0;
  for (const o of candidates) {
    try {
      const items = await database.query.orderItems.findMany({
        where: eq(orderItems.orderId, o.id),
        columns: { id: true },
      });
      const itemIds = items.map((i) => i.id);
      const rets = itemIds.length
        ? await database.query.returns.findMany({
            where: inArray(returns.orderItemId, itemIds),
            columns: { id: true, storeDecision: true },
          })
        : [];
      if (rets.some((r) => r.storeDecision === 'pending')) continue;
      const returnIds = rets.map((r) => r.id);
      const openIssues = await database.query.customerIssues.findMany({
        where: inArray(customerIssues.status, [...OPEN_ISSUE_STATUSES]),
        columns: { orderId: true, returnId: true },
      });
      const hasOpen = openIssues.some(
        (i) => i.orderId === o.id || (i.returnId && returnIds.includes(i.returnId)),
      );
      if (hasOpen) continue;
      await transitionOrder(database, {
        orderId: o.id,
        toStatus: 'closed',
        actorType: 'system',
        actorId: 'system',
        reason: 'auto_close_after_return_window',
      });
      closed += 1;
    } catch (e) {
      console.error(`[lifecycle-sweep] auto-close ${o.id}: ${(e as Error).message}`);
    }
  }
  return closed;
}

/* ── 2. Stale payments ───────────────────────────────────────────────────── */

export async function sweepStalePayments(
  database: typeof Db,
): Promise<{ pendingCancelled: number; paymentFailedCancelled: number }> {
  const abandonMinutes = await readConfigNumber(database, 'payment_abandon_minutes', 30);
  const failedAbandonHours = await readConfigNumber(database, 'payment_failed_abandon_hours', 24);
  let pendingCancelled = 0;
  let paymentFailedCancelled = 0;

  // (a) pending — never dispatched (acceptanceDeadlineAt NULL keeps us off the
  // acceptance sweep's turf) and not COD (COD confirms instantly since the COD-truth
  // change; any legacy rows are an admin call, not a janitor's).
  const pendingCutoff = new Date(Date.now() - abandonMinutes * 60_000);
  const stalePending = await database.query.orders.findMany({
    where: and(
      eq(orders.status, 'pending'),
      lt(orders.placedAt, pendingCutoff),
      isNull(orders.acceptanceDeadlineAt),
      sql`${orders.paymentMethod} <> 'cod'`,
    ),
    columns: { id: true, consumerId: true, placedAt: true, walletAppliedPaise: true },
    limit: BATCH,
  });
  for (const o of stalePending) {
    try {
      // Age from the LAST entry into 'pending' (payment_failed→pending retries write a
      // transition row; the initial pending doesn't) — never insta-cancel a fresh retry.
      const entered = (await lastEnteredStatusAt(database, o.id, 'pending')) ?? o.placedAt;
      if (entered.getTime() > pendingCutoff.getTime()) continue;
      const paid = await database.query.payments.findFirst({
        where: and(eq(payments.orderId, o.id), eq(payments.status, 'succeeded')),
        columns: { id: true },
      });
      if (paid) continue; // capture landed — the normal flow owns it now
      await cancelOrder(database, {
        orderId: o.id,
        actorType: 'system',
        actorId: 'system',
        reason: 'payment_abandoned',
      });
      pendingCancelled += 1;
      await notifyConsumer({
        consumerId: o.consumerId,
        kind: 'order',
        title: 'Order cancelled — payment not completed',
        body:
          o.walletAppliedPaise > 0
            ? 'Your payment was never completed, so we cancelled the order. The wallet amount has been returned.'
            : 'Your payment was never completed, so we cancelled the order.',
        deepLink: `/orders/${o.id}`,
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] stale-pending ${o.id}: ${(e as Error).message}`);
    }
  }

  // (b) payment_failed — abandoned retries.
  const failedCutoff = new Date(Date.now() - failedAbandonHours * 3_600_000);
  const staleFailed = await database.query.orders.findMany({
    where: and(eq(orders.status, 'payment_failed'), lt(orders.placedAt, failedCutoff)),
    columns: { id: true, consumerId: true, walletAppliedPaise: true },
    limit: BATCH,
  });
  for (const o of staleFailed) {
    try {
      const entered = await lastEnteredStatusAt(database, o.id, 'payment_failed');
      if (entered && entered.getTime() > failedCutoff.getTime()) continue;
      await cancelOrder(database, {
        orderId: o.id,
        actorType: 'system',
        actorId: 'system',
        reason: 'payment_failed_abandoned',
      });
      paymentFailedCancelled += 1;
      await notifyConsumer({
        consumerId: o.consumerId,
        kind: 'order',
        title: 'Order cancelled — payment failed',
        body:
          o.walletAppliedPaise > 0
            ? 'The payment could not be completed, so we cancelled the order. The wallet amount has been returned.'
            : 'The payment could not be completed, so we cancelled the order.',
        deepLink: `/orders/${o.id}`,
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] stale-failed ${o.id}: ${(e as Error).message}`);
    }
  }

  return { pendingCancelled, paymentFailedCancelled };
}

/* ── 3. Standard-return verification window ──────────────────────────────── */

/**
 * A store that sits on a pending standard return past its verification window
 * forfeits the decision: auto-accept (refund fires inside verifyReturn). Door
 * returns are excluded — they auto-accept on arrival at the store.
 */
export async function sweepVerificationWindows(database: typeof Db): Promise<number> {
  const now = new Date();
  const expired = await database.query.returns.findMany({
    where: and(
      eq(returns.kind, 'standard_return'),
      eq(returns.storeDecision, 'pending'),
      isNotNull(returns.verificationWindowExpiresAt),
      lt(returns.verificationWindowExpiresAt, now),
    ),
    with: { orderItem: { with: { order: { columns: { id: true, storeId: true, consumerId: true } } } } },
    limit: BATCH,
  });
  let accepted = 0;
  for (const ret of expired) {
    const order = ret.orderItem.order;
    try {
      const r = await verifyReturn(database, {
        returnId: ret.id,
        decision: 'accepted',
        reasonNote: 'verification_window_expired_auto_accept',
        actor: { type: 'system', id: 'system' },
      });
      accepted += 1;
      await notifyStoreAccounts({
        storeId: order.storeId,
        kind: 'order',
        title: 'Return auto-accepted — verification window lapsed',
        body: 'The return was not verified in time and has been accepted; the refund was issued.',
        deepLink: `/retailer/returns`,
        payload: { returnId: ret.id, refundId: r.refundId },
      }).catch(() => undefined);
      await notifyConsumer({
        consumerId: order.consumerId,
        kind: 'refund',
        title: 'Return accepted — refund initiated',
        deepLink: `/orders/${order.id}`,
        payload: { returnId: ret.id, refundId: r.refundId },
      }).catch(() => undefined);
    } catch (e) {
      // ReturnAlreadyDecided race etc. — next tick sees it resolved.
      console.error(`[lifecycle-sweep] verify-window ${ret.id}: ${(e as Error).message}`);
    }
  }
  return accepted;
}

/* ── 4. Held items — warning + expiry ────────────────────────────────────── */

export async function sweepHeldItems(
  database: typeof Db,
): Promise<{ warned: number; expired: number }> {
  const warnDays = await readConfigNumber(
    database,
    'holding_window_warning_days_before_expiry',
    3,
  );
  const now = new Date();
  const warnHorizon = new Date(now.getTime() + warnDays * 86_400_000);
  let warned = 0;
  let expired = 0;

  // (a) pre-expiry warning — stamp-first so a crash between stamp and notify
  // loses one notification rather than spamming every tick.
  const nearing = await database.query.heldItems.findMany({
    where: and(
      eq(heldItems.status, 'holding'),
      isNull(heldItems.warningNotifiedAt),
      lt(heldItems.holdingWindowExpiresAt, warnHorizon),
    ),
    columns: { id: true, consumerId: true, storeId: true, holdingWindowExpiresAt: true },
    limit: BATCH,
  });
  for (const h of nearing) {
    try {
      const [stamped] = await database
        .update(heldItems)
        .set({ warningNotifiedAt: now })
        .where(and(eq(heldItems.id, h.id), isNull(heldItems.warningNotifiedAt)))
        .returning({ id: heldItems.id });
      if (!stamped) continue;
      warned += 1;
      const dateLabel = h.holdingWindowExpiresAt.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
      });
      await notifyConsumer({
        consumerId: h.consumerId,
        kind: 'order',
        title: `Item held at store — collect before ${dateLabel}`,
        body: 'Your rejected-return item is waiting at the store. Collect it before the holding window expires.',
      }).catch(() => undefined);
      await notifyStoreAccounts({
        storeId: h.storeId,
        kind: 'order',
        title: 'Held item nearing expiry',
        body: `Holding window ends ${dateLabel}.`,
        deepLink: '/retailer/returns',
        payload: { heldItemId: h.id },
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] held-warn ${h.id}: ${(e as Error).message}`);
    }
  }

  // (b) expiry — flip holding → expired; disposition stays a human call
  // (force-dispose moves money/stock, so no auto-forfeit).
  const lapsed = await database.query.heldItems.findMany({
    where: and(eq(heldItems.status, 'holding'), lt(heldItems.holdingWindowExpiresAt, now)),
    columns: { id: true, consumerId: true, storeId: true },
    limit: BATCH,
  });
  for (const h of lapsed) {
    try {
      await markExpired(database, h.id, { type: 'system', id: 'system' });
      expired += 1;
      await notifyConsumer({
        consumerId: h.consumerId,
        kind: 'order',
        title: 'Holding window expired',
        body: 'The holding window for your item at the store has ended.',
      }).catch(() => undefined);
      await notifyStoreAccounts({
        storeId: h.storeId,
        kind: 'order',
        title: 'Held item expired',
        deepLink: '/retailer/returns',
        payload: { heldItemId: h.id },
      }).catch(() => undefined);
      await notifyAllAdmins({
        kind: 'system',
        title: 'Held item expired — disposition needed',
        body: `Held item ${h.id} lapsed; decide restock / forfeit / write-off.`,
        payload: { heldItemId: h.id },
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] held-expire ${h.id}: ${(e as Error).message}`);
    }
  }

  return { warned, expired };
}

/* ── 5. Dispatch rot ─────────────────────────────────────────────────────── */

export async function sweepDispatchRot(
  database: typeof Db,
): Promise<{ alerts: number; unassigned: number }> {
  const alertMinutes = await readConfigNumber(database, 'dispatch_unassigned_alert_minutes', 15);
  const staleMinutes = await readConfigNumber(database, 'dispatch_pickup_stale_minutes', 45);
  const now = Date.now();
  let alerts = 0;
  let unassignedCount = 0;

  // (a) packed order nobody claimed — one admin alert per order lifetime.
  const alertCutoff = new Date(now - alertMinutes * 60_000);
  const rotting = await database.query.orders.findMany({
    where: and(
      eq(orders.status, 'packed'),
      isNull(orders.assignedAgentId),
      isNull(orders.dispatchAlertNotifiedAt),
      sql`COALESCE(${orders.packedAt}, ${orders.placedAt}) < ${alertCutoff}`,
    ),
    columns: { id: true, storeNameSnap: true },
    limit: BATCH,
  });
  for (const o of rotting) {
    try {
      const [stamped] = await database
        .update(orders)
        .set({ dispatchAlertNotifiedAt: new Date() })
        .where(and(eq(orders.id, o.id), isNull(orders.dispatchAlertNotifiedAt)))
        .returning({ id: orders.id });
      if (!stamped) continue;
      alerts += 1;
      await notifyAllAdmins({
        kind: 'system',
        title: `Packed order waiting >${alertMinutes} min — no driver`,
        body: `${o.storeNameSnap} · ${o.id}`,
        deepLink: `/orders/${o.id}`,
        payload: { orderId: o.id },
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] dispatch-alert ${o.id}: ${(e as Error).message}`);
    }
  }

  // (b) driver claimed but never picked up — release the claim back to the pool.
  const staleCutoff = new Date(now - staleMinutes * 60_000);
  const staleClaims = await database.query.orders.findMany({
    where: and(
      eq(orders.status, 'packed'),
      isNotNull(orders.assignedAgentId),
      isNotNull(orders.agentAssignedAt),
      lt(orders.agentAssignedAt, staleCutoff),
    ),
    columns: { id: true, assignedAgentId: true, agentAssignedAt: true },
    limit: BATCH,
  });
  for (const o of staleClaims) {
    try {
      const driverId = o.assignedAgentId;
      if (!driverId) continue;
      const [released] = await database
        .update(orders)
        .set({ assignedAgentId: null, agentHandoffCode: null, agentAssignedAt: null })
        .where(
          and(
            eq(orders.id, o.id),
            eq(orders.status, 'packed'),
            eq(orders.assignedAgentId, driverId),
          ),
        )
        .returning({ id: orders.id });
      if (!released) continue; // pickup happened mid-tick — loser exits cleanly
      unassignedCount += 1;
      await logTransitionMarker(database, {
        orderId: o.id,
        toStatus: 'packed',
        actorType: 'system',
        actorId: 'system',
        reason: 'dispatch_auto_unassigned',
        metadata: { driverId, assignedAt: o.agentAssignedAt?.toISOString() ?? null },
      }).catch(() => undefined);
      await notifyAllAdmins({
        kind: 'system',
        title: 'Driver auto-unassigned — order back in pool',
        body: `Order ${o.id}: claim held >${staleMinutes} min without pickup.`,
        deepLink: `/orders/${o.id}`,
        payload: { orderId: o.id, driverId },
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] dispatch-unassign ${o.id}: ${(e as Error).message}`);
    }
  }

  // One bus fire per tick — wakes parked driver long-polls + FCM topic so the
  // pool changes (new alert-refreshed orders / released claims) get seen.
  if (alerts > 0 || unassignedCount > 0) notifyOffersChanged();

  return { alerts, unassigned: unassignedCount };
}

/* ── 6. Pickup no-show ───────────────────────────────────────────────────── */

export async function sweepPickupNoShows(database: typeof Db): Promise<number> {
  const days = await readConfigNumber(database, 'pickup_noshow_cancel_days', 3);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const noShows = await database.query.orders.findMany({
    where: and(
      eq(orders.deliveryMethod, 'pickup'),
      eq(orders.status, 'packed'),
      sql`COALESCE(${orders.pickupSlotEnd}, ${orders.packedAt}, ${orders.placedAt}) < ${cutoff}`,
    ),
    columns: { id: true, consumerId: true, storeId: true },
    limit: BATCH,
  });
  let cancelled = 0;
  for (const o of noShows) {
    try {
      await cancelOrder(database, {
        orderId: o.id,
        actorType: 'system',
        actorId: 'system',
        reason: 'pickup_noshow',
      });
      cancelled += 1;
      await notifyConsumer({
        consumerId: o.consumerId,
        kind: 'order',
        title: 'Pickup order cancelled — not collected',
        body: 'The order was not collected from the store, so it has been cancelled. Any payment has been refunded.',
        deepLink: `/orders/${o.id}`,
      }).catch(() => undefined);
      await notifyStoreAccounts({
        storeId: o.storeId,
        kind: 'order',
        title: 'Pickup order cancelled — restock items',
        body: `Order ${o.id} was never collected.`,
        deepLink: `/retailer/orders/${o.id}`,
        payload: { orderId: o.id },
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[lifecycle-sweep] pickup-noshow ${o.id}: ${(e as Error).message}`);
    }
  }
  return cancelled;
}

/* ── Orchestrator ────────────────────────────────────────────────────────── */

/**
 * Auto-reopen stores whose retailer-set "stop accepting orders" window has
 * elapsed: `order_pause_until <= now` → clear it back to NULL and ping the store
 * accounts. Order acceptance is already correct lazily (compute-quote treats a
 * past `orderPauseUntil` as accepting); this just makes the persisted state and
 * the retailer/consumer UI reflect reality without waiting for an order attempt.
 */
export async function sweepAutoReopenStores(database: typeof Db): Promise<number> {
  const now = new Date();
  const due = await database
    .update(retailerStores)
    .set({ orderPauseUntil: null })
    .where(and(isNotNull(retailerStores.orderPauseUntil), lt(retailerStores.orderPauseUntil, now)))
    .returning({ id: retailerStores.id });

  for (const s of due) {
    try {
      await notifyStoreAccounts({
        storeId: s.id,
        kind: 'system',
        title: "You're back online",
        body: 'Your store is accepting orders again.',
      });
    } catch (e) {
      console.error(`[lifecycle-sweep] auto-reopen notify failed for ${s.id}: ${(e as Error).message}`);
    }
  }
  return due.length;
}

export type SweepCounts = {
  autoClosed: number;
  pendingCancelled: number;
  paymentFailedCancelled: number;
  returnsAutoAccepted: number;
  heldWarned: number;
  heldExpired: number;
  dispatchAlerts: number;
  dispatchUnassigned: number;
  pickupNoShowCancelled: number;
  kycMarkedOverdue: number;
  kycStoresPaused: number;
  storesAutoReopened: number;
};

const ZERO_COUNTS: SweepCounts = {
  autoClosed: 0,
  pendingCancelled: 0,
  paymentFailedCancelled: 0,
  returnsAutoAccepted: 0,
  heldWarned: 0,
  heldExpired: 0,
  dispatchAlerts: 0,
  dispatchUnassigned: 0,
  pickupNoShowCancelled: 0,
  kycMarkedOverdue: 0,
  kycStoresPaused: 0,
  storesAutoReopened: 0,
};

let running = false;

/**
 * Run all six sweeps sequentially. Re-entrancy-guarded: if a prior tick is still
 * draining a backlog, this tick returns zeros instead of stacking.
 */
export async function runLifecycleSweeps(database: typeof Db): Promise<SweepCounts> {
  if (running) return { ...ZERO_COUNTS };
  running = true;
  const counts: SweepCounts = { ...ZERO_COUNTS };
  try {
    try {
      counts.autoClosed = await sweepAutoCloseDelivered(database);
    } catch (e) {
      console.error(`[lifecycle-sweep] auto-close failed: ${(e as Error).message}`);
    }
    try {
      const r = await sweepStalePayments(database);
      counts.pendingCancelled = r.pendingCancelled;
      counts.paymentFailedCancelled = r.paymentFailedCancelled;
    } catch (e) {
      console.error(`[lifecycle-sweep] stale-payments failed: ${(e as Error).message}`);
    }
    try {
      counts.returnsAutoAccepted = await sweepVerificationWindows(database);
    } catch (e) {
      console.error(`[lifecycle-sweep] verify-windows failed: ${(e as Error).message}`);
    }
    try {
      const r = await sweepHeldItems(database);
      counts.heldWarned = r.warned;
      counts.heldExpired = r.expired;
    } catch (e) {
      console.error(`[lifecycle-sweep] held-items failed: ${(e as Error).message}`);
    }
    try {
      const r = await sweepDispatchRot(database);
      counts.dispatchAlerts = r.alerts;
      counts.dispatchUnassigned = r.unassigned;
    } catch (e) {
      console.error(`[lifecycle-sweep] dispatch-rot failed: ${(e as Error).message}`);
    }
    try {
      counts.pickupNoShowCancelled = await sweepPickupNoShows(database);
    } catch (e) {
      console.error(`[lifecycle-sweep] pickup-noshow failed: ${(e as Error).message}`);
    }
    try {
      const r = await sweepKycDeadlines(database);
      counts.kycMarkedOverdue = r.markedOverdue;
      counts.kycStoresPaused = r.storesPaused;
    } catch (e) {
      console.error(`[lifecycle-sweep] kyc-deadlines failed: ${(e as Error).message}`);
    }
    try {
      counts.storesAutoReopened = await sweepAutoReopenStores(database);
    } catch (e) {
      console.error(`[lifecycle-sweep] auto-reopen failed: ${(e as Error).message}`);
    }
  } finally {
    running = false;
  }
  return counts;
}
