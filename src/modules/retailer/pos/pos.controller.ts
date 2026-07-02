import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  invoices,
  posPayments,
  posSales,
  productListings,
  retailerAccounts,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import {
  completePosSale,
  createPosReturn,
  holdPosSale,
  quotePosSale,
  voidPosSale,
} from '@/shared/pos/create-pos-sale.js';
import { posPrinterConfigs } from '@/db/schema/index.js';
import { charsForPaper, getPrinterConfig } from '@/shared/pos/printer-config.js';
import {
  drawerKickPayload,
  openDrawerOnNetwork,
  preparePrintForSale,
  printSaleToNetwork,
  type PrintHint,
} from '@/shared/pos/printer.js';
import { assembleReceipt, renderReceiptPayloads } from '@/shared/pos/receipt.js';
import type {
  CreateSaleBody,
  CustomersQuery,
  HoldSaleBody,
  ListSalesQuery,
  LookupQuery,
  PrinterConfigBody,
  PrintSaleBody,
  QuoteBody,
  ReceiptQuery,
  ReturnSaleBody,
  SummaryQuery,
  VoidSaleBody,
} from './pos.validators.js';

type Auth = AccessTokenPayload;

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

// ───────────────────────── lookup (scan/search) ─────────────────────────

export async function lookup(input: { auth: Auth; query: z.infer<typeof LookupQuery> }) {
  const storeId = await getStoreId(input.auth.sub);
  const q = input.query.q.trim();

  // Exact barcode, then exact SKU — the scanner path.
  const exact = await db.query.variants.findFirst({
    where: and(
      eq(variants.storeId, storeId),
      eq(variants.isActive, true),
      or(eq(variants.barcode, q), eq(variants.sku, q)),
    ),
    with: { listing: { with: { brand: true } } },
  });
  if (exact && exact.listing.status === 'active') {
    return ok({ exact: shapeLookupRow(exact), results: [shapeLookupRow(exact)] });
  }

  // Fall back to a name/SKU contains-search across the store's active catalog.
  const listings = await db.query.productListings.findMany({
    where: and(
      eq(productListings.storeId, storeId),
      eq(productListings.status, 'active'),
      ilike(productListings.name, `%${q}%`),
    ),
    with: { variants: true, brand: true },
    limit: 20,
  });
  const results: ReturnType<typeof shapeLookupRow>[] = [];
  for (const li of listings) {
    for (const v of li.variants) {
      if (!v.isActive) continue;
      results.push(
        shapeLookupRow({
          ...v,
          listing: { ...li, brand: li.brand },
        } as LookupVariant),
      );
    }
  }
  return ok({ exact: null, results: results.slice(0, 30) });
}

type LookupVariant = typeof variants.$inferSelect & {
  listing: { id: string; name: string; status: string; hsn: string | null; brand: { name: string } | null };
};

function shapeLookupRow(v: LookupVariant) {
  return {
    variantId: v.id,
    listingId: v.listing.id,
    name: v.listing.name,
    brand: v.listing.brand?.name ?? null,
    attributesLabel: v.attributesLabel,
    sku: v.sku,
    barcode: v.barcode,
    hsn: v.listing.hsn,
    pricePaise: v.pricePaise,
    availableQty: v.stock - v.reserved,
    imageUrl: v.imageUrls?.[0] ?? null,
  };
}

// ───────────────────────── quote ─────────────────────────

