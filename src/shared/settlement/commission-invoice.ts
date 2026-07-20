/**
 * §18 — per-order commission invoice (ClosetX → retailer; ITC for the store).
 *
 * Reuses §17 numbering + sequence infrastructure. Series 'COMM-A'. Idempotent on
 * (orderId, kind='commission_invoice'). One line:
 *   commission = floor(itemsSubtotal × platformFeeBpSnap / 10_000)
 *   GST on commission = 18% (intra-state CGST 9 + SGST 9, inter-state IGST 18)
 *   grandTotal = commission + GST
 * No TCS on commission (TCS is on the consumer sale, not the platform fee).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  invoices,
  orders as ordersTable,
  retailerStores as retailerStoresTable,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';
import { isStorageConfigured, uploadObject } from '@/shared/storage/index.js';
import { sanitizeKeySegment } from '@/shared/storage/keys.js';
import { composeNumber, currentFiscalYear, resolveNumberingRule, reserveNextSequence } from '@/shared/invoicing/numbering.js';
import { renderInvoicePdf } from '@/shared/invoicing/pdf.js';

const COMMISSION_GST_RATE_BP = 1800;

export type IssueCommissionInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string;
  alreadyExisted: boolean;
  pdfUrl: string | null;
};

export async function issueCommissionInvoiceForOrder(input: {
  orderId: string;
}): Promise<IssueCommissionInvoiceResult> {
  return await db.transaction(async (tx) => {
    const existing = await tx.query.invoices.findFirst({
      where: and(eq(invoices.orderId, input.orderId), eq(invoices.kind, 'commission_invoice')),
    });
    if (existing) {
      return {
        invoiceId: existing.id,
        invoiceNumber: existing.invoiceNumber,
        alreadyExisted: true,
        pdfUrl: existing.pdfUrl,
      };
    }

    const order = await tx.query.orders.findFirst({
      where: eq(ordersTable.id, input.orderId),
    });
    if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
    const store = await tx.query.retailerStores.findFirst({
      where: eq(retailerStoresTable.id, order.storeId),
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

    const commissionPaise = Math.floor((order.itemsSubtotalPaise * order.platformFeeBpSnap) / 10_000);
    if (commissionPaise === 0) {
      throw new AppError(409, ErrorCode.InvalidState, 'Commission is zero — no invoice needed');
    }
    const tax = Math.floor((commissionPaise * COMMISSION_GST_RATE_BP) / 10_000);
    const split = order.taxSplitKind;
    const cgst = split === 'intra_state' ? Math.floor(tax / 2) : 0;
    const sgst = split === 'intra_state' ? tax - cgst : 0;
    const igst = split === 'inter_state' ? tax : 0;
    const grandTotal = commissionPaise + tax;

    const fiscalYear = currentFiscalYear();
    const series = 'COMM-A';
    const rule = await resolveNumberingRule(
      tx as unknown as typeof db,
      store.legalEntityId,
      store.legalName,
    );
    const sequenceNo = await reserveNextSequence(tx as unknown as typeof db, {
      legalEntityId: store.legalEntityId,
      fiscalYear,
      series,
    });
    const invoiceNumber = composeNumber({
      pattern: rule.pattern,
      prefix: `COMM-${rule.prefix}`,
      fiscalYear,
      sequenceNo,
    });

    const billingAddress = store.address;
    const invoiceId = newId('inv');
    await tx.insert(invoices).values({
      id: invoiceId,
      kind: 'commission_invoice',
      legalEntityId: store.legalEntityId,
      fiscalYear,
      series,
      sequenceNo,
      invoiceNumber,
      orderId: order.id,
      storeId: store.id,
      // Commission invoice is ClosetX → retailer. "Consumer" snap fields here repurposed for
      // the retailer (recipient of the bill). Schema keeps the column names neutral.
      consumerNameSnap: store.legalName,
      consumerBillingAddressSnap: billingAddress,
      consumerGstinSnap: store.gstin,
      storeLegalNameSnap: 'ClosetX',
      storeAddressSnap: 'ClosetX Platform Services',
      storeGstinSnap: 'PLATFORM-GSTIN',
      storeStateCodeSnap: store.stateCode,
      subtotalPaise: commissionPaise,
      discountPaise: 0,
      taxableValuePaise: commissionPaise,
      taxSplitKind: split,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      tcsPaise: 0,
      tcsRateBpSnap: 0,
      grandTotalPaise: grandTotal,
      pdfUrl: null,
      status: 'issued',
      issuedAt: new Date(),
    });

    const renderSnapshot = {
      invoiceId,
      invoiceNumber,
      commissionPaise,
      cgst,
      sgst,
      igst,
      grandTotal,
      store,
      orderId: order.id,
    };

    setImmediate(() => {
      void renderAndUploadCommissionPdf(renderSnapshot).catch((err) => {
        console.error(
          `[settlement] commission PDF render failed for ${invoiceId}: ${(err as Error).message}`,
        );
      });
    });

    return { invoiceId, invoiceNumber, alreadyExisted: false, pdfUrl: null };
  });
}

async function renderAndUploadCommissionPdf(input: {
  invoiceId: string;
  invoiceNumber: string;
  commissionPaise: number;
  cgst: number;
  sgst: number;
  igst: number;
  grandTotal: number;
  store: typeof retailerStoresTable.$inferSelect;
  orderId: string;
}): Promise<void> {
  if (!isStorageConfigured()) return;
  const buffer = await renderInvoicePdf({
    title: 'COMMISSION INVOICE',
    number: input.invoiceNumber,
    issuedAt: new Date(),
    store: {
      legalName: 'ClosetX',
      address: 'ClosetX Platform Services',
      gstin: 'PLATFORM-GSTIN',
      stateCode: input.store.stateCode,
    },
    consumer: {
      name: input.store.legalName,
      billingAddress: input.store.address,
      gstin: input.store.gstin,
    },
    lines: [
      {
        description: `Platform commission for order ${input.orderId}`,
        hsn: '9985',
        qty: 1,
        unitPricePaise: input.commissionPaise,
        gstRateBp: 1800,
        taxableValuePaise: input.commissionPaise,
        cgstPaise: input.cgst,
        sgstPaise: input.sgst,
        igstPaise: input.igst,
        totalPaise: input.commissionPaise + input.cgst + input.sgst + input.igst,
      },
    ],
    totals: {
      subtotalPaise: input.commissionPaise,
      discountPaise: 0,
      taxableValuePaise: input.commissionPaise,
      cgstPaise: input.cgst,
      sgstPaise: input.sgst,
      igstPaise: input.igst,
      tcsPaise: 0,
      grandTotalPaise: input.grandTotal,
    },
    footer: `Commission invoice issued by ClosetX to ${input.store.legalName} (${input.store.gstin}). Eligible for input tax credit.`,
  });
  const up = await uploadObject(buffer, {
    folder: 'closetx/commission-invoices',
    resourceType: 'raw',
    contentType: 'application/pdf',
    publicId: sanitizeKeySegment(input.invoiceNumber),
  });
  await db.update(invoices).set({ pdfUrl: up.url }).where(eq(invoices.id, input.invoiceId));
}
