/**
 * Try-and-Buy door visit. Three transactional helpers:
 *
 *   openDoor  → out_for_delivery → at_door
 *   extendDoor → no status change; logs marker (one-shot per order)
 *   closeDoor → at_door → delivered (≥1 kept) OR returning_to_store (all returned/refused).
 *               For each non-kept item, inserts a `returns` row (kind='door_return') with the
 *               agent disposition and starts the verification window.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
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

export type DoorDecision = 'kept' | 'returned' | 'refused';

export type DoorItemDecision = {
  orderItemId: string;
  decision: DoorDecision;
  /** Required for 'refused' (with photos). Optional for 'returned'. */
  reason?: string | undefined;
  photos?: string[] | undefined;
};

const DECISION_TO_OUTCOME = {
  kept: 'at_door_kept',
  returned: 'at_door_returned',
  refused: 'at_door_refused',
} as const;

const DECISION_TO_AGENT_DISPOSITION = {
  kept: 'kept',
  returned: 'returned',
  refused: 'refused',
} as const;

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
  const windowSeconds = await readConfigNumber(
    database,
    'try_on_window_seconds',
    DEFAULT_TRY_ON_WINDOW_SECONDS,
  );
  const expiresAt = new Date(Date.now() + windowSeconds * 1000);
  // Persist the window first so a concurrent read on the order detail picks up
  // the timestamp before the status transition lands.
  await database
    .update(orders)
    .set({ doorWindowExpiresAt: expiresAt, doorWindowExtendedAt: null })
    .where(eq(orders.id, orderId));
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

export async function closeDoor(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
  perItemDecisions: DoorItemDecision[],
): Promise<{
  orderId: string;
  toStatus: OrderStatus;
  returnIds: string[];
  keptCount: number;
  returnedCount: number;
  refusedCount: number;
}> {
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

  // Validate every item belongs to this order and every order item is covered.
  const orderItemRows = await database.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
  });
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
    if (d.decision === 'refused') {
      if (!d.reason || d.reason.trim().length < 3) {
        throw new AppError(
          422,
          ErrorCode.DoorVisitRefuseRequiresEvidence,
          'Refusing an item requires a reason',
        );
      }
      if (!d.photos || d.photos.length === 0) {
        throw new AppError(
          422,
          ErrorCode.DoorVisitRefuseRequiresEvidence,
          'Refusing an item requires at least one photo',
        );
      }
    }
  }

  const keptCount = perItemDecisions.filter((d) => d.decision === 'kept').length;
  const returnedCount = perItemDecisions.filter((d) => d.decision === 'returned').length;
  const refusedCount = perItemDecisions.filter((d) => d.decision === 'refused').length;

  // Verification window for any door-return rows we create.
  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'verification_window_hours'),
  });
  const verHours = cfg && typeof cfg.value === 'number' ? cfg.value : 24;
  const verExpires = new Date(Date.now() + verHours * 60 * 60 * 1000);

  const itemsById = new Map(orderItemRows.map((i) => [i.id, i]));
  const returnIds: string[] = [];

  await database.transaction(async (tx) => {
    for (const d of perItemDecisions) {
      const it = itemsById.get(d.orderItemId)!;
      const outcome = DECISION_TO_OUTCOME[d.decision];

      // Update order_item.outcome
      await tx
        .update(orderItems)
        .set({ outcome })
        .where(eq(orderItems.id, d.orderItemId));

      if (d.decision === 'kept') {
        // Finalise stock for kept items now (mirror standard delivery).
        await tx
          .update(variants)
          .set({
            stock: sql`${variants.stock} - ${it.qty}`,
            reserved: sql`GREATEST(${variants.reserved} - ${it.qty}, 0)`,
          })
          .where(eq(variants.id, it.variantId));
      } else {
        // Insert door-return row.
        const rid = newId(IdPrefix.Return);
        await tx.insert(returns).values({
          id: rid,
          orderItemId: d.orderItemId,
          kind: 'door_return',
          reasonText: d.reason ?? null,
          photos: d.photos ?? [],
          agentDisposition: DECISION_TO_AGENT_DISPOSITION[d.decision],
          storeDecision: 'pending',
          verificationWindowExpiresAt: verExpires,
        });
        returnIds.push(rid);
      }
    }
  });

  // Decide order transition.
  const toStatus: OrderStatus = keptCount > 0 ? 'delivered' : 'returning_to_store';
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
      returnIds,
    },
  });

  return {
    orderId,
    toStatus,
    returnIds,
    keptCount,
    returnedCount,
    refusedCount,
  };
}

// quench unused
void inArray;
