/**
 * Per-discount-type pure functions. Each takes the eligible lines + the validated config
 * and returns the discount in paise + a per-line allocation. The caller (`compute`) owns
 * eligibility, clubbing, and the cap-at-subtotal rule.
 *
 * All functions are deterministic and side-effect-free.
 */
import type {
  BogoConfig,
  BundleConfig,
  BxgyConfig,
  FlatAmountConfig,
  FreeShippingConfig,
  PercentConfig,
  PercentUptoConfig,
  TieredCartConfig,
} from '../promotions/schemas.js';
import type { CartLine } from './types.js';

type LineSubtotal = { line: CartLine; subtotalPaise: number };

function lineSubtotals(lines: CartLine[]): LineSubtotal[] {
  return lines.map((l) => ({ line: l, subtotalPaise: l.unitPricePaise * l.qty }));
}

function totalOf(lines: LineSubtotal[]): number {
  return lines.reduce((s, l) => s + l.subtotalPaise, 0);
}

/**
 * Distribute a flat discount across lines proportionally to their subtotal. Sums of
 * per-line allocations equal the input `totalPaise` (rounding done at the largest line).
 */
function allocateProportional(
  lines: LineSubtotal[],
  totalPaise: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (totalPaise <= 0 || lines.length === 0) {
    for (const { line } of lines) out[line.lineId] = 0;
    return out;
  }
  const subtotalSum = totalOf(lines);
  if (subtotalSum === 0) return out;
  let assigned = 0;
  // Last line absorbs the rounding remainder.
  for (let i = 0; i < lines.length; i++) {
    const ls = lines[i]!;
    if (i === lines.length - 1) {
      out[ls.line.lineId] = totalPaise - assigned;
    } else {
      const portion = Math.floor((ls.subtotalPaise * totalPaise) / subtotalSum);
      out[ls.line.lineId] = portion;
      assigned += portion;
    }
  }
  return out;
}

// ─────────── Discount type implementations ───────────

export function applyFlatAmount(
  eligible: CartLine[],
  config: FlatAmountConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const ls = lineSubtotals(eligible);
  const subtotal = totalOf(ls);
  const amount = Math.min(config.amountPaise, subtotal);
  return { amountPaise: amount, perLinePaise: allocateProportional(ls, amount) };
}

export function applyPercent(
  eligible: CartLine[],
  config: PercentConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const ls = lineSubtotals(eligible);
  const subtotal = totalOf(ls);
  const amount = Math.floor((subtotal * config.percent) / 100);
  return { amountPaise: amount, perLinePaise: allocateProportional(ls, amount) };
}

export function applyPercentUpto(
  eligible: CartLine[],
  config: PercentUptoConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const ls = lineSubtotals(eligible);
  const subtotal = totalOf(ls);
  const raw = Math.floor((subtotal * config.percent) / 100);
  const amount = Math.min(raw, config.maxAmountPaise);
  return { amountPaise: amount, perLinePaise: allocateProportional(ls, amount) };
}

/**
 * BOGO: requires at least 1 of `buyListingId`. Discount applies to up to ⌊buyQty/2⌋ units
 * of `getListingId` (defaults to buyListingId). For mvp, only counts whole pairs.
 */
export function applyBogo(
  eligible: CartLine[],
  config: BogoConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const buyLines = eligible.filter((l) => l.listingId === config.buyListingId);
  if (buyLines.length === 0) return { amountPaise: 0, perLinePaise: {} };

  const getListingId = config.getListingId ?? config.buyListingId;
  const getLines = eligible.filter((l) => l.listingId === getListingId);
  if (getLines.length === 0) return { amountPaise: 0, perLinePaise: {} };

  const buyQty = buyLines.reduce((q, l) => q + l.qty, 0);
  const eligibleGetUnits = Math.floor(buyQty / 2);
  if (eligibleGetUnits <= 0) return { amountPaise: 0, perLinePaise: {} };

  const perLinePaise: Record<string, number> = {};
  let total = 0;
  let unitsLeft = eligibleGetUnits;
  // Discount cheapest-first across get-lines.
  const sorted = getLines.slice().sort((a, b) => a.unitPricePaise - b.unitPricePaise);
  for (const line of sorted) {
    if (unitsLeft <= 0) break;
    const take = Math.min(line.qty, unitsLeft);
    const off = Math.floor((line.unitPricePaise * take * config.discountPercent) / 100);
    perLinePaise[line.lineId] = (perLinePaise[line.lineId] ?? 0) + off;
    total += off;
    unitsLeft -= take;
  }
  return { amountPaise: total, perLinePaise };
}

