/**
 * §18 — TCS reconciliation CSV. Period = YYYY-MM.
 * One row per tax_invoice / supplementary_invoice with TCS > 0 in the period.
 */
import { and, gt, gte, inArray, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { invoices } from '@/db/schema/index.js';

const COLUMNS = [
  'invoice_kind',
  'invoice_number',
  'invoice_date',
  'order_id',
  'store_gstin',
  'store_state_code',
  'consumer_name',
  'tax_split_kind',
  'taxable_value',
  'tcs_rate_bp',
  'tcs_paise',
  'grand_total',
] as const;

const rupeesStr = (paise: number) => (paise / 100).toFixed(2);

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export async function generateTcsReconciliationCsv(input: {
  period: string;
}): Promise<{ buffer: Buffer; rowCount: number }> {
  const match = /^(\d{4})-(\d{2})$/.exec(input.period);
  if (!match) throw new Error('period must be YYYY-MM');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));

  const rows = await db
    .select()
    .from(invoices)
    .where(
      and(
        inArray(invoices.kind, ['tax_invoice', 'supplementary_invoice']),
        gte(invoices.issuedAt, start),
        lt(invoices.issuedAt, end),
        gt(invoices.tcsPaise, 0),
      ),
    );

  const lines: string[] = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.kind,
        csvEscape(r.invoiceNumber),
        r.issuedAt ? r.issuedAt.toISOString().slice(0, 10) : '',
        r.orderId,
        r.storeGstinSnap,
        r.storeStateCodeSnap,
        csvEscape(r.consumerNameSnap),
        r.taxSplitKind,
        rupeesStr(r.taxableValuePaise),
        String(r.tcsRateBpSnap),
        rupeesStr(r.tcsPaise),
        rupeesStr(r.grandTotalPaise),
      ].join(','),
    );
  }
  const csv = lines.join('\r\n') + '\r\n';
  return { buffer: Buffer.from(csv, 'utf8'), rowCount: rows.length };
}
