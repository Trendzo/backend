import { and, desc, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { retailerTerms, retailerTermsAcceptances } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/**
 * Bootstrap Retailer Terms — used until an admin publishes the first version into
 * `retailer_terms`. ⚠️ DRAFT digest pending legal review. Once admins publish versions,
 * the latest DB row is authoritative and this constant is no longer served.
 */
export const RETAILER_TERMS = {
  version: '2026-07-05-draft',
  label: 'Initial (draft)',
  shortText: [
    'Retailer Terms — summary (DRAFT, pending legal review)',
    '',
    '1. Marketplace. You list and sell your own products through the platform. You are the seller of record and are responsible for your listings, pricing, stock, GST invoicing and lawful sale of goods.',
    '2. Commission & payouts. The platform deducts the agreed platform fee per order; net proceeds are paid out on the agreed payout cadence, subject to returns, chargebacks and statutory deductions (incl. TCS/TDS where applicable).',
    '3. KYC & compliance. You must provide accurate GSTIN, bank and identity details and keep them current. The platform may request re-verification and may pause or suspend a store pending compliance review.',
    '4. Fulfilment & returns. You must fulfil accepted orders on time and honour the return/exchange policy shown to buyers. Repeated breaches may trigger the enforcement ladder (warnings → suspension → termination).',
    '5. Data. You grant the platform the rights needed to operate the marketplace (display listings, process orders/payments, provide support). Buyer data is provided only to fulfil orders and must not be misused.',
    '6. Suspension & termination. The platform may suspend or terminate a store or account for policy, legal or risk reasons; you may exit subject to settling open orders and dues.',
    '7. Changes. These terms are versioned; continued use after a new version requires re-acceptance.',
    '',
    'By accepting you confirm you have read and agree to the full Retailer Terms.',
  ].join('\n'),
} as const;

export type CurrentTerms = { version: string; label: string; shortText: string };

/** The current terms = the latest admin-published version, else the bootstrap constant. */
export async function currentTerms(database: typeof Db): Promise<CurrentTerms> {
  const row = await database.query.retailerTerms.findFirst({
    orderBy: [desc(retailerTerms.createdAt)],
  });
  if (row) return { version: row.id, label: row.label, shortText: row.shortText };
  return { version: RETAILER_TERMS.version, label: RETAILER_TERMS.label, shortText: RETAILER_TERMS.shortText };
}

/** True if the store has an ACCEPTED decision for the current terms version. */
export async function hasAcceptedCurrentTerms(database: typeof Db, storeId: string): Promise<boolean> {
  const { version } = await currentTerms(database);
  const row = await database.query.retailerTermsAcceptances.findFirst({
    where: and(
      eq(retailerTermsAcceptances.storeId, storeId),
      eq(retailerTermsAcceptances.termsVersion, version),
      eq(retailerTermsAcceptances.decision, 'accepted'),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/**
 * Gate a store's go-live (onboarding → active). Throws 409 until the current terms
 * are accepted. Call inside the transaction that flips the status.
 */
export async function assertTermsAcceptedForGoLive(database: typeof Db, storeId: string): Promise<void> {
  if (!(await hasAcceptedCurrentTerms(database, storeId))) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Accept the Retailer Terms & Conditions before going live.',
    );
  }
}
