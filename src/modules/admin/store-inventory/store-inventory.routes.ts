import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-inventory.controller.js';
import { ExportQuery, ImportBody, StoreParam } from './store-inventory.validators.js';

const adminStoreInventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/:storeId/inventory/import',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: StoreParam, body: ImportBody },
    },
    async (req) =>
      ctrl.csvImport({
        auth: getAuth(req),
        storeId: req.params.storeId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.get(
    '/:storeId/inventory/export',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: StoreParam, querystring: ExportQuery },
    },
    async (req, reply) =>
      ctrl.csvExport({ storeId: req.params.storeId, query: req.query, reply }),
  );
};

export default adminStoreInventoryRoutes;
