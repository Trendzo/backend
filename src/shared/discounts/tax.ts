import type { CartLine } from './types.js';

/**
 * GST split. Intra-state (same state code) → CGST + SGST in equal halves. Inter-state →
 * full IGST. Tax base is post-discount, pre-fees.
 *
 * GST rates can vary line-by-line (different products → different HSN → different rates).
 * We weighted-average the rate by line subtotal share so the output is one CGST/SGST/IGST
 * triple for the whole order, matching what the orders/invoices schema expects.
 */
export function gstSplit(
  taxBasePaise: number,
  lines: CartLine[],
  consumerStateCode: string,
  storeStateCode: string,
): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (taxBasePaise <= 0) return { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };

  const lineSubtotalSum = lines.reduce((s, l) => s + l.unitPricePaise * l.qty, 0);
  if (lineSubtotalSum === 0) return { cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };

  // Weighted average GST rate (percent units, can be fractional).
  let weightedRate = 0;
  for (const l of lines) {
    const share = (l.unitPricePaise * l.qty) / lineSubtotalSum;
    weightedRate += share * l.gstRatePct;
  }

  const totalTax = Math.floor((taxBasePaise * weightedRate) / 100);

  if (consumerStateCode === storeStateCode) {
    // Intra-state: split evenly into CGST + SGST.
    const half = Math.floor(totalTax / 2);
    return { cgstPaise: half, sgstPaise: totalTax - half, igstPaise: 0 };
  }
  // Inter-state.
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: totalTax };
}

/** TCS withheld per transaction. Caller multiplies by `tcsRateBp / 10000`. */
export function tcsWithheld(taxBasePaise: number, tcsRateBp: number): number {
  if (taxBasePaise <= 0 || tcsRateBp <= 0) return 0;
  return Math.floor((taxBasePaise * tcsRateBp) / 10000);
}
