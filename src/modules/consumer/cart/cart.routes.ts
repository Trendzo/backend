import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './cart.controller.js';
import {
  AddItemBody,
  ReplaceCartBody,
  SetQtyBody,
  VariantIdParamSchema,
} from './cart.validators.js';

const consumerCartRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/', async (req) => ctrl.getCart({ auth: getAuth(req) }));

  app.put(
    '/',
    { schema: { body: ReplaceCartBody } },
    async (req) => ctrl.replaceCart({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/items',
    { schema: { body: AddItemBody } },
    async (req) => ctrl.addItem({ auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/items/:variantId',
    { schema: { params: VariantIdParamSchema, body: SetQtyBody } },
    async (req) =>
      ctrl.setItemQty({ auth: getAuth(req), variantId: req.params.variantId, body: req.body }),
  );

  app.delete(
    '/items/:variantId',
    { schema: { params: VariantIdParamSchema } },
    async (req) => ctrl.removeItem({ auth: getAuth(req), variantId: req.params.variantId }),
  );

  app.delete('/', async (req) => ctrl.clearCart({ auth: getAuth(req) }));
};

export default consumerCartRoutes;
