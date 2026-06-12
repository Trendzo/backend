/**
 * Offline POS sale engine — the transactional boundary for counter billing.
 *
 * Mirrors shared/orders/place-order.ts, but a counter sale settles INSTANTLY: instead of
 * reserving stock it DECREMENTS `variants.stock` outright (CAS-guarded so it can never oversell
 * against online holds), records the cash collected, and issues a GST tax invoice in one txn.
 *
 *   completePosSale  — ring up + settle (optionally finalising a parked bill).
 *   holdPosSale      — park a bill (no stock movement, no invoice).
 *   voidPosSale      — reverse a completed sale same-day (restock + credit note).
 *   createPosReturn  — return/exchange against a prior sale (restock + refund + credit note).
 *   quotePosSale     — server-authoritative totals preview (no writes).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  creditNotes,
  inventoryAdjustments,
  invoices,
  posCustomers,
  posPayments,
  posReturnLines,
  posSaleItems,
  posSales,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  composeNumber,
  currentFiscalYear,
  resolveNumberingRule,
  reserveNextSequence,
} from '@/shared/invoicing/numbering.js';
import {
  gstRateBpForLine,
  pricePosSale,
  type PosPricing,
  type PosPricingMode,
  type PricingVariant,
} from './pricing.js';
import { insertPosInvoice, schedulePosInvoicePdf, type PosInvoiceData } from './pos-invoice.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type Store = typeof retailerStores.$inferSelect;

export type PosLineInput = { variantId: string; qty: number; lineDiscountPaise?: number | undefined };
export type PosTenderInput = {
  method: 'cash' | 'card' | 'upi';
  amountPaise: number;
  tenderedPaise?: number | undefined;
  reference?: string | undefined;
};
export type PosCustomerInput = {
  id?: string | undefined;
  name?: string | null | undefined;
  phone?: string | null | undefined;
  gstin?: string | null | undefined;
};

// ───────────────────────── shared helpers ─────────────────────────

/** Merge duplicate variant lines (same variant scanned twice) into one, summing qty. */
function mergeLines(lines: PosLineInput[]): PosLineInput[] {
  const map = new Map<string, PosLineInput>();
  for (const l of lines) {
    const existing = map.get(l.variantId);
    if (existing) {
      existing.qty += l.qty;
      existing.lineDiscountPaise = (existing.lineDiscountPaise ?? 0) + (l.lineDiscountPaise ?? 0);
    } else {
      map.set(l.variantId, { ...l });
    }
  }
  return [...map.values()];
}

/** Load + validate a store for counter sales. */
async function loadActiveStore(database: typeof Db, storeId: string): Promise<Store> {
  const store = await database.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  if (store.status !== 'active' && store.status !== 'paused') {
    throw new AppError(
      409,
      ErrorCode.OrderStoreUnavailable,
      `Store is not open for billing (status='${store.status}')`,
    );
  }
  return store;
}

/** Resolve variants for pricing: validate store ownership + active, build PricingVariant[]. */
async function resolvePricingVariants(
  database: typeof Db,
  storeId: string,
  lines: PosLineInput[],
): Promise<{ pricing: PricingVariant[]; rows: VariantRow[] }> {
  if (lines.length === 0) throw AppError.validation('At least one item is required');
  const ids = lines.map((l) => l.variantId);
  const rows = (await database.query.variants.findMany({
    where: inArray(variants.id, ids),
    with: { listing: { with: { brand: true, category: true } } },
  })) as VariantRow[];
  if (rows.length !== new Set(ids).size) {
    throw new AppError(404, ErrorCode.NotFound, 'One or more items not found');
  }
  const pricing: PricingVariant[] = rows.map((v) => {
    if (v.listing.storeId !== storeId) {
      throw AppError.validation(`Item ${v.id} belongs to a different store`);
    }
    if (v.listing.status !== 'active') {
      throw new AppError(409, ErrorCode.InvalidState, `"${v.listing.name}" is not available for sale`);
    }
    if (!v.isActive) {
      throw new AppError(409, ErrorCode.InvalidState, `"${v.attributesLabel}" is not available for sale`);
    }
    return {
      variantId: v.id,
      listingId: v.listing.id,
      unitMrpPaise: v.pricePaise,
      gstRateBp: gstRateBpForLine(v.listing.hsn, v.pricePaise),
      listingNameSnap: v.listing.name,
      brandSnap: v.listing.brand?.name ?? null,
      categorySnap: v.listing.category?.label ?? null,
      attributesLabelSnap: v.attributesLabel,
      hsnSnap: v.listing.hsn,
      skuSnap: v.sku,
      barcodeSnap: v.barcode,
    };
  });
  return { pricing, rows };
}

