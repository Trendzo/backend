import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import { platformConfig, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';

async function getConfigValue<T>(key: string, defaultValue: T): Promise<T> {
  const row = await db.query.platformConfig.findFirst({ where: eq(platformConfig.key, key) });
  return row ? (row.value as T) : defaultValue;
}

const retailerFeesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/fees =====
  app.get('/fees', async (req) => {
    const auth = getAuth(req);
    const retailer = await db.query.retailerAccounts.findFirst({
      where: eq(retailerAccounts.id, auth.sub),
    });
    if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, retailer.storeId),
    });
    if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

    const [gstRateBp, tcsRateBp] = await Promise.all([
      getConfigValue<number>('gst_rate_bp', 1800),
      getConfigValue<number>('tcs_rate_bp', 100),
    ]);

    return ok({
      platformFeeBp: store.platformFeeBp,
      payoutCadenceDays: store.payoutCadenceDays,
      delegationModeEnabled: store.delegationModeEnabled,
      handlingFeePaise: store.handlingFeePaise ?? 0,
      convenienceFeePaise: store.convenienceFeePaise ?? 0,
      gstRateBp,
      tcsRateBp,
    });
  });
};

export default retailerFeesRoutes;
