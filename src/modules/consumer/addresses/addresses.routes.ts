import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './addresses.controller.js';
import {
  AddressBodySchema,
  IdParam,
  PartialAddressBodySchema,
} from './addresses.validators.js';

const consumerAddressRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/', async (req) => ctrl.listAddresses({ auth: getAuth(req) }));

  app.post(
    '/',
    { schema: { body: AddressBodySchema } },
    async (req) => ctrl.createAddress({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/:id',
    {
      schema: { params: IdParam, body: PartialAddressBodySchema },
    },
    async (req) =>
      ctrl.patchAddress({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteAddress({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/set-default',
    { schema: { params: IdParam } },
    async (req) => ctrl.setDefaultAddress({ auth: getAuth(req), id: req.params.id }),
  );
};

export default consumerAddressRoutes;