type VariantRow = typeof variants.$inferSelect & {
  listing: {
    id: string;
    storeId: string;
    status: string;
    name: string;
    hsn: string | null;
    brand: { name: string } | null;
    category: { label: string } | null;
  };
};

function validateTenders(tenders: PosTenderInput[], payablePaise: number): {
  tenderedPaise: number;
  changePaise: number;
} {
  const applied = tenders.reduce((s, t) => s + t.amountPaise, 0);
  if (applied !== payablePaise) {
    throw new AppError(
      400,
      ErrorCode.ValidationError,
      `Payments (${applied}) must equal the amount due (${payablePaise})`,
    );
  }
  const tendered = tenders.reduce((s, t) => s + (t.tenderedPaise ?? t.amountPaise), 0);
  return { tenderedPaise: tendered, changePaise: Math.max(0, tendered - payablePaise) };
}

// ───────────────────────── quote (no writes) ─────────────────────────

export type QuoteResult = PosPricing & {
  lines: (PosPricing['lines'][number] & { availableQty: number })[];
};

export async function quotePosSale(
  database: typeof Db,
  input: {
    storeId: string;
    lines: PosLineInput[];
    billDiscountPaise?: number;
    pricingMode?: PosPricingMode;
  },
): Promise<QuoteResult> {
  const lines = mergeLines(input.lines);
  await loadActiveStore(database, input.storeId);
  const { pricing, rows } = await resolvePricingVariants(database, input.storeId, lines);
  const availableById = new Map(rows.map((v) => [v.id, v.stock - v.reserved]));
  const priced = pricePosSale({
    variants: pricing,
    lines,
    ...(input.billDiscountPaise !== undefined && { billDiscountPaise: input.billDiscountPaise }),
    ...(input.pricingMode !== undefined && { pricingMode: input.pricingMode }),
  });
  return {
    ...priced,
    lines: priced.lines.map((l) => ({ ...l, availableQty: availableById.get(l.variantId) ?? 0 })),
  };
}

// ───────────────────────── complete (settle) ─────────────────────────

export type CompletePosSaleInput = {
  storeId: string;
  cashierAccountId: string;
  idempotencyKey: string;
  /** When finalising a parked bill, the held sale row to reuse. */
  holdSaleId?: string;
  customer?: PosCustomerInput;
  pricingMode?: PosPricingMode;
  billDiscountPaise?: number;
  note?: string;
  lines: PosLineInput[];
  tenders: PosTenderInput[];
};

export type CompletePosSaleResult = {
  saleId: string;
  invoiceId: string;
  invoiceNumber: string;
  payablePaise: number;
  changePaise: number;
  alreadyExisted: boolean;
};

