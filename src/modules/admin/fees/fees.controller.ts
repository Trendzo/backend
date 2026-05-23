import { eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  platformConfig,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { FeeOverrideBody, FeesUpdateBody } from './fees.validators.js';

type Auth = AccessTokenPayload;

const DELIVERY_METHODS = ['express', 'standard', 'pickup', 'try_and_buy'] as const;

const FEE_CONFIG_KEYS = [
  'base_delivery_fee_table',
  'surge_multiplier',
  'tcs_rate_bp',
] as const;

async function getConfigValue<T>(key: string, defaultValue: T): Promise<T> {
  const row = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, key),
  });
  return row ? (row.value as T) : defaultValue;
}

const DEFAULT_PLATFORM_FEE_BP = 1500; // 15%
const DEFAULT_GST_RATE_BP = 1800; // 18%
const DEFAULT_SURGE_MULTIPLIER = 1.0;

export async function getFees() {
  const [baseDelivery, surgeMultiplierRaw, tcsRateBp, gstRateBp, defaultPlatformFeeBp] =
    await Promise.all([
      getConfigValue<Record<string, number>>('base_delivery_fee_table', {
        express: 9900,
        standard: 4900,
        pickup: 0,
        try_and_buy: 9900,
      }),
      getConfigValue<number>('surge_multiplier', DEFAULT_SURGE_MULTIPLIER),
      getConfigValue<number>('tcs_rate_bp', 100),
      getConfigValue<number>('gst_rate_bp', DEFAULT_GST_RATE_BP),
      getConfigValue<number>('default_platform_fee_bp', DEFAULT_PLATFORM_FEE_BP),
    ]);

  const perKmDelivery = await getConfigValue<Record<string, number>>(
    'per_km_delivery_fee_table',
    { express: 200, standard: 100, pickup: 0, try_and_buy: 200 },
  );

  const delivery = Object.fromEntries(
    DELIVERY_METHODS.map((m) => [
      m,
      { baseFeePaise: baseDelivery[m] ?? 0, perKmFeePaise: perKmDelivery[m] ?? 0 },
    ]),
  ) as Record<
    (typeof DELIVERY_METHODS)[number],
    { baseFeePaise: number; perKmFeePaise: number }
  >;

  // Edit-history metadata for the three tunable keys F1/F2/F4 cover.
  const cfgRows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, FEE_CONFIG_KEYS as unknown as string[]),
  });
  const adminIds = cfgRows
    .map((r) => r.lastChangedAdminId)
    .filter((id): id is string => Boolean(id));
  const admins = adminIds.length
    ? await db.query.adminAccounts.findMany({
        where: inArray(adminAccounts.id, adminIds),
      })
    : [];
  const adminEmailById = new Map(admins.map((a) => [a.id, a.email]));
  const lastChanged: Record<string, { at: string; by: string | null }> = {};
  for (const r of cfgRows) {
    lastChanged[r.key] = {
      at: r.lastChangedAt.toISOString(),
      by: r.lastChangedAdminId
        ? adminEmailById.get(r.lastChangedAdminId) ?? null
        : null,
    };
  }

  // Per-retailer overrides: stores with platformFeeBp different from default
  const overrideStores = await db.query.retailerStores.findMany({
    where: ne(retailerStores.platformFeeBp, defaultPlatformFeeBp),
  });

  const overrides = await Promise.all(
    overrideStores.map(async (s) => {
      const account = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.storeId, s.id),
      });
      return {
        retailerId: account?.id ?? s.id,
        retailerName: s.legalName,
        platformFeeBp: s.platformFeeBp,
        reason: 'Custom rate',
      };
    }),
  );

  return ok({
    defaultPlatformFeeBp,
    surgeMultiplier: surgeMultiplierRaw,
    gstRateBp,
    tcsRateBp,
    intraStateSplit: { cgstBp: gstRateBp / 2, sgstBp: gstRateBp / 2 },
    interStateSplit: { igstBp: gstRateBp },
    delivery,
    platformFeeOverrides: overrides,
    lastChanged,
  });
}

