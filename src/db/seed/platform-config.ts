/**
 * Default platform_config rows. Mirrors the table in PRODUCT_SPEC §"Seed Data → Platform
 * Config Defaults" exactly. Never modify a row here that the spec has not changed first.
 *
 * Run via the seed orchestrator (`src/db/seed/run.ts`) — NEVER auto-executed.
 */

import { env } from '@/config/env.js';
import type { db as Db } from '@/db/client.js';
import { platformConfig } from '@/db/schema/index.js';

type ConfigRow = {
  key: string;
  value: unknown;
  description: string;
};

export const PLATFORM_CONFIG_DEFAULTS: readonly ConfigRow[] = [
  // Loyalty
  { key: 'loyalty_point_value_paise', value: 100, description: '1 point = ₹1' },
  {
    key: 'loyalty_earn_rate_bp',
    value: 10000,
    description: '1 point per ₹1 spent (post-discount, pre-tax)',
  },
  { key: 'min_redeemable_points', value: 100, description: 'Floor per redemption' },
  {
    key: 'max_redeem_fraction_bp',
    value: 10000,
    description: 'Up to 100% of eligible amount',
  },

  // Acquisition rewards
  { key: 'welcome_points', value: 100, description: 'Awarded at signup' },
  { key: 'referrer_points', value: 200, description: 'Awarded for a successful referral' },
  { key: 'referred_points', value: 100, description: 'Awarded to the referred consumer' },
  { key: 'quiz_completion_points', value: 50, description: 'First style-quiz completion' },
  {
    key: 'daily_reward_table',
    value: [10, 20, 30, 40, 50, 60, 100],
    description: 'Indexed by streak day',
  },

  // Pricing / fees
  {
    key: 'base_delivery_fee_table',
    value: { express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900 },
    description: 'Per delivery method, in paise',
  },
  {
    key: 'driver_payout_table',
    value: { express: 4000, standard: 3000, pickup: 0, try_and_buy: 5000, reverse_pickup: 3000 },
    description: 'Driver base payout per delivery method, in paise',
  },
  { key: 'surge_multiplier', value: 1.0, description: 'Hook for future dynamic pricing' },
  {
    key: 'tcs_rate_bp',
    value: env.TCS_RATE_BP,
    description: 'TCS withheld per transaction (sourced from env at seed time)',
  },

  // Windows / timers
  {
    key: 'acceptance_window_seconds',
    value: 180,
    description: 'Time the assigned store has to accept',
  },
  {
    key: 'try_on_window_seconds',
    value: 900,
    description: 'Try-and-Buy door countdown (15 min)',
  },
  {
    key: 'try_on_extension_seconds',
    value: 300,
    description: 'Consumer can extend once (5 min)',
  },
  {
    key: 'verification_window_hours',
    value: 24,
    description: "Retailer's deadline to verify door-returns",
  },
  { key: 'holding_window_days', value: 14, description: 'How long a held item waits at the store' },
  {
    key: 'holding_window_warning_days_before_expiry',
    value: 3,
    description: 'When to warn the consumer',
  },

  // Quality floors
  {
    key: 'acceptance_rate_floor_bp',
    value: 8000,
    description: '80% over trailing 30 days',
  },
  {
    key: 'dispute_rate_floor_bp',
    value: 500,
    description: '5% over trailing 30 days',
  },

  // KYC
  {
    key: 'kyc_reverification_cadence_days',
    value: 365,
    description: 'Annual re-verification',
  },
  {
    key: 'kyc_grace_period_days',
    value: 30,
    description: 'Window after due date before auto-pause (the one allowed exception)',
  },

  // Geography / fulfilment
  {
    key: 'serviceable_radius_meters',
    value: { express: 7000, standard: 25000, try_and_buy: 7000, pickup: 0 },
    description: 'Per delivery method',
  },
  {
    key: 'undelivered_retry_budget',
    value: 1,
    description: 'Retries before returning to store',
  },
  {
    key: 'payout_cadence_days',
    value: 7,
    description: 'Default; can be overridden per retailer',
  },

  // AI catalog
  {
    key: 'ai_catalog_daily_quota',
    value: null,
    description: 'null = unlimited at launch',
  },
  {
    key: 'ai_catalog_rejected_retention_days',
    value: 30,
    description: 'Before purging unaccepted images',
  },

  // Privacy / retention
  {
    key: 'consumer_data_export_window_days',
    value: 30,
    description: 'SLA for delivering data exports',
  },
  {
    key: 'consumer_account_deletion_claim_window_days',
    value: 90,
    description: 'Wallet balance claim window after deletion',
  },
  {
    key: 'consumer_data_retention_years',
    value: 7,
    description: 'Tax-record retention after anonymisation',
  },
];

/**
 * Insert defaults; existing keys are left alone (admin may have edited them post-launch).
 * Caller must run inside a transaction; not auto-executed.
 */
export async function seedPlatformConfig(db: typeof Db): Promise<void> {
  for (const row of PLATFORM_CONFIG_DEFAULTS) {
    // `value` is NOT NULL; rows whose value is JS `null` (sentinel for "unlimited" /
    // "unset" knobs) are skipped at seed time — admin sets them later if needed.
    if (row.value === null) continue;
    await db
      .insert(platformConfig)
      .values({ key: row.key, value: row.value, description: row.description })
      .onConflictDoNothing({ target: platformConfig.key });
  }
}