export async function completePosSale(
  database: typeof Db,
  input: CompletePosSaleInput,
): Promise<CompletePosSaleResult> {
  // Idempotency — a completed sale with this key already exists.
  const existing = await database.query.posSales.findFirst({
    where: eq(posSales.idempotencyKey, input.idempotencyKey),
  });
  if (existing && existing.status === 'completed') {
    return {
      saleId: existing.id,
      invoiceId: existing.invoiceId ?? '',
      invoiceNumber: '',
      payablePaise: existing.payablePaise,
      changePaise: existing.changePaise,
      alreadyExisted: true,
    };
  }

  const lines = mergeLines(input.lines);
  const store = await loadActiveStore(database, input.storeId);

  const cashier = await database.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, input.cashierAccountId),
  });
  if (!cashier || cashier.storeId !== store.id) {
    throw new AppError(403, ErrorCode.Forbidden, 'Cashier does not belong to this store');
  }

  const { pricing } = await resolvePricingVariants(database, store.id, lines);
  const priced = pricePosSale({
    variants: pricing,
    lines,
    ...(input.billDiscountPaise !== undefined && { billDiscountPaise: input.billDiscountPaise }),
    ...(input.pricingMode !== undefined && { pricingMode: input.pricingMode }),
  });
  const { tenderedPaise, changePaise } = validateTenders(input.tenders, priced.payablePaise);

  // Reuse the parked bill row id when finalising a held bill; else mint a new sale id.
  // Computed up front so inventory adjustments can reference the sale itself.
  const saleId = input.holdSaleId ?? newId(IdPrefix.PosSale);

  const result = await database.transaction(async (tx) => {
    // Decrement shared stock atomically — never oversell against online reservations.
    for (const l of lines) {
      const [updated] = await tx
        .update(variants)
        .set({ stock: sql`${variants.stock} - ${l.qty}` })
        .where(
          and(eq(variants.id, l.variantId), sql`${variants.stock} - ${variants.reserved} >= ${l.qty}`),
        )
        .returning({ stock: variants.stock });
      if (!updated) {
        throw new AppError(
          409,
          ErrorCode.OrderStockUnavailable,
          `Insufficient stock for one or more items`,
        );
      }
      await tx.insert(inventoryAdjustments).values({
        id: newId(IdPrefix.InventoryAdjustment),
        variantId: l.variantId,
        delta: -l.qty,
        newStock: updated.stock,
        reason: 'pos_sale',
        actorKind: 'retailer',
        actorId: input.cashierAccountId,
        refKind: 'pos_sale',
        refId: saleId,
      });
    }

    const customerId = await upsertCustomer(tx, store.id, input.customer);

    const saleValues = {
      storeId: store.id,
      cashierAccountId: input.cashierAccountId,
      customerId: customerId ?? null,
      status: 'completed' as const,
      note: input.note ?? null,
      customerNameSnap: input.customer?.name ?? null,
      customerPhoneSnap: input.customer?.phone ?? null,
      customerGstinSnap: input.customer?.gstin ?? null,
      storeLegalNameSnap: store.legalName,
      storeGstinSnap: store.gstin,
      storeStateCodeSnap: store.stateCode,
      storeAddressSnap: store.address,
      taxSplitKind: 'intra_state' as const,
      pricingMode: input.pricingMode ?? ('tax_inclusive' as const),
      itemsGrossPaise: priced.itemsGrossPaise,
      lineDiscountPaise: priced.lineDiscountPaise,
      billDiscountPaise: priced.billDiscountPaise,
      taxableValuePaise: priced.taxableValuePaise,
      cgstPaise: priced.cgstPaise,
      sgstPaise: priced.sgstPaise,
      igstPaise: priced.igstPaise,
      taxPaise: priced.taxPaise,
      roundOffPaise: priced.roundOffPaise,
      payablePaise: priced.payablePaise,
      tenderedPaise,
      changePaise,
      idempotencyKey: input.idempotencyKey,
      completedAt: new Date(),
      updatedAt: new Date(),
    };

    if (input.holdSaleId) {
      const held = await tx.query.posSales.findFirst({ where: eq(posSales.id, input.holdSaleId) });
      if (!held || held.storeId !== store.id) {
        throw new AppError(404, ErrorCode.NotFound, 'Held bill not found');
      }
      if (held.status !== 'held') {
        throw new AppError(409, ErrorCode.InvalidState, 'Bill is no longer held');
      }
      await tx.delete(posSaleItems).where(eq(posSaleItems.saleId, input.holdSaleId));
      await tx.update(posSales).set(saleValues).where(eq(posSales.id, input.holdSaleId));
    } else {
      await tx.insert(posSales).values({ id: saleId, ...saleValues });
    }

    await insertSaleItems(tx, saleId, priced);

    for (const t of input.tenders) {
      await tx.insert(posPayments).values({
        id: newId(IdPrefix.PosPayment),
        saleId,
        method: t.method,
        direction: 'collect',
        amountPaise: t.amountPaise,
        tenderedPaise: t.tenderedPaise ?? null,
        changePaise: t.method === 'cash' ? Math.max(0, (t.tenderedPaise ?? t.amountPaise) - t.amountPaise) : 0,
        reference: t.reference ?? null,
      });
    }

    const invoiceData: PosInvoiceData = {
      saleId,
      store,
      customerName: input.customer?.name ?? null,
      customerPhone: input.customer?.phone ?? null,
      customerGstin: input.customer?.gstin ?? null,
      lines: priced.lines,
      taxableValuePaise: priced.taxableValuePaise,
      cgstPaise: priced.cgstPaise,
      sgstPaise: priced.sgstPaise,
    };
    const { invoiceId, invoiceNumber } = await insertPosInvoice(tx, invoiceData);
    await tx.update(posSales).set({ invoiceId }).where(eq(posSales.id, saleId));

    return { saleId, invoiceId, invoiceNumber, invoiceData };
  });

  schedulePosInvoicePdf({
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
    data: result.invoiceData,
  });

  return {
    saleId: result.saleId,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
    payablePaise: priced.payablePaise,
    changePaise,
    alreadyExisted: false,
  };
}

