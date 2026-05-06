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

export async function openDoor(
  database: typeof Db,
  orderId: string,
  actor: { type: ActorType; id: string },
): Promise<{ orderId: string; toStatus: OrderStatus }> {
  const r = await transitionOrder(database, {
    orderId,
    toStatus: 'at_door',
    actorType: actor.type,
    actorId: actor.id,
    reason: 'door_visit_opened',
  });
  return { orderId: r.orderId, toStatus: r.toStatus };
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
): Promise<{ orderId: string }> {
  const order = await database.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, status: true },
  });
  if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
  if (order.status !== 'at_door') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Order ${orderId} must be in 'at_door' to extend`,
    );
  }
  // Check for existing extension marker.
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
  await logTransitionMarker(database, {
    orderId,
    toStatus: 'at_door',
    actorType: actor.type,
    actorId: actor.id,
    reason: 'door_visit_extended',
    metadata: { reason },
  });
  return { orderId };
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
