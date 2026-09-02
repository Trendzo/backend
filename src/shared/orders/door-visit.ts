/**
 * Try-and-Buy door visit. Three transactional helpers:
 *
 *   openDoor  → out_for_delivery → at_door
 *   extendDoor → no status change; logs marker (one-shot per order)
 *   closeDoor → at_door → delivered (≥1 kept) OR returning_to_store (all returned/refused).
 *               For each non-kept item, inserts a `returns` row (kind='door_return') with the
 *               agent disposition and starts the verification window.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  orderItems,
  orderTransitions,
  orders,
  platformConfig,
  returns,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { logTransitionMarker, transitionOrder } from './transition.js';
import type { ActorType, OrderStatus } from './state-machine.js';

// Per-item door outcomes:
//  - kept            → customer keeps the item (normal delivery).
//  - returned        → customer hands a clean item back; goods travel to the store
//                      and await store verification (refund on accept / dispute on decline).
//  - refused         → customer refuses the delivery outright; goods travel back.
//  - return_rejected → customer tried to return a wrong/defective/changed item and the
//                      AGENT rejects the return at the door: the item STAYS with the
//                      customer (counts as delivered, no refund), evidence is captured.
export type DoorDecision = 'kept' | 'returned' | 'refused' | 'return_rejected';

export type DoorItemDecision = {
  orderItemId: string;
  decision: DoorDecision;
  /** Required (with ≥1 photo) for 'refused' and 'return_rejected'. Optional for 'returned'. */
  reason?: string | undefined;
  photos?: string[] | undefined;
};

const DECISION_TO_OUTCOME = {
  kept: 'at_door_kept',
  returned: 'at_door_returned',
  refused: 'at_door_refused',
  return_rejected: 'at_door_return_rejected',
} as const;

const DECISION_TO_AGENT_DISPOSITION = {
  kept: 'kept',
  returned: 'returned',
  refused: 'refused',
  return_rejected: 'return_rejected',
} as const;

/** Decisions where the customer keeps the goods (delivered, no goods movement). */
const STAYS_WITH_CUSTOMER = new Set<DoorDecision>(['kept', 'return_rejected']);
/** Decisions that require a reason + at least one evidence photo. */
const NEEDS_EVIDENCE = new Set<DoorDecision>(['refused', 'return_rejected']);

// §9 — defaults if platform_config rows are absent. 10-min initial window, 5-min
// one-shot extension match the values used by the dashboard's prior mock.
const DEFAULT_TRY_ON_WINDOW_SECONDS = 600;
const DEFAULT_TRY_ON_EXTENSION_SECONDS = 300;

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

export async function openDoor(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
): Promise<{ orderId: string; toStatus: OrderStatus; doorWindowExpiresAt: Date }> {
  // Only Try-and-Buy orders have a try-on window (the state machine alone would let any
  // order reach at_door). Reject other methods rather than pushing them through the flow.
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, deliveryMethod: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.deliveryMethod !== 'try_and_buy') {
    throw new AppError(409, ErrorCode.InvalidState, 'Only Try-and-Buy orders have a try-on window');
  }
  const windowSeconds = await readConfigNumber(
    database,
    'try_on_window_seconds',
    DEFAULT_TRY_ON_WINDOW_SECONDS,
  );
  const expiresAt = new Date(Date.now() + windowSeconds * 1000);
  // Set the window ONLY when actually opening from out_for_delivery. A conditional write
  // (vs unconditional) means a repeat door/open on an already-at_door order can't silently
  // reset an in-progress window, and a wrong-state call leaves no stale timestamp behind —
  // the transitionOrder below then raises the proper InvalidState. Writing it here (still
  // out_for_delivery) also keeps the window present the instant the status flips.
  await database
    .update(orders)
    .set({ doorWindowExpiresAt: expiresAt, doorWindowExtendedAt: null })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'out_for_delivery')));
  const r = await transitionOrder(database, {
    orderId,
    toStatus: 'at_door',
    actorType: actor.type,
    actorId: actor.id,
    reason: 'door_visit_opened',
    metadata: { doorWindowExpiresAt: expiresAt.toISOString() },
  });
  return { orderId: r.orderId, toStatus: r.toStatus, doorWindowExpiresAt: expiresAt };
}