// ───────────────────────── hold (park bill) ─────────────────────────

export async function holdPosSale(
  database: typeof Db,
  input: {
    storeId: string;
    cashierAccountId: string;
    idempotencyKey: string;
    customer?: PosCustomerInput;
    pricingMode?: PosPricingMode;
    billDiscountPaise?: number;
    note?: string;
    lines: PosLineInput[];
  },
): Promise<{ saleId: string; alreadyExisted: boolean }> {
  const existing = await database.query.posSales.findFirst({
    where: eq(posSales.idempotencyKey, input.idempotencyKey),
  });
  if (existing) return { saleId: existing.id, alreadyExisted: true };

  const lines = mergeLines(input.lines);
  const store = await loadActiveStore(database, input.storeId);
  const { pricing } = await resolvePricingVariants(database, store.id, lines);
  const priced = pricePosSale({
    variants: pricing,
    lines,
    ...(input.billDiscountPaise !== undefined && { billDiscountPaise: input.billDiscountPaise }),
    ...(input.pricingMode !== undefined && { pricingMode: input.pricingMode }),
  });

  const saleId = newId(IdPrefix.PosSale);
  await database.transaction(async (tx) => {
    const customerId = await upsertCustomer(tx, store.id, input.customer);
    await tx.insert(posSales).values({
      id: saleId,
      storeId: store.id,
      cashierAccountId: input.cashierAccountId,
      customerId: customerId ?? null,
      status: 'held',
      note: input.note ?? null,
      customerNameSnap: input.customer?.name ?? null,
      customerPhoneSnap: input.customer?.phone ?? null,
      customerGstinSnap: input.customer?.gstin ?? null,
      storeLegalNameSnap: store.legalName,
      storeGstinSnap: store.gstin,
      storeStateCodeSnap: store.stateCode,
      storeAddressSnap: store.address,
      pricingMode: input.pricingMode ?? 'tax_inclusive',
      itemsGrossPaise: priced.itemsGrossPaise,
      lineDiscountPaise: priced.lineDiscountPaise,
      billDiscountPaise: priced.billDiscountPaise,
      taxableValuePaise: priced.taxableValuePaise,
      cgstPaise: priced.cgstPaise,
      sgstPaise: priced.sgstPaise,
      igstPaise: priced.igstPaise,
      taxPaise: priced.taxPaise,
      roundOffPaise: priced.roundOffPaise,
      payablePaise: priced.payablePaise,
      idempotencyKey: input.idempotencyKey,
      heldAt: new Date(),
    });
    await insertSaleItems(tx, saleId, priced);
  });
  return { saleId, alreadyExisted: false };
}

