/**
 * Proof-of-delivery secrets on the `orders` row.
 *
 *  - `deliveryOtp`      the 6-digit code the CUSTOMER reads out at the door; whoever completes
 *                       delivery must be told it by the customer, never by the API.
 *  - `agentHandoffCode` the code the assigned driver reads off THEIR app at the store handover.
 *
 * The retailer-facing API must never return either (the mark-delivered / handover flows validate
 * the submitted value against the DB server-side). Use this in Drizzle relational queries
 * (`with: { order: { columns: ORDER_PROOF_SECRETS_OMITTED } }`) so the columns are not even
 * loaded, instead of remembering to strip them from a spread row afterwards.
 */
export const ORDER_PROOF_SECRETS_OMITTED = {
  deliveryOtp: false,
  agentHandoffCode: false,
} as const;
