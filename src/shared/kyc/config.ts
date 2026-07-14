/**
 * KYC timing, read from platform_config. These keys were seeded from day one but
 * read by nothing — `openOrRefreshKycCycle` hardcoded 14/30 days instead, and the
 * grace period ("window after due date before auto-pause") was never implemented.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { platformConfig } from '@/db/schema/index.js';

export type KycConfig = {
  /** How long a retailer has to submit before the cycle goes overdue. */
  dueDays: number;
  /** Days after `dueAt` before an overdue store is auto-paused. */
  graceDays: number;
  /** Cadence for routine re-verification (used when opening a fresh annual cycle). */
  cadenceDays: number;
};

const KYC_CONFIG_KEYS = [
  'kyc_due_days',
  'kyc_grace_period_days',
  'kyc_reverification_cadence_days',
] as const;

const DEFAULTS: KycConfig = { dueDays: 14, graceDays: 30, cadenceDays: 365 };

export async function loadKycConfig(): Promise<KycConfig> {
  const rows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, KYC_CONFIG_KEYS as unknown as string[]),
  });
  const map = new Map(rows.map((r) => [r.key, r.value as number]));
  return {
    dueDays: (map.get('kyc_due_days') as number) ?? DEFAULTS.dueDays,
    graceDays: (map.get('kyc_grace_period_days') as number) ?? DEFAULTS.graceDays,
    cadenceDays: (map.get('kyc_reverification_cadence_days') as number) ?? DEFAULTS.cadenceDays,
  };
}
