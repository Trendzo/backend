/**
 * Record a driver's earnings for a delivered order. Base payout is read from
 * `platform_config.driver_payout_table` (paise, per delivery method). Idempotent via
 * the `UNIQUE(order_id)` index — a re-transition to `delivered` never double-pays.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { driverEarnings, platformConfig } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type DeliveryMethod = 'express' | 'standard' | 'pickup' | 'try_and_buy';

export async function recordDriverEarnings(
  database: typeof Db,
  input: { orderId: string; driverId: string; deliveryMethod: string; tipPaise?: number },
): Promise<void> {
  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'driver_payout_table'),
  });
  const table = (cfg?.value ?? {}) as Record<string, number>;
  const basePaise = Number(table[input.deliveryMethod] ?? 0);
  const tipPaise = input.tipPaise ?? 0;
  const incentivePaise = 0;
  const totalPaise = basePaise + incentivePaise + tipPaise;
  await database
    .insert(driverEarnings)
    .values({
      id: newId(IdPrefix.DriverEarning),
      driverId: input.driverId,
      orderId: input.orderId,
      deliveryMethod: input.deliveryMethod as DeliveryMethod,
      basePaise,
      incentivePaise,
      tipPaise,
      totalPaise,
    })
    .onConflictDoNothing({ target: driverEarnings.orderId });
}
