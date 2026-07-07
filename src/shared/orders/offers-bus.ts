/**
 * In-memory signal for the driver broadcast-offers long-poll. Anything that changes the
 * pool of packed, unassigned orders (a retailer packing an order, a driver claiming one,
 * an admin assigning/unassigning) calls `notifyOffersChanged()`; parked long-poll handlers
 * waiting on `waitForOffersChange()` wake immediately and re-query their filtered feed.
 *
 * Single-process only — fine for the current single-node deploy. A multi-node deploy would
 * back this with Postgres LISTEN/NOTIFY or Redis pub/sub (same interface).
 */
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per parked driver; no artificial cap

export function notifyOffersChanged(): void {
  bus.emit('changed');
}

/** Resolve as soon as the pool changes, or after `timeoutMs` — whichever comes first. */
export function waitForOffersChange(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      bus.off('changed', onChange);
      resolve();
    }, timeoutMs);
    bus.once('changed', onChange);
  });
}
