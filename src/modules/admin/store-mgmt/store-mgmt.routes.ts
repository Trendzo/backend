import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-mgmt.controller.js';
import {
  AppealMessageBody,
  IdParam,
  OptionalReasonBody,
  PauseBody,
  ReasonBody,
  StoreCreateBody,
  StoreEditBody,
} from './store-mgmt.validators.js';

const adminStoreMgmtRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.post(
    '/direct-create',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { body: StoreCreateBody },
    },
    async (req) =>
      ctrl.directCreateStore({ auth: getAuth(req), body: req.body, requestId: req.id }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('store_management.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getStore({ id: req.params.id }),
  );

  // Suspend/terminate appeal thread (admin side).
  app.get(
    '/:id/appeal',
    { preHandler: requirePermission('store_management.view'), schema: { params: IdParam } },
    async (req) => ctrl.getStoreAppeal({ id: req.params.id }),
  );
  app.post(
    '/:id/appeal',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: AppealMessageBody },
    },
    async (req) => ctrl.postStoreAppeal({ id: req.params.id, auth: getAuth(req), body: req.body }),
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: StoreEditBody },
    },
    async (req) =>
      ctrl.editStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/pause',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: PauseBody },
    },
    async (req) =>
      ctrl.pauseStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/resume',
    {
      preHandler: requirePermission('store_management.edit'),
      schema: { params: IdParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.resumeStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/suspend',
    {
      preHandler: requirePermission('retailer.suspend'),
      schema: { params: IdParam, body: ReasonBody },
    },
    async (req) =>
      ctrl.suspendStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/ban',
    {
      preHandler: requirePermission('retailer.terminate'),
      schema: { params: IdParam, body: ReasonBody },
    },
    async (req) =>
      ctrl.banStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/unsuspend',
    {
      preHandler: requirePermission('retailer.reinstate'),
      schema: { params: IdParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.unsuspendStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/unban',
    {
      preHandler: requirePermission('retailer.reinstate'),
      schema: { params: IdParam, body: OptionalReasonBody },
    },
    async (req) =>
      ctrl.unbanStore({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );
};

export default adminStoreMgmtRoutes;
