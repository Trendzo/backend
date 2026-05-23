import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { creditNotes, invoices, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ListInvoicesQuery } from './invoicing.validators.js';

type Auth = AccessTokenPayload;

/** Map backend invoice kinds to the dashboard's simplified kind labels. */
function mapKind(kind: string): string {
  if (kind === 'tax_invoice' || kind === 'bill_of_supply') return 'invoice';
  if (kind === 'supplementary_invoice') return 'supplementary';
  if (kind === 'commission_invoice') return 'commission';
  return kind;
}

function shapeInvoice(row: typeof invoices.$inferSelect) {
  return {
    id: row.id,
    number: row.invoiceNumber,
    kind: mapKind(row.kind),
    status: row.status,
    orderId: row.orderId,
    storeId: row.storeId,
    consumerName: row.consumerNameSnap,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    totalPaise: row.grandTotalPaise,
    taxableValuePaise: row.taxableValuePaise,
    cgstPaise: row.cgstPaise,
    sgstPaise: row.sgstPaise,
    igstPaise: row.igstPaise,
    tcsPaise: row.tcsPaise,
    tcsRateBp: row.tcsRateBpSnap,
    pdfUrl: row.pdfUrl,
    linkedInvoiceId: null as string | null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

export async function listInvoices(input: {
  auth: Auth;
  query: z.infer<typeof ListInvoicesQuery>;
}) {
  const { auth, query } = input;
  const storeId = await getStoreId(auth.sub);

  const kindFilter =
    query.kind === 'invoice'
      ? inArray(invoices.kind, ['tax_invoice', 'bill_of_supply'])
      : query.kind === 'supplementary'
        ? eq(invoices.kind, 'supplementary_invoice')
        : query.kind === 'commission'
          ? eq(invoices.kind, 'commission_invoice')
          : undefined;

  const orderFilter = query.orderId ? eq(invoices.orderId, query.orderId) : undefined;
  const rows = await db.query.invoices.findMany({
    where: and(eq(invoices.storeId, storeId), kindFilter, orderFilter),
    orderBy: desc(invoices.createdAt),
    limit: query.limit,
  });

  return ok(rows.map(shapeInvoice));
}

export async function getInvoice(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const storeId = await getStoreId(auth.sub);

  const row = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, id), eq(invoices.storeId, storeId)),
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Invoice not found');

  const creditNoteRows = await db.query.creditNotes.findMany({
    where: eq(creditNotes.parentInvoiceId, row.id),
    orderBy: desc(creditNotes.issuedAt),
  });

  return ok({
    ...shapeInvoice(row),
    creditNotes: creditNoteRows.map((cn) => ({
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      reason: cn.reason,
      grandTotalReversedPaise: cn.grandTotalReversedPaise,
      pdfUrl: cn.pdfUrl,
      issuedAt: cn.issuedAt.toISOString(),
    })),
  });
}

export async function getInvoicePdf(input: { auth: Auth; id: string }) {
  const { auth, id } = input;
  const storeId = await getStoreId(auth.sub);

  const row = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, id), eq(invoices.storeId, storeId)),
    columns: { id: true, invoiceNumber: true, pdfUrl: true },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Invoice not found');
  if (!row.pdfUrl) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'PDF not yet generated for this invoice — try again shortly',
    );
  }
  return ok({
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    pdfUrl: row.pdfUrl,
  });
}
