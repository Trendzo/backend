/**
 * Consumer-facing invoice + credit-note issuance.
 *
 * Tax invoice: issued once per order on delivery. Idempotent.
 * Supplementary: issued per held-item resolved to consumer-kept (redelivered or collected).
 * Credit note: issued per refund that succeeds.
 *
 * All numbering goes through reserveNextSequence() so series stay gap-free per
 * (legal_entity, fiscal_year, series).
 *
 * PDF render happens AFTER the issuance txn commits — render failures only leave pdfUrl=null
 * and never block the invoice row itself. A retry job can backfill.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  creditNotes,
  heldItems as heldItemsTable,
  invoices,
  orderItems as orderItemsTable,
  orders as ordersTable,
  refunds as refundsTable,
  retailerStores as retailerStoresTable,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { newId } from '@/shared/ids.js';
import { isStorageConfigured, uploadObject } from '@/shared/storage/index.js';
import { sanitizeKeySegment } from '@/shared/storage/keys.js';
import { composeNumber, currentFiscalYear, resolveNumberingRule, reserveNextSequence } from './numbering.js';
import { renderInvoicePdf, type InvoiceLine } from './pdf.js';

type Kind = 'tax_invoice' | 'supplementary_invoice';

export type IssueInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string;
  alreadyExisted: boolean;
  pdfUrl: string | null;
};

const SERIES = {
  tax_invoice: 'TAX-A',
  supplementary_invoice: 'SUP-A',
  credit_note: 'CN-A',
} as const;

/** Issue a tax invoice (or supplementary) for an order. */
export async function issueInvoiceForOrder(input: {
  orderId: string;
  kind?: Kind;
  /** For supplementary only: the held-item this supplementary covers. */
  heldItemId?: string;
}): Promise<IssueInvoiceResult> {
  const kind: Kind = input.kind ?? 'tax_invoice';

  return await db.transaction(async (tx) => {
    // Idempotency for tax invoices: one per (orderId, tax_invoice).
    if (kind === 'tax_invoice') {
      const existing = await tx.query.invoices.findFirst({
        where: and(eq(invoices.orderId, input.orderId), eq(invoices.kind, 'tax_invoice')),
      });
      if (existing) {
        return {
          invoiceId: existing.id,
          invoiceNumber: existing.invoiceNumber,
          alreadyExisted: true,
          pdfUrl: existing.pdfUrl,
        };
      }
    }

    // For supplementary: idempotent per heldItemId via composite check (orderId + kind + reason hint).
    // We embed heldItemId into the consumerBillingAddressSnap-adjacent reason in metadata-less schema.
    // Simplest: short-circuit if any supplementary already exists for this orderId+heldItemId pair.
    // The schema has no metadata column, so we use the existing invoiceNumber convention to embed
    // the heldItemId as a suffix when present.
    if (kind === 'supplementary_invoice' && input.heldItemId) {
      const supplExisting = await tx.query.invoices.findMany({
        where: and(
          eq(invoices.orderId, input.orderId),
          eq(invoices.kind, 'supplementary_invoice'),
        ),
      });
      const match = supplExisting.find((row) =>
        row.invoiceNumber.includes(input.heldItemId!.slice(-8)),
      );
      if (match) {
        return {
          invoiceId: match.id,
          invoiceNumber: match.invoiceNumber,
          alreadyExisted: true,
          pdfUrl: match.pdfUrl,
        };
      }
    }

    // Load order + store + items (and heldItem for supplementary).
    const order = await tx.query.orders.findFirst({
      where: eq(ordersTable.id, input.orderId),
    });
    if (!order) throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');

    const store = await tx.query.retailerStores.findFirst({
      where: eq(retailerStoresTable.id, order.storeId),
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

    let lineRows: typeof orderItemsTable.$inferSelect[] = [];
    if (kind === 'tax_invoice') {
      lineRows = await tx
        .select()
        .from(orderItemsTable)
        .where(eq(orderItemsTable.orderId, input.orderId));
    } else {
      // supplementary: only the orderItem linked via the held item.
      if (!input.heldItemId) {
        throw new AppError(
          422,
          ErrorCode.ValidationError,
          'heldItemId required for supplementary invoice',
        );
      }
      const heldRow = await tx.query.heldItems.findFirst({
        where: eq(heldItemsTable.id, input.heldItemId),
        with: { return: { with: { orderItem: true } } },
      });
      if (!heldRow) throw new AppError(404, ErrorCode.HeldItemNotFound, 'Held item not found');
      lineRows = [heldRow.return.orderItem];
    }

    if (lineRows.length === 0) {
      throw new AppError(409, ErrorCode.InvalidState, 'No items to invoice');
    }

    // Totals.
    let subtotalPaise = 0;
    let discountPaise = 0;
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;

    const split = order.taxSplitKind;
    for (const li of lineRows) {
      subtotalPaise += li.lineSubtotalPaise;
      discountPaise +=
        li.retailerPromoAllocPaise +
        li.platformPromoAllocPaise +
        li.couponAllocPaise +
        li.pointsAllocPaise;
      const tax = li.gstAllocPaise;
      if (split === 'intra_state') {
        const half = Math.floor(tax / 2);
        cgstPaise += half;
        sgstPaise += tax - half;
      } else {
        igstPaise += tax;
      }
    }
    const taxableValuePaise = subtotalPaise - discountPaise;
    // TCS: rate snap × taxableValue.
    const tcsPaise = Math.floor((taxableValuePaise * order.tcsRateBpSnap) / 10_000);
    const grandTotalPaise =
      taxableValuePaise + cgstPaise + sgstPaise + igstPaise + tcsPaise;

    // Sequence + numbering.
    const fiscalYear = currentFiscalYear();
    const series = SERIES[kind];
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
    let invoiceNumber = composeNumber({
      pattern: rule.pattern,
      prefix: rule.prefix,
      fiscalYear,
      sequenceNo,
    });
    if (kind === 'supplementary_invoice' && input.heldItemId) {
      // Embed last 8 of heldItemId as a suffix tag for idempotency lookups.
      invoiceNumber = `${invoiceNumber}-${input.heldItemId.slice(-8)}`;
    }

    const billingAddress = buildBillingAddress(order);

    const invoiceId = newId('inv');
    await tx.insert(invoices).values({
      id: invoiceId,
      kind,
      legalEntityId: store.legalEntityId,
      fiscalYear,
      series,
      sequenceNo,
      invoiceNumber,
      orderId: order.id,
      storeId: store.id,
      consumerNameSnap: order.consumerNameSnap,
      consumerBillingAddressSnap: billingAddress,
      consumerGstinSnap: null,
      storeLegalNameSnap: store.legalName,
      storeAddressSnap: store.address,
      storeGstinSnap: store.gstin,
      storeStateCodeSnap: store.stateCode,
      subtotalPaise,
      discountPaise,
      taxableValuePaise,
      taxSplitKind: split,
      cgstPaise,
      sgstPaise,
      igstPaise,
      tcsPaise,
      tcsRateBpSnap: order.tcsRateBpSnap,
      grandTotalPaise,
      pdfUrl: null,
      status: 'issued',
      issuedAt: new Date(),
    });

    // Snapshot for post-commit pdf render.
    const renderInput = {
      invoiceId,
      invoiceNumber,
      kind,
      lineRows,
      order,
      store,
      taxSplit: split,
      cgstPaise,
      sgstPaise,
      igstPaise,
      tcsPaise,
      grandTotalPaise,
      subtotalPaise,
      discountPaise,
      taxableValuePaise,
      consumerName: order.consumerNameSnap,
      billingAddress,
    };

    // Schedule render after the txn commits (don't block, but settle within request).
    setImmediate(() => {
      void renderAndUploadInvoicePdf(renderInput).catch((err) => {
        console.error(
          `[invoicing] PDF render failed for invoice ${invoiceId}: ${(err as Error).message}`,
        );
      });
    });

    return {
      invoiceId,
      invoiceNumber,
      alreadyExisted: false,
      pdfUrl: null,
    };
  });
}

async function renderAndUploadInvoicePdf(input: {
  invoiceId: string;
  invoiceNumber: string;
  kind: Kind;
  lineRows: typeof orderItemsTable.$inferSelect[];
  order: typeof ordersTable.$inferSelect;
  store: typeof retailerStoresTable.$inferSelect;
  taxSplit: 'intra_state' | 'inter_state';
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  tcsPaise: number;
  grandTotalPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  consumerName: string;
  billingAddress: string;
}): Promise<void> {
  if (!isStorageConfigured()) {
    return; // skip in environments without media uploads
  }
  const lines: InvoiceLine[] = input.lineRows.map((li) => {
    const tax = li.gstAllocPaise;
    const cgst = input.taxSplit === 'intra_state' ? Math.floor(tax / 2) : 0;
    const sgst = input.taxSplit === 'intra_state' ? tax - cgst : 0;
    const igst = input.taxSplit === 'inter_state' ? tax : 0;
    const taxable =
      li.lineSubtotalPaise -
      (li.retailerPromoAllocPaise +
        li.platformPromoAllocPaise +
        li.couponAllocPaise +
        li.pointsAllocPaise);
    return {
      description: `${li.listingNameSnap} (${li.attributesLabelSnap})`,
      hsn: li.hsnSnap,
      qty: li.qty,
      unitPricePaise: li.unitPricePaise,
      gstRateBp: li.gstRateBp,
      taxableValuePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      totalPaise: taxable + tax,
    };
  });

  const titleMap: Record<Kind, string> = {
    tax_invoice: 'TAX INVOICE',
    supplementary_invoice: 'SUPPLEMENTARY TAX INVOICE',
  };

  const buffer = await renderInvoicePdf({
    title: titleMap[input.kind],
    number: input.invoiceNumber,
    issuedAt: new Date(),
    store: {
      legalName: input.store.legalName,
      address: input.store.address,
      gstin: input.store.gstin,
      stateCode: input.store.stateCode,
    },
    consumer: {
      name: input.consumerName,
      billingAddress: input.billingAddress,
      gstin: null,
    },
    lines,
    totals: {
      subtotalPaise: input.subtotalPaise,
      discountPaise: input.discountPaise,
      taxableValuePaise: input.taxableValuePaise,
      cgstPaise: input.cgstPaise,
      sgstPaise: input.sgstPaise,
      igstPaise: input.igstPaise,
      tcsPaise: input.tcsPaise,
      grandTotalPaise: input.grandTotalPaise,
    },
  });

  const up = await uploadObject(buffer, {
    folder: 'closetx/invoices',
    resourceType: 'raw',
    contentType: 'application/pdf',
    publicId: sanitizeKeySegment(input.invoiceNumber),
  });
  await db.update(invoices).set({ pdfUrl: up.url }).where(eq(invoices.id, input.invoiceId));
}

export type IssueCreditNoteResult = {
  creditNoteId: string;
  creditNoteNumber: string;
  alreadyExisted: boolean;
  pdfUrl: string | null;
};

/** Issue a credit note against the parent tax invoice for an accepted refund. */
export async function issueCreditNoteForRefund(input: {
  refundId: string;
  reason: string;
}): Promise<IssueCreditNoteResult> {
  return await db.transaction(async (tx) => {
    // Idempotent per refundId.
    const existing = await tx.query.creditNotes.findFirst({
      where: eq(creditNotes.refundId, input.refundId),
    });
    if (existing) {
      return {
        creditNoteId: existing.id,
        creditNoteNumber: existing.creditNoteNumber,
        alreadyExisted: true,
        pdfUrl: existing.pdfUrl,
      };
    }

    const refund = await tx.query.refunds.findFirst({
      where: eq(refundsTable.id, input.refundId),
      with: { lines: true },
    });
    if (!refund) throw new AppError(404, ErrorCode.RefundNotFound, 'Refund not found');

    // Parent tax invoice for the order — must exist.
    const parent = await tx.query.invoices.findFirst({
      where: and(eq(invoices.orderId, refund.orderId), eq(invoices.kind, 'tax_invoice')),
    });
    if (!parent) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot issue credit note: parent tax invoice not yet issued for this order',
      );
    }

    const taxReversedPaise = refund.lines.reduce((s, l) => s + l.taxRefundPaise, 0);
    const subtotalReversedPaise = refund.lines.reduce(
      (s, l) =>
        s + l.refundedAmountPaise - l.taxRefundPaise + l.couponClawbackPaise + l.pointsClawbackPaise,
      0,
    );
    // TCS proportional to the share of the parent invoice being reversed.
    const tcsReversedPaise =
      parent.grandTotalPaise > 0
        ? Math.floor((parent.tcsPaise * refund.totalRefundPaise) / parent.grandTotalPaise)
        : 0;
    const grandTotalReversedPaise = refund.totalRefundPaise;

    const fiscalYear = currentFiscalYear();
    const series = SERIES.credit_note;
    const rule = await resolveNumberingRule(
      tx as unknown as typeof db,
      parent.legalEntityId,
      parent.storeLegalNameSnap,
    );
    const sequenceNo = await reserveNextSequence(tx as unknown as typeof db, {
      legalEntityId: parent.legalEntityId,
      fiscalYear,
      series,
    });
    const creditNoteNumber = composeNumber({
      pattern: rule.pattern,
      prefix: `CN-${rule.prefix}`,
      fiscalYear,
      sequenceNo,
    });

    const creditNoteId = newId('cn');
    await tx.insert(creditNotes).values({
      id: creditNoteId,
      parentInvoiceId: parent.id,
      refundId: refund.id,
      legalEntityId: parent.legalEntityId,
      fiscalYear,
      series,
      sequenceNo,
      creditNoteNumber,
      consumerNameSnap: parent.consumerNameSnap,
      consumerBillingAddressSnap: parent.consumerBillingAddressSnap,
      consumerGstinSnap: parent.consumerGstinSnap,
      reason: input.reason,
      subtotalReversedPaise,
      taxReversedPaise,
      tcsReversedPaise,
      grandTotalReversedPaise,
      pdfUrl: null,
      issuedAt: new Date(),
    });

    const snapshot = {
      creditNoteId,
      creditNoteNumber,
      parent,
      reason: input.reason,
      subtotalReversedPaise,
      taxReversedPaise,
      tcsReversedPaise,
      grandTotalReversedPaise,
    };
    setImmediate(() => {
      void renderAndUploadCreditNotePdf(snapshot).catch((err) => {
        console.error(
          `[invoicing] PDF render failed for credit note ${creditNoteId}: ${(err as Error).message}`,
        );
      });
    });

    return {
      creditNoteId,
      creditNoteNumber,
      alreadyExisted: false,
      pdfUrl: null,
    };
  });
}

