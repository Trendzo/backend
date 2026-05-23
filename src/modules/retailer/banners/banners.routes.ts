import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { ok } from '@/shared/http/envelope.js';
import { dismissBanner, getBannersForRetailer } from '@/shared/banners/banners.js';

const IdParam = z.object({ id: z.string() });

const retailerBannersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get('/', async (req) => {
    const auth = getAuth(req);
    return ok(await getBannersForRetailer(auth.sub));
  });

  app.post(
    '/:id/dismiss',
    { schema: { params: IdParam } },
    async (req) => {
      const auth = getAuth(req);
      await dismissBanner({
        bannerId: req.params.id,
        accountKind: 'retailer',
        accountId: auth.sub,
      });
      return ok({ dismissed: true });
    },
  );
};

export default retailerBannersRoutes;
