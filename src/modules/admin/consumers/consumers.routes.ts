import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './consumers.controller.js';
import {
  CloseBody,
  CreateBanBody,
  CreateConsumerBody,
  CreateFlagBody,
  FlagsQuery,
  IdBanParam,
  IdFlagParam,
  IdParam,
  LiftBanBody,
  ListBansQuery,
  ListQuery,
  MintTestBody,
  ResolveFlagBody,
  SuspendBody,
  UnsuspendBody,
} from './consumers.validators.js';

const adminConsumersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { querystring: ListQuery },
    },
    async (req) => ctrl.listConsumers({ query: req.query }),
  );

  app.get(
    '/:id',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getConsumer({ id: req.params.id }),
  );

  app.get(
    '/:id/profile',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getConsumerProfile({ id: req.params.id }),
  );

  app.get(
    '/:id/addresses',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getConsumerAddresses({ id: req.params.id }),
  );

  app.post(
    '/:id/suspend',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdParam, body: SuspendBody },
    },
    async (req) =>
      ctrl.suspendConsumer({ id: req.params.id, body: req.body, log: req.log }),
  );

  app.post(
    '/:id/unsuspend',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdParam, body: UnsuspendBody },
    },
    async (req) =>
      ctrl.unsuspendConsumer({ id: req.params.id, body: req.body, log: req.log }),
  );

  app.post(
    '/:id/close',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdParam, body: CloseBody },
    },
    async (req) =>
      ctrl.closeConsumer({
        id: req.params.id,
        body: req.body,
        log: req.log,
        auth: getAuth(req),
      }),
  );

  app.get(
    '/:id/gift-cards',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam },
    },
    async (req) => ctrl.getConsumerGiftCards({ id: req.params.id }),
  );

  app.get(
    '/:id/flags',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam, querystring: FlagsQuery },
    },
    async (req) => ctrl.listFlags({ id: req.params.id, query: req.query }),
  );

  app.post(
    '/:id/flags',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdParam, body: CreateFlagBody },
    },
    async (req) =>
      ctrl.createFlag({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/flags/:flagId/resolve',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdFlagParam, body: ResolveFlagBody },
    },
    async (req) =>
      ctrl.resolveFlag({
        auth: getAuth(req),
        id: req.params.id,
        flagId: req.params.flagId,
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/:id/bans',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdParam, body: CreateBanBody },
    },
    async (req) => ctrl.createBan({ id: req.params.id, body: req.body, auth: getAuth(req) }),
  );

  app.post(
    '/:id/bans/:banId/lift',
    {
      preHandler: requirePermission('consumers.suspend'),
      schema: { params: IdBanParam, body: LiftBanBody },
    },
    async (req) =>
      ctrl.liftBanCtrl({
        id: req.params.id,
        banId: req.params.banId,
        body: req.body,
        auth: getAuth(req),
      }),
  );

  app.get(
    '/:id/bans',
    {
      preHandler: requirePermission('consumers.view'),
      schema: { params: IdParam, querystring: ListBansQuery },
    },
    async (req) => ctrl.listConsumerBans({ id: req.params.id, query: req.query }),
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('consumers.create'),
      schema: { body: CreateConsumerBody },
    },
    async (req) =>
      ctrl.createConsumer({ body: req.body, auth: getAuth(req), requestId: req.id }),
  );

  app.post(
    '/test',
    {
      preHandler: requirePermission('simulate.run'),
      schema: { body: MintTestBody },
    },
    async (req) => ctrl.mintTestConsumer({ body: req.body }),
  );
};

export default adminConsumersRoutes;
