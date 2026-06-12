/**
 * Order status state machine. Encodes every legal transition + which actor types may
 * trigger it. Single source of truth — both the admin and retailer routes consult this.
 *
 * Spec reference: PRODUCT_SPEC §Order Lifecycle. Cancellation rules captured per state.
 */

import type { actorType, orderStatus } from '@/db/schema/enums.js';

export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type ActorType = (typeof actorType.enumValues)[number];

type TransitionRule = {
  from: OrderStatus;
  to: OrderStatus;
  /** Actor kinds that may trigger this transition. */
  actors: ActorType[];
};

/**
 * Standard delivery covers the happy path. Try-and-Buy door visit + post-delivery
 * returns are deliberately included in the table so the schema's full state space is
 * reachable — the UI will surface only the standard subset for this iteration.
 */
const RULES: readonly TransitionRule[] = [
  // ── Payment outcome ──
  { from: 'pending', to: 'confirmed', actors: ['system'] },
  { from: 'pending', to: 'payment_failed', actors: ['system'] },
  { from: 'pending', to: 'cancelled', actors: ['consumer', 'admin'] },

  // From payment_failed: retry, or give up
  { from: 'payment_failed', to: 'pending', actors: ['consumer', 'admin', 'system'] },
  { from: 'payment_failed', to: 'cancelled', actors: ['consumer', 'admin'] },

  // ── Routing ──
  { from: 'confirmed', to: 'routing', actors: ['system'] },
  { from: 'confirmed', to: 'cancelled', actors: ['consumer', 'admin'] },

  { from: 'routing', to: 'accepted', actors: ['retailer', 'admin'] },
  // Auto-reroute is modelled as a routing → routing self-loop in the audit log; we record
  // it as a transition with the same status (handled by transitionOrder caller).
  { from: 'routing', to: 'cancelled', actors: ['admin', 'system'] },

  // ── Pack + handover ──
  { from: 'accepted', to: 'packed', actors: ['retailer', 'admin'] },
  { from: 'accepted', to: 'cancelled', actors: ['consumer', 'admin'] },

  { from: 'packed', to: 'picked_up', actors: ['retailer', 'delivery_agent', 'admin'] },
  // Pickup orders: consumer collects from the store after verifying pickup_code.
  // Route handler enforces deliveryMethod === 'pickup' before allowing this jump.
  { from: 'packed', to: 'delivered', actors: ['retailer', 'admin'] },
  { from: 'packed', to: 'cancelled', actors: ['admin'] },

  // ── Out for delivery ──
  { from: 'picked_up', to: 'out_for_delivery', actors: ['retailer', 'delivery_agent', 'system', 'admin'] },
  { from: 'picked_up', to: 'returning_to_store', actors: ['retailer', 'delivery_agent', 'admin'] },
  { from: 'picked_up', to: 'cancelled', actors: ['admin'] },

  { from: 'out_for_delivery', to: 'delivered', actors: ['retailer', 'delivery_agent', 'admin'] },
  { from: 'out_for_delivery', to: 'undelivered', actors: ['retailer', 'delivery_agent', 'admin'] },
  // Door visit opens with admin acting on behalf of agent (no real agent app yet).
  { from: 'out_for_delivery', to: 'at_door', actors: ['retailer', 'delivery_agent', 'system', 'admin'] },
  { from: 'out_for_delivery', to: 'returning_to_store', actors: ['retailer', 'delivery_agent', 'admin'] },
  { from: 'out_for_delivery', to: 'cancelled', actors: ['admin'] },

  // ── Try-and-Buy door — admin may act on behalf of agent for door close decisions ──
  { from: 'at_door', to: 'delivered', actors: ['retailer', 'delivery_agent', 'system', 'admin'] },
  { from: 'at_door', to: 'returning_to_store', actors: ['retailer', 'delivery_agent', 'system', 'admin'] },
  { from: 'at_door', to: 'cancelled', actors: ['admin'] },

  // ── Undelivered ──
  // Retry: undelivered → out_for_delivery (within retry budget)
  { from: 'undelivered', to: 'out_for_delivery', actors: ['retailer', 'delivery_agent', 'system'] },
  // Retry exhausted: → returning_to_store
  { from: 'undelivered', to: 'returning_to_store', actors: ['retailer', 'delivery_agent', 'system'] },
  { from: 'undelivered', to: 'cancelled', actors: ['admin'] },

  // ── Returns to store (post-failed-delivery / post-door-reject) ──
  { from: 'returning_to_store', to: 'returned_to_store', actors: ['retailer', 'delivery_agent', 'admin', 'system'] },
  { from: 'returning_to_store', to: 'cancelled', actors: ['admin'] },

  { from: 'returned_to_store', to: 'delivered', actors: ['retailer', 'admin'] },
  { from: 'returned_to_store', to: 'cancelled', actors: ['retailer', 'admin', 'system'] },

  // ── Closure ──
  { from: 'delivered', to: 'closed', actors: ['system', 'admin'] },
  // Ops-admin can cancel a delivered order to force a refund (§8 story 10). The
  // delivered → cancelled transition reverses the order accounting; pickups /
  // return-to-store flow is handled separately by the refund disbursement.
  { from: 'delivered', to: 'cancelled', actors: ['admin'] },
];

/** All transitions out of a given status, for UI hinting + validation. */
export function transitionsFrom(from: OrderStatus): TransitionRule[] {
  return RULES.filter((r) => r.from === from);
}

/** Whether `actor` may move an order from `from` → `to`. */
export function canTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): boolean {
  return RULES.some((r) => r.from === from && r.to === to && r.actors.includes(actor));
}

/**
 * Throws when the transition is illegal. Carries no domain-specific error — callers
 * wrap it in an AppError with the order id + actor context.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): void {
  if (!canTransition(from, to, actor)) {
    throw new Error(
      `Illegal order transition: ${from} → ${to} by ${actor} (no rule in state machine)`,
    );
  }
}

/** Terminal states — no further transitions out. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['cancelled', 'closed']);

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}
