/**
 * GET /app-config — every operational value a client would otherwise hardcode.
 *
 * Over fifty values live in `platform_config` and, before this, none of them
 * were readable by the consumer app. So the app kept its own copies: delivery
 * fees written twice in two files, a loyalty tier ladder invented locally, a
 * return window baked in as a constant, "15 min" trial copy in eight places.
 * Each of those is wrong the moment ops changes the real value, and wrong
 * silently.
 *
 * This is the whitelisted, consumer-safe subset. Public and unauthenticated —
 * it carries no per-user data, and much of the copy renders before sign-in.
 * Cache it for an hour; the values change rarely.
 *
 * Adding a key here makes it public. Only add what the customer is allowed to
 * see: nothing about margins, driver payouts, fraud thresholds or KYC cadence.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { platformConfig } from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { ok } from '@/shared/http/envelope.js';

/** Fallbacks mirror the reading code so the app degrades the same way the server does. */
const D = {
  tryOnWindowSeconds: 600, // door-visit.ts DEFAULT_TRY_ON_WINDOW_SECONDS
  tryOnExtensionSeconds: 300,
  returnWindowDays: 7, // open-return.ts RETURN_WINDOW_DAYS
  pointValuePaise: 100,
  earnRateBp: 10000,
  minRedeemablePoints: 100,
  maxRedeemFractionBp: 10000,
  silverMin: 500,
  goldMin: 2000,
  platinumMin: 5000,
  referrerPoints: 200,
  referredPoints: 100,
  welcomePoints: 100,
  acceptanceWindowSeconds: 180,
  paymentAbandonMinutes: 30,
  orderCloseAfterDays: 7,
  pickupNoshowCancelDays: 3,
  holdingWindowDays: 14,
  surge: 1,
  deliveryFees: { express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900 } as Record<string, number>,
};

const KEYS = [
  'try_on_window_seconds', 'try_on_extension_seconds', 'return_window_days',
  'loyalty_point_value_paise', 'loyalty_earn_rate_bp',
  'min_redeemable_points', 'max_redeem_fraction_bp',
  'loyalty_tier_silver_min', 'loyalty_tier_gold_min', 'loyalty_tier_platinum_min',
  'referrer_points', 'referred_points', 'welcome_points',
  'acceptance_window_seconds', 'payment_abandon_minutes', 'order_close_after_days',
  'pickup_noshow_cancel_days', 'holding_window_days',
  'base_delivery_fee_table', 'surge_multiplier',
];

/**
 * Delivery method presentation.
 *
 * The FEE comes from config (base table x surge, and a store may still override
 * it at quote time — the quote is always authoritative). The label, blurb and
 * ETA are editorial copy with no config key, so they live here rather than
 * being duplicated in every client. `etaLabel` is deliberately a string, not a
 * number: "60 min" and "2-3 days" are not the same unit.
 */
const METHOD_COPY: Record<string, { label: string; blurb: string; etaLabel: string; icon: string }> = {
  express: { label: 'Express', blurb: 'From your nearest store, in under an hour', etaLabel: '60 min', icon: 'zap' },
  standard: { label: 'Standard', blurb: 'Tracked shipping, door to door', etaLabel: '2-3 days', icon: 'package' },
  pickup: { label: 'Store pickup', blurb: 'Collect at the counter with your code', etaLabel: 'In store', icon: 'map-pin' },
  try_and_buy: { label: 'Try & Buy', blurb: 'Try at your door, keep what fits', etaLabel: 'Next day', icon: 'home' },
};

/** Mirrors the ReasonCategory zod enum on POST /consumer/returns. */
const RETURN_REASONS = [
  { value: 'doesnt_fit', label: 'Does not fit' },
  { value: 'damaged', label: 'Damaged or defective' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'other', label: 'Another reason' },
] as const;

const appConfigRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', async () => {
    const rows = await db.query.platformConfig.findMany({
      where: inArray(platformConfig.key, KEYS),
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const num = (k: string, fallback: number): number => {
      const v = map.get(k);
      return typeof v === 'number' ? v : fallback;
    };

    const surge = num('surge_multiplier', D.surge);
    const table = (map.get('base_delivery_fee_table') as Record<string, number> | undefined)
      ?? D.deliveryFees;

    // Only methods the platform actually prices are advertised.
    const methods = (['express', 'standard', 'pickup', 'try_and_buy'] as const)
      .filter((id) => table[id] !== undefined)
      .map((id) => ({
        id,
        ...METHOD_COPY[id]!,
        // Rounded to whole paise; the quote may still differ per store, and the
        // client must prefer the quote wherever it has one.
        feePaise: Math.round((table[id] ?? 0) * surge),
      }));

    return ok({
      support: {
        email: env.PUBLIC_SUPPORT_EMAIL,
        phone: env.PUBLIC_SUPPORT_PHONE ?? null,
        address: env.PUBLIC_BUSINESS_ADDRESS ?? null,
        hours: env.PUBLIC_SUPPORT_HOURS ?? null,
      },
      delivery: {
        methods,
        // Advisory only: a store override or a coupon can change this.
        surgeMultiplier: surge,
      },
      tryAndBuy: {
        windowSeconds: num('try_on_window_seconds', D.tryOnWindowSeconds),
        extensionSeconds: num('try_on_extension_seconds', D.tryOnExtensionSeconds),
        // NOT enforced anywhere in the backend — no table, no key, no validation.
        // null so the app hides the claim rather than stating an unenforced rule.
        maxItemsPerTrial: null as number | null,
        maxTrialsPerMonth: null as number | null,
      },
      returns: {
        windowDays: num('return_window_days', D.returnWindowDays),
        reasons: RETURN_REASONS,
      },
      loyalty: {
        // Everything needed to say "use 240 points, saves ₹240" truthfully.
        pointValuePaise: num('loyalty_point_value_paise', D.pointValuePaise),
        earnRateBp: num('loyalty_earn_rate_bp', D.earnRateBp),
        minRedeemablePoints: num('min_redeemable_points', D.minRedeemablePoints),
        maxRedeemFractionBp: num('max_redeem_fraction_bp', D.maxRedeemFractionBp),
        tiers: [
          { name: 'BRONZE', minPoints: 0 },
          { name: 'SILVER', minPoints: num('loyalty_tier_silver_min', D.silverMin) },
          { name: 'GOLD', minPoints: num('loyalty_tier_gold_min', D.goldMin) },
          { name: 'PLATINUM', minPoints: num('loyalty_tier_platinum_min', D.platinumMin) },
        ],
      },
      referral: {
        referrerPoints: num('referrer_points', D.referrerPoints),
        referredPoints: num('referred_points', D.referredPoints),
        welcomePoints: num('welcome_points', D.welcomePoints),
      },
      // Timings the customer is affected by but was never told about — an
      // unpaid order simply vanished after 30 minutes with no explanation.
      orderLifecycle: {
        acceptanceWindowSeconds: num('acceptance_window_seconds', D.acceptanceWindowSeconds),
        paymentAbandonMinutes: num('payment_abandon_minutes', D.paymentAbandonMinutes),
        orderCloseAfterDays: num('order_close_after_days', D.orderCloseAfterDays),
        pickupNoshowCancelDays: num('pickup_noshow_cancel_days', D.pickupNoshowCancelDays),
        holdingWindowDays: num('holding_window_days', D.holdingWindowDays),
      },
      company: {
        name: env.PUBLIC_COMPANY_NAME,
        appName: env.PUBLIC_APP_NAME,
      },
    });
  });
};

export default appConfigRoutes;
