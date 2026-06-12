import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './pos.controller.js';
import {
  CreateSaleBody,
  CustomersQuery,
  HoldSaleBody,
  IdParam,
  ListSalesQuery,
  LookupQuery,
  QuoteBody,
  ReturnSaleBody,
  SummaryQuery,
  VoidSaleBody,
} from './pos.validators.js';

const retailerPosRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/lookup',
    { preHandler: requirePermission('pos.sell'), schema: { querystring: LookupQuery } },
    async (req) => ctrl.lookup({ auth: getAuth(req), query: req.query }),
  );

  app.post(
    '/quote',
    { preHandler: requirePermission('pos.sell'), schema: { body: QuoteBody } },
    async (req) => ctrl.quote({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales',
    { preHandler: requirePermission('pos.sell'), schema: { body: CreateSaleBody } },
    async (req) => ctrl.createSale({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales/hold',
    { preHandler: requirePermission('pos.sell'), schema: { body: HoldSaleBody } },
    async (req) => ctrl.holdSale({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales/:id/void',
    { preHandler: requirePermission('pos.refund'), schema: { params: IdParam, body: VoidSaleBody } },
    async (req) => ctrl.voidSale({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/sales/:id/returns',
    { preHandler: requirePermission('pos.refund'), schema: { params: IdParam, body: ReturnSaleBody } },
    async (req) => ctrl.returnSale({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.get(
    '/sales',
    { preHandler: requirePermission('pos.view'), schema: { querystring: ListSalesQuery } },
    async (req) => ctrl.listSales({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/held',
    { preHandler: requirePermission('pos.sell') },
    async (req) => ctrl.listHeld({ auth: getAuth(req) }),
  );

  app.get(
    '/customers',
    { preHandler: requirePermission('pos.sell'), schema: { querystring: CustomersQuery } },
    async (req) => ctrl.listCustomers({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/summary',
    { preHandler: requirePermission('pos.view'), schema: { querystring: SummaryQuery } },
    async (req) => ctrl.daySummary({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/sales/:id',
    { preHandler: requirePermission('pos.view'), schema: { params: IdParam } },
    async (req) => ctrl.getSale({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/sales/:id/invoice',
    { preHandler: requirePermission('pos.view'), schema: { params: IdParam } },
    async (req) => ctrl.getSaleInvoice({ auth: getAuth(req), id: req.params.id }),
  );
};

export default retailerPosRoutes;
