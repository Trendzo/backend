/**
 * GST filing-support reports — Stage 2 + Stage 3 (unified across channels).
 *
 * Anchored on the `invoices` table (the canonical GST document): a supply is reported when its tax
 * invoice is ISSUED, the GST-correct timing for GSTR-1 / GSTR-3B. Covers both offline counter (POS)
 * and online order channels — `?channel=all|pos|online` filters by which FK the invoice carries.
 *
 * Three figures: per-rate slab summary, B2B/B2C split, and the HSN-wise summary (GSTR-1 Table 12).
 * Header totals + B2B/B2C come from invoice rows (authoritative); per-rate/HSN breakups need line
 * items, unioned from `pos_sale_items` (POS) and `order_items` (online). Money is in paise.
 *
 * NOTE: this system has no credit-note invoice kind. Counter-sale returns are surfaced separately
 * (from `pos_sales`); online refunds use a different mechanism and are out of scope here.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { invoices, orderItems, posSaleItems, posSales, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { wrapReport } from '@/shared/reports/meta.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

type Auth = AccessTokenPayload;
type Channel = 'all' | 'pos' | 'online';

/** Invoice kinds that represent the store's own OUTWARD taxable supply (excludes commission_invoice). */
const OUTWARD_KINDS = ['tax_invoice', 'supplementary_invoice', 'bill_of_supply', 'pos_tax_invoice'] as const;

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

export type GstPeriodQuery = { since?: string | undefined; until?: string | undefined; channel?: Channel | undefined };

/** Resolve [start, end) for a report. Defaults to the current calendar month (UTC). */
function resolvePeriod(query: GstPeriodQuery): { start: Date; end: Date } {
  const now = new Date();
  const start = query.since
    ? new Date(query.since)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = query.until ? new Date(query.until) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, ErrorCode.ValidationError, 'Invalid since/until date');
  }
  return { start, end };
}

/** Issued outward invoices for this store in the period, narrowed by channel. */
function invoiceScope(storeId: string, start: Date, end: Date, channel: Channel): SQL {
  const conds = [
    eq(invoices.storeId, storeId),
    eq(invoices.status, 'issued'),
    gte(invoices.issuedAt, start),
    lt(invoices.issuedAt, end),
    inArray(invoices.kind, [...OUTWARD_KINDS]),
  ];
  if (channel === 'pos') conds.push(isNotNull(invoices.posSaleId));
  if (channel === 'online') conds.push(isNotNull(invoices.orderId));
  return and(...conds)!;
}

type SplitRow = {
  taxSplitKind: 'intra_state' | 'inter_state';
  taxableValuePaise: number;
  taxPaise: number;
  qty: number;
};

type Folded = {
  qty: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
};

/**
 * Fold rows grouped by (key, taxSplitKind) into one row per key, splitting tax into CGST+SGST
 * (intra) or IGST (inter). `metaFn` supplies the key's identity columns (from any row in the group).
 */
function foldTaxSplit<R extends SplitRow, M>(
  rows: R[],
  keyFn: (r: R) => string,
  metaFn: (r: R) => M,
): Array<M & Folded> {
  const acc = new Map<string, M & Folded>();
  for (const r of rows) {
    const key = keyFn(r);
    let row = acc.get(key);
    if (!row) {
      row = { ...metaFn(r), qty: 0, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 };
      acc.set(key, row);
    }
    row.qty += r.qty;
    row.taxableValuePaise += r.taxableValuePaise;
    row.taxPaise += r.taxPaise;
    if (r.taxSplitKind === 'inter_state') {
      row.igstPaise += r.taxPaise;
    } else {
      const cgst = Math.floor(r.taxPaise / 2);
      row.cgstPaise += cgst;
      row.sgstPaise += r.taxPaise - cgst;
    }
  }
  return Array.from(acc.values());
}

type ItemAggRow = { hsn: string; gstRateBp: number } & SplitRow;

/**
 * Line items behind the issued invoices in scope, from both channels (per the channel filter),
 * grouped by (hsn, rate, split). POS taxable/gst come straight off pos_sale_items; online taxable
 * is netLine − gstAlloc (tax-inclusive net minus the allocated GST).
 */
async function unifiedItems(storeId: string, start: Date, end: Date, channel: Channel): Promise<ItemAggRow[]> {
  const rows: ItemAggRow[] = [];

  if (channel !== 'online') {
    const posRows = await db
      .select({
        hsn: sql<string>`coalesce(${posSaleItems.hsnSnap}, '(unclassified)')`,
        gstRateBp: posSaleItems.gstRateBp,
        taxSplitKind: invoices.taxSplitKind,
        taxableValuePaise: sql<number>`coalesce(sum(${posSaleItems.taxableValuePaise}),0)::int`,
        taxPaise: sql<number>`coalesce(sum(${posSaleItems.gstPaise}),0)::int`,
        qty: sql<number>`coalesce(sum(${posSaleItems.qty}),0)::int`,
      })
      .from(invoices)
      .innerJoin(posSaleItems, eq(posSaleItems.saleId, invoices.posSaleId))
      .where(invoiceScope(storeId, start, end, 'pos'))
      .groupBy(sql`coalesce(${posSaleItems.hsnSnap}, '(unclassified)')`, posSaleItems.gstRateBp, invoices.taxSplitKind);
    rows.push(...posRows);
  }

  if (channel !== 'pos') {
    const orderRows = await db
      .select({
        hsn: sql<string>`coalesce(${orderItems.hsnSnap}, '(unclassified)')`,
        gstRateBp: orderItems.gstRateBp,
        taxSplitKind: invoices.taxSplitKind,
        taxableValuePaise: sql<number>`coalesce(sum(${orderItems.netLinePaise} - ${orderItems.gstAllocPaise}),0)::int`,
        taxPaise: sql<number>`coalesce(sum(${orderItems.gstAllocPaise}),0)::int`,
        qty: sql<number>`coalesce(sum(${orderItems.qty}),0)::int`,
      })
      .from(invoices)
      .innerJoin(orderItems, eq(orderItems.orderId, invoices.orderId))
      .where(invoiceScope(storeId, start, end, 'online'))
      .groupBy(sql`coalesce(${orderItems.hsnSnap}, '(unclassified)')`, orderItems.gstRateBp, invoices.taxSplitKind);
    rows.push(...orderRows);
  }

  return rows;
}

