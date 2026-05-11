import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  creditNotes,
  invoices,
  retailerAccounts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

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

const retailerInvoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/invoices — tax invoices + supplementary for this store =====
  app.get(
    '/invoices',
    {
      schema: {
        querystring: z.object({
          kind: z.enum(['invoice', 'supplementary', 'commission', 'all']).default('all'),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const kindFilter =
        req.query.kind === 'invoice'
          ? inArray(invoices.kind, ['tax_invoice', 'bill_of_supply'])
          : req.query.kind === 'supplementary'
          ? eq(invoices.kind, 'supplementary_invoice')
          : req.query.kind === 'commission'
          ? eq(invoices.kind, 'commission_invoice')
          : undefined;

      const rows = await db.query.invoices.findMany({
        where: and(
          eq(invoices.storeId, storeId),
          kindFilter,
        ),
        orderBy: desc(invoices.createdAt),
        limit: req.query.limit,
      });

      return ok(rows.map(shapeInvoice));
    },
  );

  // ===== GET /retailer/invoices/:id — single invoice with credit notes =====
  app.get(
    '/invoices/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const row = await db.query.invoices.findFirst({
        where: and(eq(invoices.id, req.params.id), eq(invoices.storeId, storeId)),
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
          issuedAt: cn.issuedAt.toISOString(),
        })),
      });
    },
  );
};

export default retailerInvoicingRoutes;