// ───────────────────────── void ─────────────────────────

export async function voidPosSale(
  database: typeof Db,
  input: { storeId: string; saleId: string; actorId: string; reason: string },
): Promise<{ saleId: string; creditNoteId: string | null }> {
  return await database.transaction(async (tx) => {
    const sale = await tx.query.posSales.findFirst({
      where: eq(posSales.id, input.saleId),
      with: { items: true },
    });
    if (!sale || sale.storeId !== input.storeId) {
      throw new AppError(404, ErrorCode.NotFound, 'Sale not found');
    }
    if (sale.status !== 'completed') {
      throw new AppError(409, ErrorCode.InvalidState, `Cannot void a ${sale.status} sale`);
    }

    // Restore stock.
    for (const it of sale.items) {
      const [updated] = await tx
        .update(variants)
        .set({ stock: sql`${variants.stock} + ${it.qty}` })
        .where(eq(variants.id, it.variantId))
        .returning({ stock: variants.stock });
      await tx.insert(inventoryAdjustments).values({
        id: newId(IdPrefix.InventoryAdjustment),
        variantId: it.variantId,
        delta: it.qty,
        newStock: updated?.stock ?? 0,
        reason: 'pos_void_restock',
        actorKind: 'retailer',
        actorId: input.actorId,
        refKind: 'pos_sale',
        refId: sale.id,
      });
    }

    await tx
      .update(posSales)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: input.reason, updatedAt: new Date() })
      .where(eq(posSales.id, sale.id));

    // Credit note against the POS invoice (full reversal).
    let creditNoteId: string | null = null;
    if (sale.invoiceId) {
      creditNoteId = await insertPosCreditNote(tx, {
        invoiceId: sale.invoiceId,
        reason: `Void: ${input.reason}`,
        subtotalReversedPaise: sale.taxableValuePaise,
        taxReversedPaise: sale.taxPaise,
        grandTotalReversedPaise: sale.taxableValuePaise + sale.taxPaise,
      });
    }
    return { saleId: sale.id, creditNoteId };
  });
}

// ───────────────────────── return / exchange ─────────────────────────

export type PosReturnInput = {
  storeId: string;
  cashierAccountId: string;
  idempotencyKey: string;
  originalSaleId: string;
  reason: string;
  lines: { originalSaleItemId: string; qty: number; restock?: boolean | undefined }[];
  refundTenders: PosTenderInput[];
};

