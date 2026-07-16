import { and, desc, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { retailerTerms, retailerTermsAcceptances } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/** The two retailer-facing legal documents. Both are versioned + accepted the same way. */
export type LegalDocKind = 'terms' | 'privacy';

export const LEGAL_DOC_LABELS: Record<LegalDocKind, string> = {
  terms: 'Retailer Terms & Conditions',
  privacy: 'Privacy Policy',
};

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

/**
 * Bootstrap Privacy Policy — same role as RETAILER_TERMS for the 'privacy' kind.
 * ⚠️ DRAFT digest pending legal review; the full text lives on the public /privacy page.
 */
export const RETAILER_PRIVACY = {
  version: '2026-07-15-privacy-draft',
  label: 'Initial (draft)',
  shortText: [
    'Privacy Policy — summary (DRAFT, pending legal review)',
    '',
    '1. What we collect. Account and contact details; business onboarding and compliance details (store address, GSTIN, PAN, bank, KYC); listings, photos and other content you submit; store location; device identifiers for notifications; orders, invoices, inventory, POS, settlement and payout records.',
    '2. How we use it. To authenticate users, review applications, operate the marketplace (catalog, orders, payments, payouts, POS), send service messages, provide support, prevent abuse, and meet tax and legal duties.',
    '3. Sharing. Only with the service providers needed to run the platform (hosting, media storage, OTP delivery, payments) and with authorities where legally required. We do not sell personal information.',
    '4. Buyer data. Buyer details are shared with you only to fulfil orders and must not be used for anything else.',
    '5. Retention. Profile data is kept while the account is active; after closure or deletion, personal data is revoked or anonymized. GST, invoice, order, payout and audit records are retained as required by Indian law.',
    '6. Security. Access controls, encrypted transport and restricted credentials protect your data; no system can guarantee absolute security.',
    '7. Your choices. You can access and export your data, request corrections, close your account, or request deletion from the app.',
    '8. Changes. This policy is versioned; continued use after a new version requires re-acceptance.',
    '',
    'By accepting you confirm you have read and agree to the full Privacy Policy.',
  ].join('\n'),
} as const;

const BOOTSTRAP: Record<LegalDocKind, { version: string; label: string; shortText: string }> = {
  terms: RETAILER_TERMS,
  privacy: RETAILER_PRIVACY,
};

export type CurrentTerms = { version: string; label: string; shortText: string };

/** The current document of a kind = its latest admin-published version, else the bootstrap constant. */
export async function currentLegalDoc(
  database: typeof Db,
  kind: LegalDocKind,
): Promise<CurrentTerms> {
  const row = await database.query.retailerTerms.findFirst({
    where: eq(retailerTerms.kind, kind),
    orderBy: [desc(retailerTerms.createdAt)],
  });
  if (row) return { version: row.id, label: row.label, shortText: row.shortText };
  const boot = BOOTSTRAP[kind];
  return { version: boot.version, label: boot.label, shortText: boot.shortText };
}

/** Back-compat alias — the T&C call sites predate the second document. */
export async function currentTerms(database: typeof Db): Promise<CurrentTerms> {
  return currentLegalDoc(database, 'terms');
}

/** True if the store has an ACCEPTED decision for the current version of `kind`. */
export async function hasAcceptedCurrentLegalDoc(
  database: typeof Db,
  storeId: string,
  kind: LegalDocKind,
): Promise<boolean> {
  const { version } = await currentLegalDoc(database, kind);
  const row = await database.query.retailerTermsAcceptances.findFirst({
    where: and(
      eq(retailerTermsAcceptances.storeId, storeId),
      eq(retailerTermsAcceptances.docKind, kind),
      eq(retailerTermsAcceptances.termsVersion, version),
      eq(retailerTermsAcceptances.decision, 'accepted'),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/** Back-compat alias for the 'terms' kind. */
export async function hasAcceptedCurrentTerms(
  database: typeof Db,
  storeId: string,
): Promise<boolean> {
  return hasAcceptedCurrentLegalDoc(database, storeId, 'terms');
}

/**
 * Gate a store's go-live (onboarding → active). Throws 409 until the current version
 * of EVERY legal document (T&C + Privacy Policy) is accepted. Call inside the
 * transaction that flips the status.
 */
export async function assertTermsAcceptedForGoLive(
  database: typeof Db,
  storeId: string,
): Promise<void> {
  for (const kind of ['terms', 'privacy'] as const) {
    if (!(await hasAcceptedCurrentLegalDoc(database, storeId, kind))) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Accept the ${LEGAL_DOC_LABELS[kind]} before going live.`,
      );
    }
  }
}
