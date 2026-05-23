import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './inventory.controller.js';
import {
  AdjustmentsQuery,
  BestSellersQuery,
  ExportQuery,
  ImportBody,
  ListQuery,
  ReservationsQuery,
  SettingsBody,
  VariantIdParam,
} from './inventory.validators.js';

const inventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/',
    {
      preHandler: requirePermission('inventory.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listInventory({ auth: getAuth(req), query: req.query }),
  );

  app.patch(
    '/settings',
    {
      preHandler: requirePermission('inventory.adjust'),
      schema: { body: SettingsBody },
    },
    async (req) => ctrl.patchSettings({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/:variantId/reservations',
    {
      preHandler: requirePermission('inventory.view'),
      schema: { params: VariantIdParam, querystring: ReservationsQuery },
    },
    async (req) =>
      ctrl.listReservations({
        auth: getAuth(req),
        variantId: req.params.variantId,
        query: req.query,
      }),
  );

  app.get(
    '/adjustments',
    {
      preHandler: requirePermission('inventory.view'),
      schema: { querystring: AdjustmentsQuery },
    },
    async (req) => ctrl.listAdjustments({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/export',
    {
      preHandler: requirePermission('inventory.export'),
      schema: { querystring: ExportQuery },
    },
    async (req, reply) =>
      ctrl.exportInventory({ auth: getAuth(req), query: req.query, reply }),
  );

  app.post(
    '/import',
    {
      preHandler: requirePermission('inventory.import'),
      schema: { body: ImportBody },
    },
    async (req) => ctrl.importInventory({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/template',
    { preHandler: requirePermission('inventory.view') },
    async (_req, reply) => ctrl.downloadTemplate({ reply }),
  );

  app.get(
    '/reports/inventory-health/best-sellers',
    {
      preHandler: requirePermission('reports.view'),
      schema: { querystring: BestSellersQuery },
    },
    async (req) => ctrl.bestSellers({ auth: getAuth(req), query: req.query }),
  );
};

export default inventoryRoutes;
