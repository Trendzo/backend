import { eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import { platformConfig, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

const DELIVERY_METHODS = ['express', 'standard', 'pickup', 'try_and_buy'] as const;


async function getConfigValue<T>(key: string, defaultValue: T): Promise<T> {
  const row = await db.query.platformConfig.findFirst({ where: eq(platformConfig.key, key) });
  return row ? (row.value as T) : defaultValue;
}

const DEFAULT_PLATFORM_FEE_BP = 1500; // 15%
const DEFAULT_GST_RATE_BP = 1800; // 18%
const DEFAULT_SURGE_MULTIPLIER = 1.0;

const adminFeesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/fees — marketplace-wide fee config =====
  app.get('/fees', async () => {
    const [baseDelivery, surgeMultiplierRaw, tcsRateBp, gstRateBp, defaultPlatformFeeBp] = await Promise.all([
      getConfigValue<Record<string, number>>('base_delivery_fee_table', {
        express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900,
      }),
      getConfigValue<number>('surge_multiplier', DEFAULT_SURGE_MULTIPLIER),
      getConfigValue<number>('tcs_rate_bp', 100),
      getConfigValue<number>('gst_rate_bp', DEFAULT_GST_RATE_BP),
      getConfigValue<number>('default_platform_fee_bp', DEFAULT_PLATFORM_FEE_BP),
    ]);

    const perKmDelivery = await getConfigValue<Record<string, number>>('per_km_delivery_fee_table', {
      express: 200, standard: 100, pickup: 0, try_and_buy: 200,
    });

    const delivery = Object.fromEntries(
      DELIVERY_METHODS.map((m) => [
        m,
        { baseFeePaise: baseDelivery[m] ?? 0, perKmFeePaise: perKmDelivery[m] ?? 0 },
      ]),
    ) as Record<typeof DELIVERY_METHODS[number], { baseFeePaise: number; perKmFeePaise: number }>;

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
    });
  });

  // ===== PATCH /admin/retailers/:id/fee-override — per-retailer platform fee override =====
  app.patch(
    '/retailers/:id/fee-override',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ platformFeeBp: z.number().int().min(0).max(10000), reason: z.string().min(3) }),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({ where: eq(retailerAccounts.id, req.params.id) });
      if (!retailer?.storeId) throw new Error('Store not found for retailer');

      const [store] = await db
        .update(retailerStores)
        .set({ platformFeeBp: req.body.platformFeeBp })
        .where(eq(retailerStores.id, retailer.storeId))
        .returning();

      return ok({ storeId: retailer.storeId, platformFeeBp: store!.platformFeeBp });
    },
  );

  // ===== GET /admin/delivery-windows — serviceable radius + per-method fee config =====
  app.get('/delivery-windows', async () => {
    const [radiusMap, surgeMultiplier, baseDelivery, perKmDelivery] = await Promise.all([
      getConfigValue<Record<string, number>>('serviceable_radius_meters', {
        express: 7000, standard: 25000, try_and_buy: 7000, pickup: 0,
      }),
      getConfigValue<number>('surge_multiplier', DEFAULT_SURGE_MULTIPLIER),
      getConfigValue<Record<string, number>>('base_delivery_fee_table', {
        express: 9900, standard: 4900, pickup: 0, try_and_buy: 9900,
      }),
      getConfigValue<Record<string, number>>('per_km_delivery_fee_table', {
        express: 200, standard: 100, pickup: 0, try_and_buy: 200,
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
  });
};

export default adminFeesRoutes;
