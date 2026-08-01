/**
 * The one definition of "can this item still be returned".
 *
 * The window length and the eligible-outcome set were previously declared three times
 * in the backend (open-return, the consumer order shaper) plus once more in the
 * customer app, and they had already begun to drift.
 *
 * `pending_delivery` is deliberately ABSENT: it means the item was never handed over.
 * It used to be in the set, and had to be, because nothing in production ever moved an
 * item out of it — delivery stamped no item outcome at all, so a delivered standard
 * order's items sat at `pending_delivery` forever. `transitionOrder` now stamps
 * `delivered_kept` on delivery (and migration 0075 backfilled the history), so the set
 * can finally say what it means.
 */
import type { orderItems } from '@/db/schema/index.js';

export type OrderItemOutcome = (typeof orderItems.$inferSelect)['outcome'];

export const RETURN_WINDOW_DAYS = 7;

export const RETURNABLE_ITEM_OUTCOMES = new Set<OrderItemOutcome>([
  'delivered_kept', // standard delivery, goods with the customer
  'at_door_kept', // Try-and-Buy keep
]);

export function isReturnableOutcome(outcome: OrderItemOutcome): boolean {
  return RETURNABLE_ITEM_OUTCOMES.has(outcome);
}

/** Last instant a return may be opened for an order delivered at `deliveredAt`. */
export function returnDeadline(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
