/**
 * Assemble a printable receipt for a POS sale from its frozen snapshots.
 *
 * A receipt is built ENTIRELY from the sale's own snapshot columns + line items + tenders, so a
 * reprint is reproducible long after the live catalog/store details change (same discipline as the
 * GST invoice PDF). The store's `gstScheme` is the only live read — it only picks the document
 * title (Tax Invoice vs Bill of Supply).
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { posSales, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import {
  renderReceiptEscPos,
  renderReceiptText,
  type PosReceipt,
  type PosReceiptTender,
} from './escpos.js';
import type { ResolvedPrinterConfig } from './printer-config.js';

// Readable IST timestamp; no wall-clock read — formats the stored sale date.
const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/**
 * Load a completed/voided sale and shape it into the renderer's `PosReceipt` contract. Returns
 * null when the sale doesn't exist under this store (caller decides the 404).
 */
export async function assembleReceipt(
  database: typeof Db,
  input: { storeId: string; saleId: string; config: ResolvedPrinterConfig },
): Promise<PosReceipt | null> {
  const { storeId, saleId, config } = input;
  const sale = await database.query.posSales.findFirst({
    where: eq(posSales.id, saleId),
    with: { items: true, payments: true, invoice: { columns: { invoiceNumber: true } } },
  });
  if (!sale || sale.storeId !== storeId) return null;

  const [store, cashier] = await Promise.all([
    database.query.retailerStores.findFirst({
      where: eq(retailerStores.id, storeId),
      columns: { gstScheme: true },
    }),
    database.query.retailerAccounts.findFirst({
      where: eq(retailerAccounts.id, sale.cashierAccountId),
      columns: { legalName: true },
    }),
  ]);

  const isReturn = Boolean(sale.originalSaleId);
  const title = isReturn
    ? 'CREDIT NOTE'
    : store?.gstScheme === 'composition'
      ? 'BILL OF SUPPLY'
      : 'TAX INVOICE';

  // Sales collect ('collect'); returns refund ('refund'). Show whichever leg this sale carries.
  const direction = isReturn ? 'refund' : 'collect';
  const tenders: PosReceiptTender[] = sale.payments
    .filter((p) => p.direction === direction)
    .map((p) => ({
      method: p.method,
      amountPaise: p.amountPaise,
      changePaise: p.changePaise,
      reference: p.reference,
    }));

  return {
    title,
    storeName: sale.storeLegalNameSnap,
    storeAddress: sale.storeAddressSnap,
    storeGstin: sale.storeGstinSnap,
    invoiceNumber: sale.invoice?.invoiceNumber ?? null,
    saleId: sale.id,
    isReturn,
    dateTime: IST.format(sale.completedAt ?? sale.createdAt),
    cashier: cashier?.legalName ?? null,
    customerName: sale.customerNameSnap,
    customerPhone: sale.customerPhoneSnap,
    customerGstin: sale.customerGstinSnap,
    lines: sale.items.map((it) => ({
      name: `${it.listingNameSnap} (${it.attributesLabelSnap})`,
      qty: it.qty,
      unitPaise: it.unitMrpPaise,
      gstRateBp: it.gstRateBp,
      lineTotalPaise: it.netLinePaise,
    })),
    itemsGrossPaise: sale.itemsGrossPaise,
    discountPaise: sale.lineDiscountPaise + sale.billDiscountPaise,
    taxableValuePaise: sale.taxableValuePaise,
    cgstPaise: sale.cgstPaise,
    sgstPaise: sale.sgstPaise,
    igstPaise: sale.igstPaise,
    roundOffPaise: sale.roundOffPaise,
    payablePaise: sale.payablePaise,
    tenders,
    changePaise: sale.changePaise,
    headerText: config.headerText,
    footerText: config.footerText,
    showGstBreakup: config.showGstBreakup,
    charsPerLine: config.charsPerLine,
  };
}

/** Convenience: render a receipt to both a base64 ESC/POS blob and a plain-text preview. */
export function renderReceiptPayloads(
  receipt: PosReceipt,
  opts: { copies?: number; drawerKickPin?: 0 | 1 | null },
): { escposBase64: string; text: string } {
  return {
    escposBase64: renderReceiptEscPos(receipt, opts).toString('base64'),
    text: renderReceiptText(receipt),
  };
}
