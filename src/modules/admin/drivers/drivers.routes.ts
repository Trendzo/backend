/** Admin driver directory + management + COD cash desk. Mounted at /admin/drivers. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './drivers.controller.js';
import {
  DecideDepositBody,
  DepositParams,
  IdParam,
  ListDepositsQuery,
  ListDriversQuery,
} from './drivers.validators.js';

const adminDriversRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    {
      preHandler: requirePermission('drivers.view'),
      schema: { querystring: ListDriversQuery },
    },
    async (req) => ctrl.listDrivers({ query: req.query }),
  );

  // Static before parametric: the cash-deposit ops queue across all drivers.
  app.get(
    '/cash/deposits',
    {
      preHandler: requirePermission('drivers.view'),
      schema: { querystring: ListDepositsQuery },
    },
    async (req) => ctrl.listCashDeposits({ query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('drivers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getDriverDetail({ id: req.params.id }),
  );

  app.post(
    '/:id/cash/deposits/:depositId/confirm',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: DepositParams, body: DecideDepositBody },
    },
    async (req) =>
      ctrl.confirmDeposit({
        auth: getAuth(req),
        id: req.params.id,
        depositId: req.params.depositId,
        body: req.body,
      }),
  );

  app.post(
    '/:id/cash/deposits/:depositId/reject',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: DepositParams, body: DecideDepositBody },
    },
    async (req) =>
      ctrl.rejectDeposit({
        auth: getAuth(req),
        id: req.params.id,
        depositId: req.params.depositId,
        body: req.body,
      }),
  );

  app.post(
    '/:id/suspend',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.suspendDriver({ id: req.params.id }),
  );

  app.post(
    '/:id/activate',
    {
      preHandler: requirePermission('drivers.manage'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.activateDriver({ id: req.params.id }),
  );
};

export default adminDriversRoutes;
