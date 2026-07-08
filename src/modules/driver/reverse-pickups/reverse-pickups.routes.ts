/**
 * Driver reverse-pickup routes. Mounted at /driver/reverse-pickups, gated by
 * requireAuth('driver'). No separate long-poll — pool mutations fire the shared
 * offers bus, so the app's existing /driver/offers/long-poll wake covers this feed.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './reverse-pickups.controller.js';
import { CollectBody, IdParam } from './reverse-pickups.validators.js';

const driverReversePickupsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('driver'));

  app.get('/', async (req) => ctrl.listMine({ auth: getAuth(req) }));

  app.get('/offers', async (req) => ctrl.listOffers({ auth: getAuth(req) }));

  app.post(
    '/:id/accept',
    { schema: { params: IdParam } },
    async (req) => ctrl.acceptTask({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/reject',
    { schema: { params: IdParam } },
    async (req) => ctrl.rejectTask({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/collect',
    { schema: { params: IdParam, body: CollectBody } },
    async (req) => ctrl.collectTask({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/deliver-to-store',
    { schema: { params: IdParam } },
    async (req) => ctrl.deliverToStore({ auth: getAuth(req), id: req.params.id }),
  );
};

export default driverReversePickupsRoutes;
