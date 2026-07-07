/** Driver broadcast-offer routes. Mounted at /driver/offers, gated by requireAuth('driver'). */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './offers.controller.js';

const IdParam = z.object({ id: z.string() });
const LongPollQuery = z.object({ wait: z.coerce.number().int().min(1000).max(30000).optional() });

const driverOffersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get('/', async (req) => ctrl.listOffers({ auth: getAuth(req) }));

  // Long-poll — the request parks until an offer is available or `wait` ms elapse.
  app.get(
    '/long-poll',
    { schema: { querystring: LongPollQuery } },
    async (req) =>
      ctrl.longPollOffers({
        auth: getAuth(req),
        ...(req.query.wait !== undefined ? { waitMs: req.query.wait } : {}),
      }),
  );

  app.post(
    '/:id/accept',
    { schema: { params: IdParam } },
    async (req) => ctrl.acceptOffer({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/reject',
    { schema: { params: IdParam } },
    async (req) => ctrl.rejectOffer({ auth: getAuth(req), id: req.params.id }),
  );
};

export default driverOffersRoutes;
