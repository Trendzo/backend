import { env } from '@/config/env.js';

/**
 * Field-sales CRM domain model — the server-authoritative half.
 *
 * The retailer-crm frontend keeps its own copy of the labels and colours for rendering; this
 * module owns everything that must not be decided by a client: the checklist vocabulary, the
 * status ladder, and `deriveStatus`. A lead's status is DERIVED on every mutation and never
 * accepted from a request body.
 */

export type CrmRole = 'exec' | 'manager' | 'admin';

export const CRM_STEPS = [
  { key: 'store_visited', label: 'Store Visited' },
  { key: 'decision_maker_met', label: 'Decision Maker Met' },
  { key: 'product_explained', label: 'Product / Platform Explained' },
  { key: 'demo_given', label: 'Demo Given' },
  { key: 'interested', label: 'Retailer Interested' },
  { key: 'agreement_shared', label: 'Agreement Shared' },
  { key: 'agreement_signed', label: 'Agreement Signed / Collected' },
  { key: 'documents_collected', label: 'Documents Collected' },
  { key: 'signup_completed', label: 'Signup Completed' },
  { key: 'onboarding_completed', label: 'Retailer Onboarding Completed' },
] as const;

export type CrmStepKey = (typeof CRM_STEPS)[number]['key'];

export const CRM_STEP_KEYS: readonly CrmStepKey[] = CRM_STEPS.map((s) => s.key);

export const CRM_STEP_LABEL = Object.fromEntries(CRM_STEPS.map((s) => [s.key, s.label])) as Record<
  CrmStepKey,
  string
>;

export function isCrmStepKey(v: unknown): v is CrmStepKey {
  return typeof v === 'string' && (CRM_STEP_KEYS as readonly string[]).includes(v);
}

export type CrmStatus =
  | 'new'
  | 'visited'
  | 'demo_completed'
  | 'interested'
  | 'followup_required'
  | 'agreement_pending'
  | 'agreement_completed'
  | 'signup_pending'
  | 'signup_completed'
  | 'onboarded'
  | 'not_interested';

export const CRM_STATUS_LABEL: Record<CrmStatus, string> = {
  new: 'New Lead',
  visited: 'Visited',
  demo_completed: 'Demo Completed',
  interested: 'Interested',
  followup_required: 'Follow-up Required',
  agreement_pending: 'Agreement Pending',
  agreement_completed: 'Agreement Completed',
  signup_pending: 'Signup Pending',
  signup_completed: 'Signup Completed',
  onboarded: 'Onboarded',
  not_interested: 'Not Interested',
};

export const CRM_STATUS_ORDER = Object.keys(CRM_STATUS_LABEL) as CrmStatus[];

/**
 * Derive pipeline status from checklist progress + the not-interested flag + whether any
 * follow-up is still pending.
 *
 * `notInterested` is sticky: it outranks everything until a later checklist step (or a
 * positive visit outcome) clears the flag and re-opens the lead. A pending follow-up sits
 * between "interested" and "agreement shared" — once paperwork is out, the paperwork stage
 * is the more informative label even while a follow-up is booked.
 */
export function deriveCrmStatus(
  done: ReadonlySet<CrmStepKey>,
  notInterested: boolean,
  hasPendingFollowup: boolean,
): CrmStatus {
  if (notInterested) return 'not_interested';
  if (done.has('onboarding_completed')) return 'onboarded';
  if (done.has('signup_completed')) return 'signup_completed';
  if (done.has('agreement_signed') && done.has('documents_collected')) return 'signup_pending';
  if (done.has('agreement_signed')) return 'agreement_completed';
  if (done.has('agreement_shared')) return 'agreement_pending';
  if (hasPendingFollowup) return 'followup_required';
  if (done.has('interested')) return 'interested';
  if (done.has('demo_given')) return 'demo_completed';
  if (done.has('store_visited')) return 'visited';
  return 'new';
}

export const CRM_FOLLOWUP_TYPES = [
  'Phone Call',
  'WhatsApp',
  'Store Visit',
  'Demo',
  'Agreement',
  'Signup',
  'Documentation',
  'Other',
] as const;

export const CRM_OUTCOMES = [
  { key: 'interested', label: 'Interested' },
  { key: 'followup_required', label: 'Follow-up Required' },
  { key: 'agreement_pending', label: 'Agreement Pending' },
  { key: 'agreement_done', label: 'Agreement Done' },
  { key: 'signup_pending', label: 'Signup Pending' },
  { key: 'onboarded', label: 'Onboarded' },
  { key: 'not_interested', label: 'Not Interested' },
  { key: 'unable_to_meet', label: 'Unable to Meet Owner' },
  { key: 'store_closed', label: 'Store Closed' },
  { key: 'wrong_address', label: 'Wrong Address' },
  { key: 'other', label: 'Other' },
] as const;

export type CrmOutcomeKey = (typeof CRM_OUTCOMES)[number]['key'];

export const CRM_OUTCOME_LABEL = Object.fromEntries(
  CRM_OUTCOMES.map((o) => [o.key, o.label]),
) as Record<string, string>;

/** Outcomes that signal renewed interest — these clear a sticky not-interested flag. */
export const CRM_POSITIVE_OUTCOMES: ReadonlySet<string> = new Set([
  'interested',
  'followup_required',
  'agreement_pending',
  'agreement_done',
  'signup_pending',
  'onboarded',
]);

export const CRM_NOT_INTERESTED_REASONS = [
  'Pricing',
  'Already using competitor',
  'No requirement',
  'Owner not interested',
  'Business closed',
  'Need approval',
  'Other',
] as const;

export const CRM_DOC_KINDS = [
  'Signed Agreement',
  'Store Photo',
  'GST Certificate',
  'PAN',
  'Aadhaar',
  'Shop License',
  'Other',
] as const;

export type CrmTargets = {
  visits: number;
  demos: number;
  agreements: number;
  onboardings: number;
};

export const CRM_DEFAULT_TARGETS: CrmTargets = {
  visits: 10,
  demos: 7,
  agreements: 4,
  onboardings: 2,
};

// ── Local-day helpers ────────────────────────────────────────────────────────
// Everything the CRM reports on buckets by local calendar day in CRM_TIMEZONE, so a working
// day never splits across the UTC midnight boundary. These helpers are the only place that
// conversion happens — controllers deal in `YYYY-MM-DD` strings from here on.

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.CRM_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The local calendar day (YYYY-MM-DD) that an instant falls on. */
export function crmLocalDay(d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return dayFormatter.format(d);
}

/** Local day N days before `from` (N may be negative for future days). */
export function crmDayOffset(days: number, from: Date = new Date()): string {
  return crmLocalDay(new Date(from.getTime() - days * 86_400_000));
}

/** First local day of the month that `d` falls in. */
export function crmMonthStart(d: Date = new Date()): string {
  return `${crmLocalDay(d).slice(0, 7)}-01`;
}

/** Which day-of-month it currently is locally — used to prorate month-to-date targets. */
export function crmDayOfMonth(d: Date = new Date()): number {
  return Number(crmLocalDay(d).slice(8, 10));
}

/** Inclusive count of days between two YYYY-MM-DD strings; always at least 1. */
export function crmDaySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/** Ascending list of local days spanning [from, to] inclusive, capped for safety. */
export function crmDayRange(from: string, to: string, cap = 400): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end)) return out;
  while (t <= end && out.length < cap) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** Percentage of `of`, rounded, guarding divide-by-zero. */
export function crmPct(n: number, of: number): number {
  return of > 0 ? Math.round((n / of) * 100) : 0;
}
