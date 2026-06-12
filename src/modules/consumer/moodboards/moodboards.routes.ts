import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './moodboards.controller.js';
import {
  AddItemBody,
  CreateBoardBody,
  IdParam,
  ItemParam,
  PatchBoardBody,
} from './moodboards.validators.js';

const consumerMoodboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.get('/', async (req) => ctrl.listBoards({ auth: getAuth(req) }));

  app.post(
    '/',
    { schema: { body: CreateBoardBody } },
    async (req) => ctrl.createBoard({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getBoard({ auth: getAuth(req), id: req.params.id }),
  );

  app.patch(
    '/:id',
    { schema: { params: IdParam, body: PatchBoardBody } },
    async (req) => ctrl.patchBoard({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.delete(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.deleteBoard({ auth: getAuth(req), id: req.params.id }),
  );

  app.post(
    '/:id/items',
    { schema: { params: IdParam, body: AddItemBody } },
    async (req) => ctrl.addItem({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.delete(
    '/:id/items/:itemId',
    { schema: { params: ItemParam } },
    async (req) =>
      ctrl.removeItem({ auth: getAuth(req), id: req.params.id, itemId: req.params.itemId }),
  );
};

export default consumerMoodboardRoutes;