/** GSTR-1 / GSTR-3B liability summary: per-rate slab, B2B/B2C split, credit notes, grand totals. */
export async function getGstSummary(input: { auth: Auth; query: GstPeriodQuery }) {
  const storeId = await getStoreId(input.auth.sub);
  const { start, end } = resolvePeriod(input.query);
  const channel: Channel = input.query.channel ?? 'all';

  // Per-rate slab — from line items, split-aware, one row per rate.
  const items = await unifiedItems(storeId, start, end, channel);
  const byRate = foldTaxSplit(
    items,
    (r) => String(r.gstRateBp),
    (r) => ({ ratePct: r.gstRateBp / 100, gstRateBp: r.gstRateBp }),
  ).sort((a, b) => a.gstRateBp - b.gstRateBp);

  // B2B/B2C split + grand totals — from invoice headers (authoritative GST documents).
  const headerRows = await db
    .select({
      isB2b: sql<boolean>`${invoices.consumerGstinSnap} is not null`,
      taxableValuePaise: sql<number>`coalesce(sum(${invoices.taxableValuePaise}),0)::int`,
      cgstPaise: sql<number>`coalesce(sum(${invoices.cgstPaise}),0)::int`,
      sgstPaise: sql<number>`coalesce(sum(${invoices.sgstPaise}),0)::int`,
      igstPaise: sql<number>`coalesce(sum(${invoices.igstPaise}),0)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(invoiceScope(storeId, start, end, channel))
    .groupBy(sql`${invoices.consumerGstinSnap} is not null`);

  const blank = { taxableValuePaise: 0, taxPaise: 0, saleCount: 0 };
  const b2b = { ...blank };
  const b2c = { ...blank };
  const totals = { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0 };
  for (const r of headerRows) {
    const tax = r.cgstPaise + r.sgstPaise + r.igstPaise;
    const tgt = r.isB2b ? b2b : b2c;
    tgt.taxableValuePaise += r.taxableValuePaise;
    tgt.taxPaise += tax;
    tgt.saleCount += r.count;
    totals.taxableValuePaise += r.taxableValuePaise;
    totals.cgstPaise += r.cgstPaise;
    totals.sgstPaise += r.sgstPaise;
    totals.igstPaise += r.igstPaise;
    totals.taxPaise += tax;
  }

  // Credit notes — counter-sale returns only (no credit-note invoice kind exists). POS channel only.
  const [creditNotes] =
    channel === 'online'
      ? [{ taxableValuePaise: 0, taxPaise: 0, count: 0 }]
      : await db
          .select({
            taxableValuePaise: sql<number>`coalesce(sum(${posSales.taxableValuePaise}),0)::int`,
            taxPaise: sql<number>`coalesce(sum(${posSales.taxPaise}),0)::int`,
            count: sql<number>`count(*)::int`,
          })
          .from(posSales)
          .where(
            and(
              eq(posSales.storeId, storeId),
              eq(posSales.status, 'completed'),
              isNotNull(posSales.originalSaleId),
              gte(posSales.completedAt, start),
              lt(posSales.completedAt, end),
            ),
          );

  return ok(
    wrapReport({
      period: { since: start.toISOString(), until: end.toISOString() },
      channel,
      byRate,
      supplyType: { b2b, b2c },
      creditNotes: creditNotes ?? { taxableValuePaise: 0, taxPaise: 0, count: 0 },
      totals,
    }),
  );
}

/** HSN-wise summary (GSTR-1 Table 12): one row per (HSN, rate), split-aware, both channels. */
export async function getGstHsnSummary(input: { auth: Auth; query: GstPeriodQuery }) {
  const storeId = await getStoreId(input.auth.sub);
  const { start, end } = resolvePeriod(input.query);
  const channel: Channel = input.query.channel ?? 'all';

  const items = await unifiedItems(storeId, start, end, channel);
  const out = foldTaxSplit(
    items,
    (r) => `${r.hsn}|${r.gstRateBp}`,
    (r) => ({ hsn: r.hsn, ratePct: r.gstRateBp / 100, gstRateBp: r.gstRateBp }),
  )
    .sort((a, b) => (a.hsn < b.hsn ? -1 : a.hsn > b.hsn ? 1 : a.gstRateBp - b.gstRateBp))
    .map((r) => ({
      hsn: r.hsn,
      ratePct: r.ratePct,
      totalQty: r.qty,
      taxableValuePaise: r.taxableValuePaise,
      cgstPaise: r.cgstPaise,
      sgstPaise: r.sgstPaise,
      igstPaise: r.igstPaise,
      taxPaise: r.taxPaise,
    }));

  return ok(wrapReport({ period: { since: start.toISOString(), until: end.toISOString() }, channel, rows: out }));
}