export async function createPosReturn(
  database: typeof Db,
  input: PosReturnInput,
): Promise<{ returnSaleId: string; refundPaise: number; creditNoteId: string | null }> {
  const existing = await database.query.posSales.findFirst({
    where: eq(posSales.idempotencyKey, input.idempotencyKey),
  });
  if (existing) {
    return { returnSaleId: existing.id, refundPaise: existing.payablePaise, creditNoteId: null };
  }

  return await database.transaction(async (tx) => {
    const original = await tx.query.posSales.findFirst({
      where: eq(posSales.id, input.originalSaleId),
      with: { items: true },
    });
    if (!original || original.storeId !== input.storeId) {
      throw new AppError(404, ErrorCode.NotFound, 'Original sale not found');
    }
    if (original.status !== 'completed') {
      throw new AppError(409, ErrorCode.InvalidState, 'Can only return against a completed sale');
    }

    const itemById = new Map(original.items.map((i) => [i.id, i]));
    let refundPaise = 0;
    let taxableReversed = 0;
    let taxReversed = 0;
    const returnSaleId = newId(IdPrefix.PosSale);

    for (const rl of input.lines) {
      const orig = itemById.get(rl.originalSaleItemId);
      if (!orig) throw new AppError(404, ErrorCode.NotFound, 'Return line not on original sale');
      if (rl.qty <= 0 || rl.qty > orig.qty) {
        throw AppError.validation('Return qty exceeds purchased qty');
      }
      // Pro-rata refund off the original line's net (incl. tax) and tax components.
      const lineRefund = Math.round((orig.netLinePaise * rl.qty) / orig.qty);
      const lineTaxable = Math.round((orig.taxableValuePaise * rl.qty) / orig.qty);
      const lineTax = lineRefund - lineTaxable;
      refundPaise += lineRefund;
      taxableReversed += lineTaxable;
      taxReversed += lineTax;

      if (rl.restock !== false) {
        const [updated] = await tx
          .update(variants)
          .set({ stock: sql`${variants.stock} + ${rl.qty}` })
          .where(eq(variants.id, orig.variantId))
          .returning({ stock: variants.stock });
        await tx.insert(inventoryAdjustments).values({
          id: newId(IdPrefix.InventoryAdjustment),
          variantId: orig.variantId,
          delta: rl.qty,
          newStock: updated?.stock ?? 0,
          reason: 'pos_return_restock',
          actorKind: 'retailer',
          actorId: input.cashierAccountId,
          refKind: 'pos_sale',
          refId: returnSaleId,
        });
      }
    }

    const refundApplied = input.refundTenders.reduce((s, t) => s + t.amountPaise, 0);
    if (refundApplied !== refundPaise) {
      throw new AppError(
        400,
        ErrorCode.ValidationError,
        `Refund tenders (${refundApplied}) must equal the refund due (${refundPaise})`,
      );
    }

    const cgst = Math.floor(taxReversed / 2);
    const sgst = taxReversed - cgst;
    await tx.insert(posSales).values({
      id: returnSaleId,
      storeId: input.storeId,
      cashierAccountId: input.cashierAccountId,
      status: 'completed',
      note: `Return: ${input.reason}`,
      customerNameSnap: original.customerNameSnap,
      customerPhoneSnap: original.customerPhoneSnap,
      customerGstinSnap: original.customerGstinSnap,
      storeLegalNameSnap: original.storeLegalNameSnap,
      storeGstinSnap: original.storeGstinSnap,
      storeStateCodeSnap: original.storeStateCodeSnap,
      storeAddressSnap: original.storeAddressSnap,
      pricingMode: original.pricingMode,
      // Stored as negative ledger values — this row reduces the day's takings.
      itemsGrossPaise: -refundPaise,
      taxableValuePaise: -taxableReversed,
      cgstPaise: -cgst,
      sgstPaise: -sgst,
      taxPaise: -taxReversed,
      payablePaise: -refundPaise,
      originalSaleId: original.id,
      idempotencyKey: input.idempotencyKey,
      completedAt: new Date(),
    });

    for (const rl of input.lines) {
      const orig = itemById.get(rl.originalSaleItemId)!;
      const lineRefund = Math.round((orig.netLinePaise * rl.qty) / orig.qty);
      await tx.insert(posReturnLines).values({
        id: newId(IdPrefix.PosReturnLine),
        returnSaleId,
        originalSaleItemId: rl.originalSaleItemId,
        variantId: orig.variantId,
        qty: rl.qty,
        refundPaise: lineRefund,
        restock: rl.restock !== false,
      });
    }

    for (const t of input.refundTenders) {
      await tx.insert(posPayments).values({
        id: newId(IdPrefix.PosPayment),
        saleId: returnSaleId,
        method: t.method,
        direction: 'refund',
        amountPaise: t.amountPaise,
        reference: t.reference ?? null,
      });
    }

    let creditNoteId: string | null = null;
    if (original.invoiceId) {
      creditNoteId = await insertPosCreditNote(tx, {
        invoiceId: original.invoiceId,
        reason: `Return: ${input.reason}`,
        subtotalReversedPaise: taxableReversed,
        taxReversedPaise: taxReversed,
        grandTotalReversedPaise: refundPaise,
      });
    }
    return { returnSaleId, refundPaise, creditNoteId };
  });
}