async function renderAndUploadCreditNotePdf(input: {
  creditNoteId: string;
  creditNoteNumber: string;
  parent: typeof invoices.$inferSelect;
  reason: string;
  subtotalReversedPaise: number;
  taxReversedPaise: number;
  tcsReversedPaise: number;
  grandTotalReversedPaise: number;
}): Promise<void> {
  if (!isStorageConfigured()) return;

  const taxSplit = input.parent.taxSplitKind;
  const cgst = taxSplit === 'intra_state' ? Math.floor(input.taxReversedPaise / 2) : 0;
  const sgst = taxSplit === 'intra_state' ? input.taxReversedPaise - cgst : 0;
  const igst = taxSplit === 'inter_state' ? input.taxReversedPaise : 0;

  const buffer = await renderInvoicePdf({
    title: 'CREDIT NOTE',
    number: input.creditNoteNumber,
    issuedAt: new Date(),
    parentInvoiceNumber: input.parent.invoiceNumber,
    reason: input.reason,
    store: {
      legalName: input.parent.storeLegalNameSnap,
      address: input.parent.storeAddressSnap,
      gstin: input.parent.storeGstinSnap,
      stateCode: input.parent.storeStateCodeSnap,
    },
    consumer: {
      name: input.parent.consumerNameSnap,
      billingAddress: input.parent.consumerBillingAddressSnap,
      gstin: input.parent.consumerGstinSnap,
    },
    lines: [
      {
        description: `Reversal — see invoice ${input.parent.invoiceNumber}`,
        hsn: null,
        qty: 1,
        unitPricePaise: input.subtotalReversedPaise,
        gstRateBp: 0,
        taxableValuePaise: input.subtotalReversedPaise,
        cgstPaise: cgst,
        sgstPaise: sgst,
        igstPaise: igst,
        totalPaise: input.subtotalReversedPaise + input.taxReversedPaise,
      },
    ],
    totals: {
      subtotalPaise: input.subtotalReversedPaise,
      discountPaise: 0,
      taxableValuePaise: input.subtotalReversedPaise,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      tcsPaise: input.tcsReversedPaise,
      grandTotalPaise: input.grandTotalReversedPaise,
    },
  });
  const up = await uploadObject(buffer, {
    folder: 'closetx/credit-notes',
    resourceType: 'raw',
    contentType: 'application/pdf',
    publicId: sanitizeKeySegment(input.creditNoteNumber),
  });
  await db.update(creditNotes).set({ pdfUrl: up.url }).where(eq(creditNotes.id, input.creditNoteId));
}

function buildBillingAddress(order: typeof ordersTable.$inferSelect): string {
  const parts = [
    order.addressLine1Snap,
    order.addressLine2Snap,
    order.addressCitySnap,
    order.addressPincodeSnap,
    order.addressStateCodeSnap,
  ].filter((p): p is string => Boolean(p && p.length));
  if (parts.length === 0) {
    // Pickup orders may lack address. Fall back to consumer's name + a tag.
    return `${order.consumerNameSnap} — in-store pickup`;
  }
  return parts.join(', ');
}


