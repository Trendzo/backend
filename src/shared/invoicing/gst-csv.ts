/**
 * Monthly GST return CSV (simplified GSTR-1 B2C + credit notes).
 * Streams rows into a single CSV buffer. No external dep.
 */
import { and, gte, lt, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { creditNotes, invoices } from '@/db/schema/index.js';

export type GstCsvResult = {
  buffer: Buffer;
  rowCount: number;
};

const COLUMNS = [
  'document_kind',
  'document_number',
  'document_date',
  'order_id',
  'store_gstin',
  'store_state_code',
  'consumer_name',
  'consumer_state_hint',
  'tax_split_kind',
  'taxable_value',
  'cgst',
  'sgst',
  'igst',
  'tcs',
  'grand_total',
] as const;

const rupeesStr = (paise: number) => (paise / 100).toFixed(2);

export async function generateGstr1B2cCsv(input: { period: string }): Promise<GstCsvResult> {
  const { period } = input;
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) {
    throw new Error('Period must be YYYY-MM');
  }
  const year = Number(match[1]);
  const monthZeroBased = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthZeroBased, 1));
  const end = new Date(Date.UTC(year, monthZeroBased + 1, 1));

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        inArray(invoices.kind, ['tax_invoice', 'supplementary_invoice']),
        gte(invoices.issuedAt, start),
        lt(invoices.issuedAt, end),
      ),
    );

  const creditNoteRows = await db
    .select()
    .from(creditNotes)
    .where(and(gte(creditNotes.issuedAt, start), lt(creditNotes.issuedAt, end)));

  const lines: string[] = [];
  lines.push(COLUMNS.join(','));

  for (const inv of invoiceRows) {
    lines.push(
      [
        inv.kind,
        csvEscape(inv.invoiceNumber),
        inv.issuedAt ? inv.issuedAt.toISOString().slice(0, 10) : '',
        inv.orderId,
        inv.storeGstinSnap,
        inv.storeStateCodeSnap,
        csvEscape(inv.consumerNameSnap),
        inv.taxSplitKind === 'intra_state' ? inv.storeStateCodeSnap : 'inter_state',
        inv.taxSplitKind,
        rupeesStr(inv.taxableValuePaise),
        rupeesStr(inv.cgstPaise),
        rupeesStr(inv.sgstPaise),
        rupeesStr(inv.igstPaise),
        rupeesStr(inv.tcsPaise),
        rupeesStr(inv.grandTotalPaise),
      ].join(','),
    );
  }

  // Credit notes: reverse signs so accountants see them as deductions in the same sheet.
  for (const cn of creditNoteRows) {
    lines.push(
      [
        'credit_note',
        csvEscape(cn.creditNoteNumber),
        cn.issuedAt.toISOString().slice(0, 10),
        '', // order id not directly on credit_notes
        '',
        '',
        csvEscape(cn.consumerNameSnap),
        '',
        '',
        rupeesStr(-cn.subtotalReversedPaise),
        '',
        '',
        '',
        rupeesStr(-cn.tcsReversedPaise),
        rupeesStr(-cn.grandTotalReversedPaise),
      ].join(','),
    );
  }

  const csv = lines.join('\r\n') + '\r\n';
  return { buffer: Buffer.from(csv, 'utf8'), rowCount: invoiceRows.length + creditNoteRows.length };
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
