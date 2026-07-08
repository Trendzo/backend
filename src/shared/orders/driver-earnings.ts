/**
 * Record a driver's earnings for a completed leg. Base payout is read from
 * `platform_config.driver_payout_table` (paise, per method — includes
 * 'reverse_pickup'). Idempotent via the two partial unique indexes: forward legs
 * unique per order, reverse-pickup legs unique per task — a re-transition (or
 * retry) never double-pays, and both legs can coexist on one orderId.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { driverEarnings, platformConfig } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type DeliveryMethod = 'express' | 'standard' | 'pickup' | 'try_and_buy' | 'reverse_pickup';

export async function recordDriverEarnings(
  database: typeof Db,
  input: {
    orderId: string;
    driverId: string;
    deliveryMethod: string;
    tipPaise?: number;
    /** Set for reverse-pickup legs — keys idempotency to the task, not the order. */
    reversePickupId?: string;
  },
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
      reversePickupId: input.reversePickupId ?? null,
      deliveryMethod: input.deliveryMethod as DeliveryMethod,
      basePaise,
      incentivePaise,
      tipPaise,
      totalPaise,
    })
    // Targetless: catches whichever partial unique index the row collides with
    // (an explicit target can't express a partial index's predicate here).
    .onConflictDoNothing();
}