// ───────────────────────── internal writers ─────────────────────────

async function insertSaleItems(tx: Tx, saleId: string, priced: PosPricing): Promise<void> {
  for (const l of priced.lines) {
    await tx.insert(posSaleItems).values({
      id: newId(IdPrefix.PosSaleItem),
      saleId,
      listingId: l.listingId,
      variantId: l.variantId,
      listingNameSnap: l.listingNameSnap,
      brandSnap: l.brandSnap,
      categorySnap: l.categorySnap,
      attributesLabelSnap: l.attributesLabelSnap,
      hsnSnap: l.hsnSnap,
      skuSnap: l.skuSnap,
      barcodeSnap: l.barcodeSnap,
      qty: l.qty,
      unitMrpPaise: l.unitMrpPaise,
      lineGrossPaise: l.lineGrossPaise,
      lineDiscountPaise: l.lineDiscountPaise + l.billDiscountAllocPaise,
      gstRateBp: l.gstRateBp,
      taxableValuePaise: l.taxableValuePaise,
      gstPaise: l.gstPaise,
      netLinePaise: l.netLinePaise,
    });
  }
}

async function upsertCustomer(
  tx: Tx,
  storeId: string,
  customer?: PosCustomerInput,
): Promise<string | null> {
  if (!customer) return null;
  if (customer.id) return customer.id;
  if (!customer.name && !customer.phone && !customer.gstin) return null;
  const id = newId(IdPrefix.PosCustomer);
  await tx.insert(posCustomers).values({
    id,
    storeId,
    name: customer.name ?? null,
    phone: customer.phone ?? null,
    gstin: customer.gstin ?? null,
  });
  return id;
}

/** Insert a credit note (series CN-A) against a POS invoice. Used for voids + returns. */
async function insertPosCreditNote(
  tx: Tx,
  input: {
    invoiceId: string;
    reason: string;
    subtotalReversedPaise: number;
    taxReversedPaise: number;
    grandTotalReversedPaise: number;
  },
): Promise<string> {
  const parent = await tx.query.invoices.findFirst({ where: eq(invoices.id, input.invoiceId) });
  if (!parent) throw new AppError(404, ErrorCode.NotFound, 'Parent invoice not found');
  const fiscalYear = currentFiscalYear();
  const rule = await resolveNumberingRule(
    tx as unknown as typeof Db,
    parent.legalEntityId,
    parent.storeLegalNameSnap,
  );
  const sequenceNo = await reserveNextSequence(tx as unknown as typeof Db, {
    legalEntityId: parent.legalEntityId,
    fiscalYear,
    series: 'CN-A',
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
    refundId: null,
    legalEntityId: parent.legalEntityId,
    fiscalYear,
    series: 'CN-A',
    sequenceNo,
    creditNoteNumber,
    consumerNameSnap: parent.consumerNameSnap,
    consumerBillingAddressSnap: parent.consumerBillingAddressSnap,
    consumerGstinSnap: parent.consumerGstinSnap,
    reason: input.reason,
    subtotalReversedPaise: input.subtotalReversedPaise,
    taxReversedPaise: input.taxReversedPaise,
    tcsReversedPaise: 0,
    grandTotalReversedPaise: input.grandTotalReversedPaise,
    pdfUrl: null,
  });
  return creditNoteId;
}