export async function updateFees(input: {
  auth: Auth;
  body: z.infer<typeof FeesUpdateBody>;
}) {
  const { auth, body } = input;
  const updated: string[] = [];

  await db.transaction(async (tx) => {
    const updateKey = async (key: string, nextValue: unknown) => {
      const existing = await tx.query.platformConfig.findFirst({
        where: eq(platformConfig.key, key),
      });
      if (existing) {
        await tx
          .update(platformConfig)
          .set({
            priorValue: existing.value,
            value: nextValue,
            lastChangedAdminId: auth.sub,
            lastChangedAt: new Date(),
          })
          .where(eq(platformConfig.key, key));
      } else {
        await tx.insert(platformConfig).values({
          key,
          value: nextValue,
          lastChangedAdminId: auth.sub,
        });
      }
      updated.push(key);
    };

    if (body.baseDeliveryFee) {
      const existing = await tx.query.platformConfig.findFirst({
        where: eq(platformConfig.key, 'base_delivery_fee_table'),
      });
      const current = (existing?.value as Record<string, number> | undefined) ?? {
        express: 9900,
        standard: 4900,
        pickup: 0,
        try_and_buy: 9900,
      };
      const merged = { ...current, ...body.baseDeliveryFee };
      await updateKey('base_delivery_fee_table', merged);
    }

    if (body.surgeMultiplier !== undefined) {
      await updateKey('surge_multiplier', body.surgeMultiplier);
    }
    if (body.tcsRateBp !== undefined) {
      await updateKey('tcs_rate_bp', body.tcsRateBp);
    }
  });

  return ok({ updated });
}

export async function setRetailerFeeOverride(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof FeeOverrideBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, id),
  });
  if (!retailer?.storeId) throw new Error('Store not found for retailer');

  const priorStore = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  const priorBp = priorStore?.platformFeeBp ?? null;

  const [store] = await db
    .update(retailerStores)
    .set({ platformFeeBp: body.platformFeeBp })
    .where(eq(retailerStores.id, retailer.storeId))
    .returning();

  await recordAudit({
    actor: auth,
    action: 'store.platform_fee_override',
    resourceKind: 'retailer_store',
    resourceId: retailer.storeId,
    before: { platformFeeBp: priorBp },
    after: { platformFeeBp: body.platformFeeBp },
    note: body.reason,
    requestId,
  });

  // Best-effort retailer notification — failure must not block the admin action.
  await notifyStoreAccounts({
    storeId: retailer.storeId,
    kind: 'system',
    title: 'Platform fee updated',
    body: `Admin set platform fee to ${body.platformFeeBp}bp: ${body.reason}`,
    deepLink: '/retailer/billing',
  }).catch(() => undefined);

  return ok({ storeId: retailer.storeId, platformFeeBp: store!.platformFeeBp });
}

export async function getDeliveryWindows() {
  const [radiusMap, surgeMultiplier, baseDelivery, perKmDelivery] = await Promise.all([
    getConfigValue<Record<string, number>>('serviceable_radius_meters', {
      express: 7000,
      standard: 25000,
      try_and_buy: 7000,
      pickup: 0,
    }),
    getConfigValue<number>('surge_multiplier', DEFAULT_SURGE_MULTIPLIER),
    getConfigValue<Record<string, number>>('base_delivery_fee_table', {
      express: 9900,
      standard: 4900,
      pickup: 0,
      try_and_buy: 9900,
    }),
    getConfigValue<Record<string, number>>('per_km_delivery_fee_table', {
      express: 200,
      standard: 100,
      pickup: 0,
      try_and_buy: 200,
    }),
  ]);

  const fees = Object.fromEntries(
    DELIVERY_METHODS.map((m) => [
      m,
      { baseFeePaise: baseDelivery[m] ?? 0, perKmFeePaise: perKmDelivery[m] ?? 0 },
    ]),
  );

  // serviceableRadiusKm: use express (tightest), in km
  const expressRadiusKm = (radiusMap['express'] ?? 7000) / 1000;

  return ok({ serviceableRadiusKm: expressRadiusKm, surgeMultiplier, fees });
}
