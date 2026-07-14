/**
 * The canonical KYC document set. This list used to be duplicated three times
 * (admin compliance controller, retailer compliance controller, and a divergent
 * title-case derivation in store-ops) — every copy is now sourced from here.
 *
 * `kyc_documents.kind` is a free-form text column, so an unvalidated upload could
 * silently insert an orphan 6th row instead of filling a seeded slot. `KycDocKindEnum`
 * closes that: it is what the upload validators accept.
 */
import { z } from 'zod';

export const KYC_REQUIRED_DOC_KINDS = [
  'gstin_certificate',
  'pan_card',
  'address_proof',
  'cancelled_cheque',
  'shop_act_license',
] as const;

export type KycDocKind = (typeof KYC_REQUIRED_DOC_KINDS)[number];

/** Zod enum for request validation — rejects any kind outside the canonical set. */
export const KycDocKindEnum = z.enum(KYC_REQUIRED_DOC_KINDS);

const KYC_DOC_LABELS: Record<string, string> = {
  gstin_certificate: 'GSTIN Certificate',
  pan_card: 'PAN Card',
  address_proof: 'Address Proof',
  cancelled_cheque: 'Cancelled Cheque',
  shop_act_license: 'Shop & Establishment License',
};

/** Human label for a doc kind; falls back to a de-snake-cased form for legacy rows. */
export function kycDocLabel(kind: string): string {
  return KYC_DOC_LABELS[kind] ?? kind.replace(/_/g, ' ');
}