export async function quote(input: { auth: Auth; body: z.infer<typeof QuoteBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const result = await quotePosSale(db, {
    storeId,
    lines: input.body.lines,
    ...(input.body.billDiscountPaise !== undefined && { billDiscountPaise: input.body.billDiscountPaise }),
    ...(input.body.pricingMode !== undefined && { pricingMode: input.body.pricingMode }),
  });
  return ok(result);
}

// ───────────────────────── create / hold ─────────────────────────

export async function createSale(input: { auth: Auth; body: z.infer<typeof CreateSaleBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const result = await completePosSale(db, {
    storeId,
    cashierAccountId: input.auth.sub,
    idempotencyKey: input.body.idempotencyKey,
    ...(input.body.holdSaleId !== undefined && { holdSaleId: input.body.holdSaleId }),
    ...(input.body.customer !== undefined && { customer: input.body.customer }),
    ...(input.body.pricingMode !== undefined && { pricingMode: input.body.pricingMode }),
    ...(input.body.billDiscountPaise !== undefined && { billDiscountPaise: input.body.billDiscountPaise }),
    ...(input.body.note !== undefined && { note: input.body.note }),
    lines: input.body.lines,
    tenders: input.body.tenders,
  });

  // Printing/drawer are opt-in per store. Skip on idempotent replay so a retried request never
  // double-prints or re-kicks the drawer. `preparePrintForSale` never throws — a print failure
  // must not fail the already-settled sale.
  let print: PrintHint | null = null;
  if (!result.alreadyExisted) {
    const config = await getPrinterConfig(db, storeId);
    print = await preparePrintForSale(db, {
      storeId,
      saleId: result.saleId,
      config,
      tenderMethods: input.body.tenders.map((t) => t.method),
    });
  }
  return ok({ ...result, print });
}

export async function holdSale(input: { auth: Auth; body: z.infer<typeof HoldSaleBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const result = await holdPosSale(db, {
    storeId,
    cashierAccountId: input.auth.sub,
    idempotencyKey: input.body.idempotencyKey,
    ...(input.body.customer !== undefined && { customer: input.body.customer }),
    ...(input.body.pricingMode !== undefined && { pricingMode: input.body.pricingMode }),
    ...(input.body.billDiscountPaise !== undefined && { billDiscountPaise: input.body.billDiscountPaise }),
    ...(input.body.note !== undefined && { note: input.body.note }),
    lines: input.body.lines,
  });
  return ok(result);
}

export async function voidSale(input: { auth: Auth; id: string; body: z.infer<typeof VoidSaleBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const result = await voidPosSale(db, {
    storeId,
    saleId: input.id,
    actorId: input.auth.sub,
    reason: input.body.reason,
  });
  return ok(result);
}

export async function returnSale(input: { auth: Auth; id: string; body: z.infer<typeof ReturnSaleBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const result = await createPosReturn(db, {
    storeId,
    cashierAccountId: input.auth.sub,
    idempotencyKey: input.body.idempotencyKey,
    originalSaleId: input.id,
    reason: input.body.reason,
    lines: input.body.lines,
    refundTenders: input.body.refundTenders,
  });
  return ok(result);
}

// ───────────────────────── reads ─────────────────────────

export async function listSales(input: { auth: Auth; query: z.infer<typeof ListSalesQuery> }) {
  const storeId = await getStoreId(input.auth.sub);
  const { query } = input;

  const filters = [eq(posSales.storeId, storeId)];
  filters.push(query.status ? eq(posSales.status, query.status) : eq(posSales.status, 'completed'));
  if (query.from) filters.push(gte(posSales.completedAt, new Date(query.from)));
  if (query.to) filters.push(lt(posSales.completedAt, new Date(query.to)));
  if (query.cashierId) filters.push(eq(posSales.cashierAccountId, query.cashierId));

  let saleIdsFromInvoice: string[] | null = null;
  if (query.q) {
    const inv = await db
      .select({ posSaleId: invoices.posSaleId })
      .from(invoices)
      .where(and(eq(invoices.storeId, storeId), ilike(invoices.invoiceNumber, `%${query.q}%`)));
    saleIdsFromInvoice = inv.map((r) => r.posSaleId).filter((x): x is string => Boolean(x));
    if (saleIdsFromInvoice.length === 0) return ok({ rows: [], total: 0 });
    filters.push(inArray(posSales.id, saleIdsFromInvoice));
  }

  const rows = await db.query.posSales.findMany({
    where: and(...filters),
    orderBy: desc(posSales.completedAt),
    limit: query.limit,
    offset: query.offset,
    with: { invoice: { columns: { invoiceNumber: true, pdfUrl: true } } },
  });
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posSales)
    .where(and(...filters));

  return ok({ rows: rows.map(shapeSaleRow), total: countRows[0]?.count ?? 0 });
}

export async function getSale(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);
  const sale = await db.query.posSales.findFirst({
    where: and(eq(posSales.id, input.id), eq(posSales.storeId, storeId)),
    with: {
      items: true,
      payments: true,
      returnLines: true,
      invoice: { columns: { id: true, invoiceNumber: true, pdfUrl: true } },
    },
  });
  if (!sale) throw new AppError(404, ErrorCode.NotFound, 'Sale not found');
  return ok(sale);
}

export async function listHeld(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);
  const rows = await db.query.posSales.findMany({
    where: and(eq(posSales.storeId, storeId), eq(posSales.status, 'held')),
    orderBy: desc(posSales.heldAt),
    with: { items: { columns: { id: true } } },
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      note: r.note,
      customerName: r.customerNameSnap,
      itemCount: r.items.length,
      payablePaise: r.payablePaise,
      heldAt: r.heldAt?.toISOString() ?? null,
    })),
  );
}

