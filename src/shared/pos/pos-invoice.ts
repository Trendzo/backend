/**
 * GST tax invoice for an offline POS (counter) sale.
 *
 * Distinct sequence series `POS-A` so counter-sale numbers never collide with marketplace
 * tax invoices (TAX-A). Always intra-state (CGST+SGST), TCS = 0 (the retailer's own sale, no
 * platform withholding). Round-off lives on the sale, never on the invoice — so the invoice
 * grandTotal is exactly taxable + cgst + sgst (satisfies invoices_gst_split_guard).
 *
 * The invoice row is inserted INSIDE the sale transaction (numbered atomically with the sale).
 * The PDF render is scheduled post-commit, mirroring shared/invoicing/issuance.ts — a render
 * failure only leaves pdfUrl=null.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { invoices, retailerStores as retailerStoresTable } from '@/db/schema/index.js';
import { newId } from '@/shared/ids.js';
import { isStorageConfigured, uploadObject } from '@/shared/storage/index.js';
import { sanitizeKeySegment } from '@/shared/storage/keys.js';
import {
  composeNumber,
  currentFiscalYear,
  resolveNumberingRule,
  reserveNextSequence,
} from '@/shared/invoicing/numbering.js';
import { renderInvoicePdf, type InvoiceLine } from '@/shared/invoicing/pdf.js';
import type { PosPricedLine } from './pricing.js';

const POS_SERIES = 'POS-A';

type Store = typeof retailerStoresTable.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PosInvoiceData = {
  saleId: string;
  store: Store;
  customerName: string | null;
  customerPhone: string | null;
  customerGstin: string | null;
  lines: PosPricedLine[];
  taxSplitKind: 'intra_state' | 'inter_state';
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
};

/**
 * Allocate the next POS invoice number and insert the invoice row within the sale txn.
 * Returns the new invoice id + number; the caller links it onto pos_sales.invoiceId and
 * schedules the PDF render once the txn commits via `schedulePosInvoicePdf`.
 */
export async function insertPosInvoice(
  tx: Tx,
  data: PosInvoiceData,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const store = data.store;
  const fiscalYear = currentFiscalYear();
  const rule = await resolveNumberingRule(tx as unknown as typeof db, store.legalEntityId, store.legalName);
  const sequenceNo = await reserveNextSequence(tx as unknown as typeof db, {
    legalEntityId: store.legalEntityId,
    fiscalYear,
    series: POS_SERIES,
  });
  const invoiceNumber = composeNumber({
    pattern: rule.pattern,
    prefix: `POS-${rule.prefix}`,
    fiscalYear,
    sequenceNo,
  });

  const grandTotalPaise =
    data.taxableValuePaise + data.cgstPaise + data.sgstPaise + data.igstPaise;
  const invoiceId = newId('inv');
  await tx.insert(invoices).values({
    id: invoiceId,
    kind: 'pos_tax_invoice',
    legalEntityId: store.legalEntityId,
    fiscalYear,
    series: POS_SERIES,
    sequenceNo,
    invoiceNumber,
    orderId: null,
    posSaleId: data.saleId,
    storeId: store.id,
    consumerNameSnap: data.customerName?.trim() || 'Walk-in customer',
    consumerBillingAddressSnap: data.customerPhone?.trim() || 'Counter sale',
    consumerGstinSnap: data.customerGstin ?? null,
    storeLegalNameSnap: store.legalName,
    storeAddressSnap: store.address,
    storeGstinSnap: store.gstin,
    storeStateCodeSnap: store.stateCode,
    subtotalPaise: data.taxableValuePaise,
    discountPaise: 0,
    taxableValuePaise: data.taxableValuePaise,
    taxSplitKind: data.taxSplitKind,
    cgstPaise: data.cgstPaise,
    sgstPaise: data.sgstPaise,
    igstPaise: data.igstPaise,
    tcsPaise: 0,
    tcsRateBpSnap: 0,
    grandTotalPaise,
    pdfUrl: null,
    status: 'issued',
    issuedAt: new Date(),
  });

  return { invoiceId, invoiceNumber };
}

/** Schedule the POS invoice PDF render after the sale txn commits. */
export function schedulePosInvoicePdf(input: {
  invoiceId: string;
  invoiceNumber: string;
  data: PosInvoiceData;
}): void {
  setImmediate(() => {
    void renderAndUploadPosInvoicePdf(input).catch((err) => {
      console.error(
        `[pos-invoicing] PDF render failed for invoice ${input.invoiceId}: ${(err as Error).message}`,
      );
    });
  });
}

async function renderAndUploadPosInvoicePdf(input: {
  invoiceId: string;
  invoiceNumber: string;
  data: PosInvoiceData;
}): Promise<void> {
  if (!isStorageConfigured()) return;
  const { data } = input;
  const inter = data.taxSplitKind === 'inter_state';
  const lines: InvoiceLine[] = data.lines.map((l) => {
    // Inter-state → the whole line GST is IGST; intra-state → split CGST+SGST half each.
    const cgst = inter ? 0 : Math.floor(l.gstPaise / 2);
    const sgst = inter ? 0 : l.gstPaise - cgst;
    return {
      description: `${l.listingNameSnap} (${l.attributesLabelSnap})`,
      hsn: l.hsnSnap,
      qty: l.qty,
      unitPricePaise: l.unitMrpPaise,
      gstRateBp: l.gstRateBp,
      taxableValuePaise: l.taxableValuePaise,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: inter ? l.gstPaise : 0,
      totalPaise: l.netLinePaise,
    };
  });

  // Composition dealers issue a Bill of Supply (no GST charged) and must carry the prescribed
  // declaration; regular dealers issue a Tax Invoice.
  const isComposition = data.store.gstScheme === 'composition';
  const buffer = await renderInvoicePdf({
    title: isComposition ? 'BILL OF SUPPLY' : 'TAX INVOICE',
    ...(isComposition && {
      footer: 'Composition taxable person, not eligible to collect tax on supplies.',
    }),
    number: input.invoiceNumber,
    issuedAt: new Date(),
    store: {
      legalName: data.store.legalName,
      address: data.store.address,
      gstin: data.store.gstin,
      stateCode: data.store.stateCode,
    },
    consumer: {
      name: data.customerName?.trim() || 'Walk-in customer',
      billingAddress: data.customerPhone?.trim() || 'Counter sale',
      gstin: data.customerGstin ?? null,
    },
    lines,
    totals: {
      subtotalPaise: data.taxableValuePaise,
      discountPaise: 0,
      taxableValuePaise: data.taxableValuePaise,
      cgstPaise: data.cgstPaise,
      sgstPaise: data.sgstPaise,
      igstPaise: data.igstPaise,
      tcsPaise: 0,
      grandTotalPaise:
        data.taxableValuePaise + data.cgstPaise + data.sgstPaise + data.igstPaise,
    },
  });

  const up = await uploadObject(buffer, {
    folder: 'closetx/pos-invoices',
    resourceType: 'raw',
    contentType: 'application/pdf',
    publicId: sanitizeKeySegment(input.invoiceNumber),
  });
  await db.update(invoices).set({ pdfUrl: up.url }).where(eq(invoices.id, input.invoiceId));
}