/**
 * One-shot per order. Records a marker transition with metadata.extension=true; refuses
 * if a previous extension marker already exists.
 */
export async function extendDoor(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
  reason: string,
): Promise<{ orderId: string; doorWindowExpiresAt: Date }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: {
      id: true,
      status: true,
      doorWindowExpiresAt: true,
      doorWindowExtendedAt: true,
    },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'at_door') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order ${orderId} must be in 'at_door' to extend`,
    );
  }
  // §9 — column is the source of truth. doorWindowExtendedAt non-null = extension
  // already used. Falls back to the legacy transition-marker check for orders
  // opened before this migration ran.
  if (order.doorWindowExtendedAt) {
    throw new AppError(
      409,
      ErrorCode.DoorVisitExtensionExhausted,
      'Door visit extension has already been used',
    );
  }
  const priorExtension = await database.query.orderTransitions.findFirst({
    where: and(
      eq(orderTransitions.orderId, orderId),
      eq(orderTransitions.reason, 'door_visit_extended'),
    ),
  });
  if (priorExtension) {
    throw new AppError(
      409,
      ErrorCode.DoorVisitExtensionExhausted,
      'Door visit extension has already been used',
    );
  }

  const extensionSeconds = await readConfigNumber(
    database,
    'try_on_extension_seconds',
    DEFAULT_TRY_ON_EXTENSION_SECONDS,
  );
  // Bump from the existing deadline (or now if the deadline somehow lapsed) so
  // an extension on an already-expired window still grants the full extension
  // worth of time, not negative.
  const base = order.doorWindowExpiresAt && order.doorWindowExpiresAt.getTime() > Date.now()
    ? order.doorWindowExpiresAt.getTime()
    : Date.now();
  const newExpiresAt = new Date(base + extensionSeconds * 1000);
  const now = new Date();
  await database
    .update(orders)
    .set({ doorWindowExpiresAt: newExpiresAt, doorWindowExtendedAt: now })
    .where(eq(orders.id, orderId));
  await logTransitionMarker(database, {
    orderId,
    toStatus: 'at_door',
    actorType: actor.type,
    actorId: actor.id,
    reason: 'door_visit_extended',
    metadata: { reason, doorWindowExpiresAt: newExpiresAt.toISOString() },
  });
  return { orderId, doorWindowExpiresAt: newExpiresAt };
}

/** How a `closeDoor` call was triggered — controls how unresolved staging is handled. */
export type DoorCloseTrigger = 'all_at_once' | 'driver_finish' | 'auto_last_decision' | 'system_sweep';

type DoorStagingItem = {
  id: string;
  customerDoorChoice: 'keep' | 'return' | null;
  agentDoorDecision: 'accept_return' | 'reject_return' | null;
  agentReturnReason: string | null;
  agentReturnPhotos: string[];
};

/**
 * Resolve the accumulated per-item staging (customer choice + agent response) into the
 * concrete decision list `closeDoor` finalizes. Rules:
 *  - agent accepted a return  → 'returned'
 *  - agent rejected a return  → 'return_rejected' (carries the recorded reason + photos)
 *  - customer chose 'keep'    → 'kept'
 *  - customer chose 'return' but the agent hasn't acted → UNRESOLVED:
 *      driver_finish refuses (the driver must accept/reject first); sweep + auto-close
 *      default it to 'kept' (the goods never physically came back).
 *  - undecided                → 'kept'
 */
function resolveDoorDecisionsFromStaging(
  items: DoorStagingItem[],
  trigger: DoorCloseTrigger,
): DoorItemDecision[] {
  return items.map((it) => {
    if (it.agentDoorDecision === 'accept_return') {
      return { orderItemId: it.id, decision: 'returned' as const };
    }
    if (it.agentDoorDecision === 'reject_return') {
      return {
        orderItemId: it.id,
        decision: 'return_rejected' as const,
        reason: it.agentReturnReason ?? undefined,
        photos: it.agentReturnPhotos ?? [],
      };
    }
    if (it.customerDoorChoice === 'return') {
      if (trigger === 'driver_finish') {
        throw new AppError(
          409,
          ErrorCode.DoorVisitReturnUnresolved,
          `Item ${it.id} has a customer return that must be accepted or rejected before closing`,
        );
      }
      // The customer EXPLICITLY asked to return this item and the driver never answered
      // (only reachable via the expiry sweep — auto-close never fires with an unresolved
      // return). Honor the request as a `returned` rather than silently converting it to
      // `kept`, which would charge the customer for a return they asked for. The goods
      // ride the returning-to-store leg; if they never arrive, the existing stranded-return
      // sweeps alert ops — a visible failure, not a silent wrong charge.
      return { orderItemId: it.id, decision: 'returned' as const };
    }
    // Never touched by the customer → kept.
    return { orderItemId: it.id, decision: 'kept' as const };
  });
}

export async function closeDoor(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
  opts?: { decisions?: DoorItemDecision[]; trigger?: DoorCloseTrigger },
): Promise<{
  orderId: string;
  toStatus: OrderStatus;
  returnIds: string[];
  keptCount: number;
  returnedCount: number;
  refusedCount: number;
  returnRejectedCount: number;
}> {
  const trigger: DoorCloseTrigger = opts?.trigger ?? 'all_at_once';
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'at_door') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order ${orderId} must be in 'at_door' to close door visit`,
    );
  }

  const orderItemRows = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
  });

  // Decisions come EITHER from an explicit all-at-once payload (retailer/admin/manual)
  // OR are resolved from the accumulated per-item staging (customer-driven flow).
  let perItemDecisions: DoorItemDecision[];
  if (opts?.decisions) {
    perItemDecisions = opts.decisions;
    // Validate every item belongs to this order and every order item is covered.
    if (orderItemRows.length !== perItemDecisions.length) {
      throw new AppError(
        422,
        ErrorCode.DoorVisitMustChooseAllItems,
        `Decisions must cover every order item (${orderItemRows.length} expected, ${perItemDecisions.length} given)`,
      );
    }
    const validIds = new Set(orderItemRows.map((i) => i.id));
    for (const d of perItemDecisions) {
      if (!validIds.has(d.orderItemId)) {
        throw new AppError(
          422,
          ErrorCode.DoorVisitInvalidItem,
          `Item ${d.orderItemId} is not on this order`,
        );
      }
      if (NEEDS_EVIDENCE.has(d.decision)) {
        const what = d.decision === 'refused' ? 'Refusing a delivery' : 'Rejecting a return';
        if (!d.reason || d.reason.trim().length < 3) {
          throw new AppError(
            422,
            ErrorCode.DoorVisitRefuseRequiresEvidence,
            `${what} requires a reason`,
          );
        }
        if (!d.photos || d.photos.length === 0) {
          throw new AppError(
            422,
            ErrorCode.DoorVisitRefuseRequiresEvidence,
            `${what} requires at least one photo`,
          );
        }
      }
    }
  } else {
    perItemDecisions = resolveDoorDecisionsFromStaging(orderItemRows, trigger);
  }

  const keptCount = perItemDecisions.filter((d) => d.decision === 'kept').length;
  const returnedCount = perItemDecisions.filter((d) => d.decision === 'returned').length;
  const refusedCount = perItemDecisions.filter((d) => d.decision === 'refused').length;
  const returnRejectedCount = perItemDecisions.filter((d) => d.decision === 'return_rejected').length;

  // No verification window is armed here: door returns leave with the driver, so the
  // store has custody of nothing yet. `arriveOrderAtStore` stamps custody + deadline
  // when the parcel physically lands.

  const itemsById = new Map(orderItemRows.map((i) => [i.id, i]));
  const returnIds: string[] = [];

  await database.transaction(async (tx) => {
    for (const d of perItemDecisions) {
      const it = itemsById.get(d.orderItemId)!;
      const outcome = DECISION_TO_OUTCOME[d.decision];

      // Idempotent claim: finalize an item ONLY while it is still `pending_delivery`.
      // Two decisions can resolve the last items at nearly the same instant, firing two
      // concurrent closeDoor calls; without this guard each would decrement stock and (for
      // kept / return_rejected, which carry no pending-unique index) insert a duplicate
      // returns row. The conditional flip means the loser sees 0 rows updated and skips the
      // stock + returns writes entirely — stock is decremented exactly once per item.
      const claimed = await tx
        .update(orderItems)
        .set({ outcome })
        .where(and(eq(orderItems.id, d.orderItemId), eq(orderItems.outcome, 'pending_delivery')))
        .returning({ id: orderItems.id });
      if (claimed.length === 0) continue; // already finalized by a concurrent close

      if (STAYS_WITH_CUSTOMER.has(d.decision)) {
        // Customer keeps the item (a normal keep, or a return the agent rejected at
        // the door). Finalise stock now (mirror standard delivery).
        await tx
          .update(variants)
          .set({
            stock: sql`${variants.stock} - ${it.qty}`,
            reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)`,
          })
          .where(eq(variants.id, it.variantId));

        if (d.decision === 'return_rejected') {
          // Record the rejected-at-door return for audit/evidence. Born resolved
          // (storeDecision='rejected_at_door'): goods stayed with the customer, so
          // NO held item and NO refund — and it never enters the store's pending
          // verification queue (which filters storeDecision='pending').
          const rid = newId(IdPrefix.Return);
          await tx.insert(returns).values({
            id: rid,
            orderItemId: d.orderItemId,
            kind: 'door_return',
            reasonText: d.reason ?? null,
            photos: d.photos ?? [],
            agentDisposition: 'return_rejected',
            storeDecision: 'rejected_at_door',
            storeDecidedAt: new Date(),
          });
          returnIds.push(rid);
        }
      } else {
        // returned / refused → goods travel back to the store; await verification.
        const rid = newId(IdPrefix.Return);
        await tx.insert(returns).values({
          id: rid,
          orderItemId: d.orderItemId,
          kind: 'door_return',
          reasonText: d.reason ?? null,
          photos: d.photos ?? [],
          agentDisposition: DECISION_TO_AGENT_DISPOSITION[d.decision],
          storeDecision: 'pending',
          // No window here: the goods are leaving with the driver, so nobody has
          // custody at the store yet. `arriveOrderAtStore` stamps custody + deadline
          // when the parcel physically lands. Arming the clock now would let the
          // verification sweep auto-accept and refund goods still in a van.
        });
        returnIds.push(rid);
      }
    }
  });

  // Decide order transition. The order is 'delivered' if ANY item stays with the
  // customer (kept or return_rejected); only an all-returned/refused visit goes
  // back to the store.
  const staysCount = keptCount + returnRejectedCount;
  const toStatus: OrderStatus = staysCount > 0 ? 'delivered' : 'returning_to_store';
  await transitionOrder(database, {
    orderId,
    toStatus,
    actorType: actor.type,
    actorId: actor.id,
    reason: 'door_visit_closed',
    metadata: {
      keptCount,
      returnedCount,
      refusedCount,
      returnRejectedCount,
      returnIds,
    },
  });
  if (toStatus === 'delivered') {
    // Dormant defense: cod+try_and_buy is rejected at quote, but every delivered
    // path settles a still-pending COD payment to keep the capture invariant.
    const { settleCodPaymentOnDelivery } = await import('@/shared/payments/settle-cod.js');
    await settleCodPaymentOnDelivery(database, { orderId }).catch(() => undefined);
  }

  return {
    orderId,
    toStatus,
    returnIds,
    keptCount,
    returnedCount,
    refusedCount,
    returnRejectedCount,
  };
}

// quench unused
void inArray;

// ── Customer-driven accumulation helpers ──────────────────────────────────────
// The order stays `at_door` while decisions accumulate on order_items; `closeDoor`
// (via maybeAutoCloseDoor / driver-finish / sweep) is the only thing that transitions.

/** Assert the order is in a live door visit (regardless of the window deadline). */
async function assertAtDoor(database: typeof Db, orderId: string): Promise<void> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'at_door') {
    throw new AppError(409, ErrorCode.InvalidState, `Order ${orderId} is not in a try-on window`);
  }
}

/**
 * Assert the door visit is open AND the window has not expired. Used to gate NEW customer
 * choices — once the timer is up, the customer can no longer keep/return; the driver
 * finishes (mark-remaining-kept) or extends. The driver RESPONDING to an already-requested
 * return is deliberately NOT gated this way (see recordAgentDoorDecision) so a return asked
 * for in the final seconds can't strand the order until the sweep.
 */
async function assertDoorOpen(
  database: typeof Db,
  orderId: string,
): Promise<void> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true, doorWindowExpiresAt: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'at_door') {
    throw new AppError(409, ErrorCode.InvalidState, `Order ${orderId} is not in a try-on window`);
  }
  if (!order.doorWindowExpiresAt || order.doorWindowExpiresAt.getTime() <= Date.now()) {
    throw new AppError(409, ErrorCode.DoorWindowExpired, 'The try-on window has closed');
  }
}

async function loadOrderItem(database: typeof Db, orderId: string, orderItemId: string) {
  const item = await database.query.orderItems.findFirst({
    where: and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, orderId)),
  });
  if (!item) {
    throw new AppError(422, ErrorCode.DoorVisitInvalidItem, `Item ${orderItemId} is not on this order`);
  }
  return item;
}

/**
 * Auto-close the door once every item is terminally resolved (customer kept it, or the
 * agent has answered the customer's return). Best-effort: a concurrent close that already
 * moved the order simply leaves this a no-op.
 */
async function maybeAutoCloseDoor(
  database: typeof Db,
  orderId: string,
  closeActor: { type: ActorType; id: string },
): Promise<{ closed: boolean; orderStatus: OrderStatus }> {
  const items = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
    columns: { customerDoorChoice: true, agentDoorDecision: true },
  });
  const allResolved = items.every(
    (it) => it.customerDoorChoice === 'keep' || it.agentDoorDecision != null,
  );
  if (!allResolved) return { closed: false, orderStatus: 'at_door' };
  try {
    const r = await closeDoor(database, orderId, closeActor, { trigger: 'auto_last_decision' });
    return { closed: true, orderStatus: r.toStatus };
  } catch {
    // A concurrent close won the race — leave it; the order is (being) finalized.
    return { closed: false, orderStatus: 'at_door' };
  }
}

/**
 * Consumer records a per-item Keep/Return during the window. 'keep' can auto-close the
 * visit; 'return' waits for the driver to accept/inspect. The order-item CHECK constraint
 * additionally guards that a customer choice can't contradict a prior agent decision.
 */
export async function recordCustomerDoorChoice(
  database: typeof Db,
  orderId: string,
  orderItemId: string,
  choice: 'keep' | 'return',
): Promise<{ closed: boolean; orderStatus: OrderStatus }> {
  await assertDoorOpen(database, orderId);
  await loadOrderItem(database, orderId, orderItemId); // membership + existence
  // Guarded write: only set the customer choice while the driver hasn't responded. Doing
  // this conditionally (rather than a read-then-write) closes the race where the driver
  // accepts/rejects at the same instant — which would otherwise violate the
  // agent-decision-requires-return CHECK and surface as a raw 500. 0 rows updated → the
  // driver already acted → clean 409.
  const updated = await database
    .update(orderItems)
    .set({ customerDoorChoice: choice, customerChoiceAt: new Date() })
    .where(and(eq(orderItems.id, orderItemId), isNull(orderItems.agentDoorDecision)))
    .returning({ id: orderItems.id });
  if (updated.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'The driver has already responded to this item');
  }
  // Consumer can't own an at_door→delivered transition (state machine), so the auto-close
  // runs as `system`.
  if (choice === 'keep') {
    return maybeAutoCloseDoor(database, orderId, { type: 'system', id: 'system' });
  }
  return { closed: false, orderStatus: 'at_door' };
}

/**
 * Driver responds to a customer's requested return: accept (goods travel back) or reject
 * at the door (goods stay with the customer — requires reason + ≥1 photo). Resolving the
 * last item auto-closes the visit, attributed to the delivery agent.
 */
export async function recordAgentDoorDecision(
  database: typeof Db,
  orderId: string,
  orderItemId: string,
  decision: 'accept_return' | 'reject_return',
  evidence: { reason?: string; photos?: string[] },
  actor: { type: ActorType; id: string },
): Promise<{ closed: boolean; orderStatus: OrderStatus }> {
  // Only require an open door visit — NOT an unexpired window. The customer already made
  // the return request in-window; the driver must be able to resolve it during the grace
  // period, otherwise a late request would deadlock (accept blocked by expiry, finish
  // blocked by the unresolved return) until the system sweep.
  await assertAtDoor(database, orderId);
  const item = await loadOrderItem(database, orderId, orderItemId);
  if (item.customerDoorChoice !== 'return') {
    throw new AppError(
      409,
      ErrorCode.DoorItemNotReturnRequested,
      'The customer has not requested a return on this item',
    );
  }
  if (item.agentDoorDecision) {
    throw new AppError(409, ErrorCode.InvalidState, 'You have already responded to this item');
  }
  if (decision === 'reject_return') {
    if (!evidence.reason || evidence.reason.trim().length < 3) {
      throw new AppError(
        422,
        ErrorCode.DoorVisitRefuseRequiresEvidence,
        'Rejecting a return requires a reason',
      );
    }
    if (!evidence.photos || evidence.photos.length === 0) {
      throw new AppError(
        422,
        ErrorCode.DoorVisitRefuseRequiresEvidence,
        'Rejecting a return requires at least one photo',
      );
    }
  }
  // Guarded write: set the agent decision only while the item is still a pending customer
  // return. If the customer flipped return→keep (or another decision landed) at the same
  // instant, 0 rows update → clean 409 instead of a CHECK-constraint 500.
  const updated = await database
    .update(orderItems)
    .set({
      agentDoorDecision: decision,
      agentDecidedAt: new Date(),
      agentReturnReason: evidence.reason ?? null,
      agentReturnPhotos: evidence.photos ?? [],
    })
    .where(
      and(
        eq(orderItems.id, orderItemId),
        eq(orderItems.customerDoorChoice, 'return'),
        isNull(orderItems.agentDoorDecision),
      ),
    )
    .returning({ id: orderItems.id });
  if (updated.length === 0) {
    throw new AppError(
      409,
      ErrorCode.DoorItemNotReturnRequested,
      'This item is no longer awaiting your response',
    );
  }
  return maybeAutoCloseDoor(database, orderId, actor);
}

/**
 * Sweep expired try-on door windows. A customer who didn't return anything
 * within the window has effectively KEPT the items, so auto-close all-kept →
 * delivered. A grace period after expiry lets the live board show the lapsed
 * card (sorted to the bottom) for the day before the system finalizes it.
 */
const DOOR_SWEEP_GRACE_MS = 30 * 60 * 1000; // 30 min after expiry

export async function processDoorWindowSweep(database: typeof Db): Promise<number> {
  const cutoff = new Date(Date.now() - DOOR_SWEEP_GRACE_MS);
  const stuck = await database.query.orders.findMany({
    where: and(eq(orders.status, 'at_door'), lt(orders.doorWindowExpiresAt, cutoff)),
    columns: { id: true },
  });
  let closed = 0;
  for (const o of stuck) {
    try {
      // Resolve from accumulated staging: any item the customer kept (or never touched)
      // finalizes as kept; a customer return the driver never answered also defaults to
      // kept (the goods never came back). This now flows through transitionOrder(→delivered),
      // which records the assigned driver's earnings — the sweep previously paid nothing.
      await closeDoor(database, o.id, { type: 'system', id: 'system' }, { trigger: 'system_sweep' });
      closed++;
    } catch {
      // best-effort; leave for the next sweep / manual handling
    }
  }
  return closed;
}
