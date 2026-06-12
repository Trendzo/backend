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

export type PosPricing = {
  lines: PosPricedLine[];
  taxSplitKind: 'intra_state';
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
 * Resolve the GST rate (basis points) for a line. If the listing carries a known HSN we could
 * map it; absent that we apply the common apparel rule — 5% up to ₹1000/unit, 12% above. This
 * mirrors the marketplace order flow's 5% apparel default while honouring the >₹1000 slab.
 */
export function gstRateBpForLine(hsn: string | null, unitMrpPaise: number): number {
  void hsn; // reserved for a future HSN→rate table
  return unitMrpPaise > 100_000 ? 1200 : 500;
}

export function pricePosSale(input: {
  variants: PricingVariant[];
  lines: PosLineRequest[];
  billDiscountPaise?: number;
  pricingMode?: PosPricingMode;
}): PosPricing {
  const mode: PosPricingMode = input.pricingMode ?? 'tax_inclusive';
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
    let taxable: number;
    let gst: number;
    if (mode === 'tax_inclusive') {
      taxable = Math.round((lineNet * 10_000) / (10_000 + b.v.gstRateBp));
      gst = lineNet - taxable;
    } else {
      taxable = lineNet;
      gst = Math.round((taxable * b.v.gstRateBp) / 10_000);
    }
    return {
      ...b.v,
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
  // Split once at the aggregate so cgst + sgst === tax exactly (satisfies the DB guard).
  const cgstPaise = Math.floor(taxPaise / 2);
  const sgstPaise = taxPaise - cgstPaise;

  const preRound = taxableValuePaise + taxPaise; // = net of all discounts
  const payablePaise = Math.round(preRound / 100) * 100; // nearest rupee
  const roundOffPaise = payablePaise - preRound;

  return {
    lines,
    taxSplitKind: 'intra_state',
    itemsGrossPaise,
    lineDiscountPaise,
    billDiscountPaise: billDiscount,
    taxableValuePaise,
    cgstPaise,
    sgstPaise,
    igstPaise: 0,
    taxPaise,
    roundOffPaise,
    payablePaise,
  };
}