export async function listCustomers(input: { auth: Auth; query: z.infer<typeof CustomersQuery> }) {
  const storeId = await getStoreId(input.auth.sub);
  const rows = await db.query.posCustomers.findMany({
    where: (c, { and: a, eq: e, ilike: il }) =>
      a(e(c.storeId, storeId), il(c.phone, `%${input.query.phone}%`)),
    limit: 10,
  });
  return ok(rows);
}

export async function getSaleInvoice(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);
  const sale = await db.query.posSales.findFirst({
    where: and(eq(posSales.id, input.id), eq(posSales.storeId, storeId)),
    with: { invoice: true },
  });
  if (!sale?.invoice) throw new AppError(404, ErrorCode.NotFound, 'Invoice not found');
  return ok({
    id: sale.invoice.id,
    number: sale.invoice.invoiceNumber,
    pdfUrl: sale.invoice.pdfUrl,
  });
}

export async function daySummary(input: { auth: Auth; query: z.infer<typeof SummaryQuery> }) {
  const storeId = await getStoreId(input.auth.sub);
  const dayStr = input.query.date ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${dayStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const sales = await db.query.posSales.findMany({
    where: and(
      eq(posSales.storeId, storeId),
      eq(posSales.status, 'completed'),
      gte(posSales.completedAt, start),
      lt(posSales.completedAt, end),
    ),
    columns: {
      id: true,
      payablePaise: true,
      taxableValuePaise: true,
      taxPaise: true,
      originalSaleId: true,
    },
    with: { items: { columns: { qty: true } } },
  });

  const saleIds = sales.map((s) => s.id);
  const tenders =
    saleIds.length === 0
      ? []
      : await db
          .select({
            method: posPayments.method,
            direction: posPayments.direction,
            total: sql<number>`coalesce(sum(${posPayments.amountPaise}),0)::int`,
          })
          .from(posPayments)
          .where(inArray(posPayments.saleId, saleIds))
          .groupBy(posPayments.method, posPayments.direction);

  const byTender: Record<string, number> = { cash: 0, card: 0, upi: 0 };
  let refundTotal = 0;
  for (const t of tenders) {
    if (t.direction === 'refund') refundTotal += t.total;
    else byTender[t.method] = (byTender[t.method] ?? 0) + t.total;
  }

  const saleRows = sales.filter((s) => !s.originalSaleId);
  const returnRows = sales.filter((s) => s.originalSaleId);

  return ok({
    date: dayStr,
    saleCount: saleRows.length,
    returnCount: returnRows.length,
    itemCount: saleRows.reduce((s, r) => s + r.items.reduce((a, i) => a + i.qty, 0), 0),
    grossPayablePaise: sales.reduce((s, r) => s + r.payablePaise, 0),
    taxableValuePaise: sales.reduce((s, r) => s + r.taxableValuePaise, 0),
    taxPaise: sales.reduce((s, r) => s + r.taxPaise, 0),
    refundsPaise: refundTotal,
    byTender,
  });
}

// ───────────────────────── printer / cash drawer ─────────────────────────

export async function getPrinter(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);
  return ok(await getPrinterConfig(db, storeId));
}

