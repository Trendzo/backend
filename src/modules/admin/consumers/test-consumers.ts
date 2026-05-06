/**
 * Admin "mint test consumer" route + test address creation. Pure dev/test surface — the
 * synthetic accounts are clearly labelled (`test-{ulid}@closetx.test`) so they're easy to
 * filter out of analytics.
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { addresses, consumers, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const adminTestConsumerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== POST /admin/consumers/test — mint a synthetic test consumer + default address =====
  app.post(
    '/test',
    {
      schema: {
        body: z
          .object({
            legalName: z.string().trim().min(1).max(120).optional(),
            /** If supplied, the new address is anchored to the given store's state code. */
            storeId: z.string().optional(),
          })
          .default({}),
      },
    },
    async (req) => {
      const slug = newId(IdPrefix.Consumer).slice(4, 12);
      const name = req.body.legalName?.trim() || `Test Consumer ${slug}`;
      const email = `test-${slug}@closetx.test`;
      const phone = `+91${Math.floor(7000000000 + Math.random() * 999999999)}`;
      const passwordHash = await hashPassword('TestPass!1');

      // Default address — anchored to the chosen store's state for an intra-state GST split.
      let stateCode = '27'; // Maharashtra fallback
      let lat = 19.076;
      let lng = 72.8777;
      let city = 'Mumbai';
      let pincode = '400001';
      if (req.body.storeId) {
        const store = await db.query.retailerStores.findFirst({
          where: eq(retailerStores.id, req.body.storeId),
        });
        if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
        stateCode = store.stateCode;
        lat = store.lat;
        lng = store.lng;
      }

      const consumerId = newId(IdPrefix.Consumer);
      await db.insert(consumers).values({
        id: consumerId,
        email,
        phone,
        name,
        passwordHash,
      });

      const addressId = newId(IdPrefix.Address);
      await db.insert(addresses).values({
        id: addressId,
        consumerId,
        label: 'home',
        line1: 'Test Address Line 1',
        line2: null,
        city,
        pincode,
        stateCode,
        lat,
        lng,
      });

      return ok({
        consumer: {
          id: consumerId,
          email,
          phone,
          name,
        },
        addressId,
      });
    },
  );
};

export default adminTestConsumerRoutes;
