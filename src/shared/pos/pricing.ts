/**
 * Offline POS pricing — pure, server-authoritative. The dashboard previews totals via the
 * /quote endpoint and never finalises money client-side.
 *
 * Default pricing mode is `tax_inclusive` (Indian retail MRP includes GST): GST is
 * BACK-CALCULATED out of the sticker price. `tax_exclusive` adds GST on top.
 *
 * Counter sales are always intra-state (place of supply = the store's own state), so tax is
 * always CGST + SGST. Round-off is applied to the cash payable only — it never touches the GST
 * invoice (the invoice check requires grandTotal = taxable + cgst + sgst + tcs exactly).
 */

import { resolveGstRateBp } from './gst-rates.js';

export type PosPricingMode = 'tax_inclusive' | 'tax_exclusive';

/** A variant resolved for pricing, with the snapshot fields the sale will freeze. */
export type PricingVariant = {
  variantId: string;
  listingId: string;
  unitMrpPaise: number; // variant.pricePaise
  gstRateBp: number;
  listingNameSnap: string;
  brandSnap: string | null;
  categorySnap: string | null;
  attributesLabelSnap: string;
  hsnSnap: string | null;
  skuSnap: string | null;
  barcodeSnap: string | null;
};

export type PosLineRequest = {
  variantId: string;
  qty: number;
  lineDiscountPaise?: number | undefined;
};

export type PosPricedLine = PricingVariant & {
  qty: number;
  lineGrossPaise: number;
  lineDiscountPaise: number;
  billDiscountAllocPaise: number;
  taxableValuePaise: number;
  gstPaise: number;
  netLinePaise: number;
};

export type PosTaxSplitKind = 'intra_state' | 'inter_state';

export type PosPricing = {
  lines: PosPricedLine[];
  taxSplitKind: PosTaxSplitKind;
  itemsGrossPaise: number;
  lineDiscountPaise: number;
  billDiscountPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  roundOffPaise: number; // signed; payable - preRound
  payablePaise: number;
};

/**
 * Resolve the GST rate (basis points) for a line. Delegates to the authoritative GST table
 * (gst-rates.ts): an explicit HSN wins; otherwise the category slug drives it. Apparel & footwear
 * are price-slab on MRP (5% ≤ ₹2,500/piece, 18% above — GST 2.0, eff 22-Sep-2025); accessories are
 * flat by type.
 */
export function gstRateBpForLine(
  hsn: string | null,
  unitMrpPaise: number,
  categorySlug: string | null = null,
): number {
  return resolveGstRateBp({ hsn, categorySlug, unitMrpPaise });
}

/**
 * Place-of-supply rule for a counter sale: inter-state when the buyer's GSTIN state code (first
 * two chars) differs from the store's state. Walk-in customers (no GSTIN) are always intra-state —
 * the place of supply defaults to the store's own state. Drives CGST+SGST vs IGST.
 */
export function posTaxSplitFor(
  storeStateCode: string,
  buyerGstin: string | null | undefined,
): PosTaxSplitKind {
  const buyerState = buyerGstin?.trim().slice(0, 2);
  if (buyerState && buyerState.length === 2 && buyerState !== storeStateCode) return 'inter_state';
  return 'intra_state';
}

export function pricePosSale(input: {
  variants: PricingVariant[];
  lines: PosLineRequest[];
  billDiscountPaise?: number;
  pricingMode?: PosPricingMode;
  /** Composition dealers cannot charge GST — every line's effective rate is forced to 0. */
  gstScheme?: 'regular' | 'composition';
  /** CGST+SGST (intra, default) vs IGST (inter). Total tax is identical; only the split differs. */
  taxSplitKind?: PosTaxSplitKind;
}): PosPricing {
  const mode: PosPricingMode = input.pricingMode ?? 'tax_inclusive';
  const isComposition = input.gstScheme === 'composition';
  const taxSplitKind: PosTaxSplitKind = input.taxSplitKind ?? 'intra_state';
  const byId = new Map(input.variants.map((v) => [v.variantId, v]));

  // First pass: gross, line discount, net-after-line.
  const base = input.lines.map((l) => {
    const v = byId.get(l.variantId);
    if (!v) throw new Error(`pricing: variant ${l.variantId} not resolved`);
    const lineGross = v.unitMrpPaise * l.qty;
    const lineDiscount = Math.min(Math.max(l.lineDiscountPaise ?? 0, 0), lineGross);
    return { v, qty: l.qty, lineGross, lineDiscount, netAfterLine: lineGross - lineDiscount };
  });

  const netSubtotal = base.reduce((s, b) => s + b.netAfterLine, 0);
  const billDiscount = Math.min(Math.max(input.billDiscountPaise ?? 0, 0), netSubtotal);

  // Allocate the bill-level discount proportionally to each line's net; last line takes the
  // rounding remainder so allocations always sum to billDiscount exactly.
  let billUsed = 0;
  const lines: PosPricedLine[] = base.map((b, idx) => {
    const isLast = idx === base.length - 1;
    const share = netSubtotal === 0 ? 0 : b.netAfterLine / netSubtotal;
    const billAlloc = isLast
      ? billDiscount - billUsed
      : Math.floor(billDiscount * share);
    billUsed += billAlloc;

    const lineNet = b.netAfterLine - billAlloc; // what this line actually contributes
    // Composition dealers charge no GST → effective rate 0, the whole line is taxable value.
    const rateBp = isComposition ? 0 : b.v.gstRateBp;
    let taxable: number;
    let gst: number;
    if (mode === 'tax_inclusive') {
      taxable = Math.round((lineNet * 10_000) / (10_000 + rateBp));
      gst = lineNet - taxable;
    } else {
      taxable = lineNet;
      gst = Math.round((taxable * rateBp) / 10_000);
    }
    return {
      ...b.v,
      gstRateBp: rateBp,
      qty: b.qty,
      lineGrossPaise: b.lineGross,
      lineDiscountPaise: b.lineDiscount,
      billDiscountAllocPaise: billAlloc,
      taxableValuePaise: taxable,
      gstPaise: gst,
      netLinePaise: taxable + gst,
    };
  });

  const itemsGrossPaise = base.reduce((s, b) => s + b.lineGross, 0);
  const lineDiscountPaise = base.reduce((s, b) => s + b.lineDiscount, 0);
  const taxableValuePaise = lines.reduce((s, l) => s + l.taxableValuePaise, 0);
  const taxPaise = lines.reduce((s, l) => s + l.gstPaise, 0);
  // Split once at the aggregate so the parts === tax exactly (satisfies the DB guard).
  // Intra-state → CGST+SGST (half each); inter-state → all IGST.
  const cgstPaise = taxSplitKind === 'inter_state' ? 0 : Math.floor(taxPaise / 2);
  const sgstPaise = taxSplitKind === 'inter_state' ? 0 : taxPaise - cgstPaise;
  const igstPaise = taxSplitKind === 'inter_state' ? taxPaise : 0;

  const preRound = taxableValuePaise + taxPaise; // = net of all discounts
  const payablePaise = Math.round(preRound / 100) * 100; // nearest rupee
  const roundOffPaise = payablePaise - preRound;

  return {
    lines,
    taxSplitKind,
    itemsGrossPaise,
    lineDiscountPaise,
    billDiscountPaise: billDiscount,
    taxableValuePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    roundOffPaise,
    payablePaise,
  };
}