/**
 * BxGy: customer must have ≥ buyQty of items in `buyListingIds`. They then get up to
 * `getQty` cheapest items (from `getListingIds` or buy list) at `discountPercent` off.
 */
export function applyBxgy(
  eligible: CartLine[],
  config: BxgyConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const buyPool = eligible.filter((l) => config.buyListingIds.includes(l.listingId));
  const buyQty = buyPool.reduce((q, l) => q + l.qty, 0);
  if (buyQty < config.buyQty) return { amountPaise: 0, perLinePaise: {} };

  const getList = config.getListingIds ?? config.buyListingIds;
  const getPool = eligible.filter((l) => getList.includes(l.listingId));
  if (getPool.length === 0) return { amountPaise: 0, perLinePaise: {} };

  // Number of times the (buyQty → getQty) pattern fires.
  const cycles = Math.floor(buyQty / config.buyQty);
  let unitsLeft = cycles * config.getQty;

  const perLinePaise: Record<string, number> = {};
  let total = 0;
  const sorted = getPool.slice().sort((a, b) => a.unitPricePaise - b.unitPricePaise);
  for (const line of sorted) {
    if (unitsLeft <= 0) break;
    const take = Math.min(line.qty, unitsLeft);
    const off = Math.floor((line.unitPricePaise * take * config.discountPercent) / 100);
    perLinePaise[line.lineId] = (perLinePaise[line.lineId] ?? 0) + off;
    total += off;
    unitsLeft -= take;
  }
  return { amountPaise: total, perLinePaise };
}

/**
 * Bundle: cart must contain ≥ 1 of every `bundleListingIds`. Discount applies to the
 * combined bundle subtotal (one of each, cheapest-first across the matched lines).
 */
export function applyBundle(
  eligible: CartLine[],
  config: BundleConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  // Find the cheapest line per required bundle member.
  const matched: { lineId: string; subtotalPaise: number }[] = [];
  for (const need of config.bundleListingIds) {
    const candidates = eligible.filter((l) => l.listingId === need);
    if (candidates.length === 0) return { amountPaise: 0, perLinePaise: {} };
    const cheapest = candidates.reduce((a, b) => (a.unitPricePaise <= b.unitPricePaise ? a : b));
    matched.push({ lineId: cheapest.lineId, subtotalPaise: cheapest.unitPricePaise });
  }
  const bundleSubtotal = matched.reduce((s, m) => s + m.subtotalPaise, 0);
  const totalDiscount = Math.floor((bundleSubtotal * config.discountPercent) / 100);
  // Allocate proportionally across the matched bundle members.
  const ls = matched.map((m) => ({
    line: { lineId: m.lineId } as CartLine,
    subtotalPaise: m.subtotalPaise,
  }));
  return {
    amountPaise: totalDiscount,
    perLinePaise: allocateProportional(ls, totalDiscount),
  };
}

export function applyTieredCart(
  eligible: CartLine[],
  config: TieredCartConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const ls = lineSubtotals(eligible);
  const subtotal = totalOf(ls);
  // Pick the highest tier whose minCartPaise ≤ cart subtotal.
  const winning = config.tiers
    .filter((t) => subtotal >= t.minCartPaise)
    .sort((a, b) => b.minCartPaise - a.minCartPaise)[0];
  if (!winning) return { amountPaise: 0, perLinePaise: {} };
  const amount = Math.floor((subtotal * winning.discountPercent) / 100);
  return { amountPaise: amount, perLinePaise: allocateProportional(ls, amount) };
}

/**
 * Free shipping has no per-line allocation — it zeroes out the delivery fee. The
 * orchestrator handles the actual fee zeroing; this function just signals "I'd apply".
 * Returns 1 paise as a sentinel so it counts as a non-zero application; the orchestrator
 * ignores the value and uses the eligible delivery fee as the actual subsidy.
 */
export function applyFreeShipping(
  eligible: CartLine[],
  config: FreeShippingConfig,
): { amountPaise: number; perLinePaise: Record<string, number> } {
  const ls = lineSubtotals(eligible);
  const subtotal = totalOf(ls);
  if (config.minCartPaise != null && subtotal < config.minCartPaise) {
    return { amountPaise: 0, perLinePaise: {} };
  }
  // Sentinel — orchestrator interprets > 0 as "apply free shipping" and computes real value.
  return { amountPaise: 1, perLinePaise: {} };
}
