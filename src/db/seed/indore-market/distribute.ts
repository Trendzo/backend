/**
 * Pure distribution: which leaf, which store, which product index — for all 400 slots.
 *
 * No database, no randomness, no clock. Two runs produce byte-identical output, which
 * is what lets the composed catalog be snapshotted and diffed by a human.
 */

import { LEAF_SPECS } from './leaf-catalog.js';

export const STORE_COUNT = 20;
export const TOTAL_PRODUCTS = 400;

export type Slot = {
  /** Position in the flattened 400. Drives store assignment and createdAt stagger. */
  index: number;
  leafIndex: number;
  leafSlug: string;
  /** Product number within its leaf: 0-based, < countForLeaf. */
  k: number;
  countForLeaf: number;
  /** 0-based index into STORES. */
  storeIndex: number;
};

/**
 * How many products a leaf gets. 118 leaves x 3 = 354, leaving 46 spare, so 46 leaves
 * get a 4th. Bresenham spreads those 46 evenly down the taxonomy instead of handing
 * them all to the first parents — otherwise Tops would be dense and Formalwear thin.
 */
export function countForLeaf(i: number): number {
  const extras = TOTAL_PRODUCTS - LEAF_SPECS.length * 3; // 46
  return 3 + (Math.floor(((i + 1) * extras) / LEAF_SPECS.length) - Math.floor((i * extras) / LEAF_SPECS.length));
}

/**
 * The 400 slots, leaf-major, each assigned to a store by `index % 20`.
 *
 * Two properties fall out of that and both matter:
 *  - every store gets exactly 20 (400/20, and index%20 over a contiguous range hits
 *    each residue equally);
 *  - a leaf's 3-4 slots sit at CONSECUTIVE indices and 20 > 4, so they land on distinct
 *    stores. No store ever stocks two products from the same leaf, which is what keeps
 *    a shelf from reading "Mini Dress, Mini Dress, Mini Dress" and makes within-store
 *    name collisions impossible.
 */
export function buildSlots(): Slot[] {
  const slots: Slot[] = [];
  LEAF_SPECS.forEach((spec, leafIndex) => {
    const count = countForLeaf(leafIndex);
    for (let k = 0; k < count; k++) {
      const index = slots.length;
      slots.push({
        index,
        leafIndex,
        leafSlug: spec.slug,
        k,
        countForLeaf: count,
        storeIndex: index % STORE_COUNT,
      });
    }
  });
  return slots;
}

/**
 * Back-dated, interleaved creation timestamp.
 *
 * The consumer browse feed orders by `createdAt DESC, id ASC`
 * (catalog.controller.ts:433). Inserting all 400 in one transaction gives them an
 * IDENTICAL now(), so the tiebreak becomes id — which is alphabetical by leaf, and the
 * first page of the whole marketplace turns into 20 consecutive T-shirts. Spreading the
 * timestamps over the trailing ~150 days with a coprime stride both fixes the ordering
 * and stops the new catalog from burying the existing one in a single block.
 */
const SPREAD_MINUTES = 150 * 24 * 60;
const STRIDE = 4111; // prime, coprime with SPREAD_MINUTES → visits the range evenly

export function createdAtFor(slotIndex: number, now: Date): Date {
  const minutesBack = ((slotIndex * STRIDE) % SPREAD_MINUTES) + 60;
  return new Date(now.getTime() - minutesBack * 60_000);
}