export async function putPrinter(input: { auth: Auth; body: z.infer<typeof PrinterConfigBody> }) {
  const storeId = await getStoreId(input.auth.sub);
  const b = input.body;
  // If the paper width changes without an explicit charsPerLine, derive the sensible default.
  const charsPerLine =
    b.charsPerLine ?? (b.paperWidth !== undefined ? charsForPaper(b.paperWidth) : undefined);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const set = (k: string, v: unknown) => {
    if (v !== undefined) patch[k] = v;
  };
  set('enabled', b.enabled);
  set('connection', b.connection);
  set('host', b.host);
  set('port', b.port);
  set('paperWidth', b.paperWidth);
  set('charsPerLine', charsPerLine);
  set('copies', b.copies);
  set('headerText', b.headerText);
  set('footerText', b.footerText);
  set('showGstBreakup', b.showGstBreakup);
  set('showQr', b.showQr);
  set('autoPrintOnSale', b.autoPrintOnSale);
  set('cashDrawerEnabled', b.cashDrawerEnabled);
  set('cashDrawerPin', b.cashDrawerPin);
  set('cashDrawerOnlyOnCash', b.cashDrawerOnlyOnCash);
  set('cashDrawerOnSale', b.cashDrawerOnSale);

  await db
    .insert(posPrinterConfigs)
    .values({ storeId, ...patch })
    .onConflictDoUpdate({ target: posPrinterConfigs.storeId, set: patch });

  return ok(await getPrinterConfig(db, storeId));
}

export async function getReceipt(input: {
  auth: Auth;
  id: string;
  query: z.infer<typeof ReceiptQuery>;
}) {
  const storeId = await getStoreId(input.auth.sub);
  // The GST invoice PDF is the existing artifact — just hand back its stored URL.
  if (input.query.format === 'pdf') {
    return getSaleInvoice({ auth: input.auth, id: input.id });
  }
  const config = await getPrinterConfig(db, storeId);
  const receipt = await assembleReceipt(db, { storeId, saleId: input.id, config });
  if (!receipt) throw new AppError(404, ErrorCode.NotFound, 'Sale not found');
  if (input.query.format === 'json') return ok(receipt);

  const payloads = renderReceiptPayloads(receipt, { copies: config.copies, drawerKickPin: null });
  if (input.query.format === 'text') return ok({ text: payloads.text });
  return ok({
    escposBase64: payloads.escposBase64,
    paperWidth: config.paperWidth,
    charsPerLine: config.charsPerLine,
  });
}

export async function printSale(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PrintSaleBody>;
}) {
  const storeId = await getStoreId(input.auth.sub);
  const config = await getPrinterConfig(db, storeId);
  if (!config.enabled) {
    throw new AppError(409, ErrorCode.InvalidState, 'Printing is not enabled for this store');
  }
  const openDrawer = input.body.openDrawer ?? false;

  // Client/browser terminals print device-side — return the payload rather than doing I/O.
  if (config.connection !== 'network') {
    const receipt = await assembleReceipt(db, { storeId, saleId: input.id, config });
    if (!receipt) throw new AppError(404, ErrorCode.NotFound, 'Sale not found');
    const kickPin = openDrawer && config.cashDrawerEnabled ? config.cashDrawerPin : null;
    const payloads = renderReceiptPayloads(receipt, { copies: config.copies, drawerKickPin: kickPin });
    return ok({
      connection: config.connection,
      escposBase64: payloads.escposBase64,
      receiptText: payloads.text,
    });
  }

  const result = await printSaleToNetwork(db, { storeId, saleId: input.id, config, openDrawer });
  return ok(result);
}

export async function openDrawer(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);
  const config = await getPrinterConfig(db, storeId);
  if (!config.enabled || !config.cashDrawerEnabled) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cash drawer is not enabled for this store');
  }
  if (config.connection === 'network') {
    return ok(await openDrawerOnNetwork(config));
  }
  return ok({ connection: config.connection, drawerKickBase64: drawerKickPayload(config) });
}

// ───────────────────────── shapers ─────────────────────────

function shapeSaleRow(
  row: typeof posSales.$inferSelect & {
    invoice: { invoiceNumber: string; pdfUrl: string | null } | null;
  },
) {
  return {
    id: row.id,
    status: row.status,
    invoiceNumber: row.invoice?.invoiceNumber ?? null,
    pdfUrl: row.invoice?.pdfUrl ?? null,
    customerName: row.customerNameSnap,
    customerPhone: row.customerPhoneSnap,
    payablePaise: row.payablePaise,
    taxPaise: row.taxPaise,
    isReturn: Boolean(row.originalSaleId),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
