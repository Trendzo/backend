/**
 * Admin routes for Spin & Win.
 *
 * Gated on the existing `promotions.*` permissions rather than a new key: a wheel is a way
 * of handing out promotions, so anyone trusted to create and publish promotions is already
 * trusted to do this, and no permission migration is needed.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './spin-wheel.controller.js';
import {
  CreateWheelBody,
  IdParam,
  PatchWheelBody,
  PlaysQuery,
  SegmentsBody,
} from './spin-wheel.validators.js';

const adminSpinWheelRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/', { preHandler: requirePermission('promotions.view') }, async () => ctrl.listWheels());

  /** Promotions eligible to back a prize slice. Registered before /:id so it is not shadowed. */
  app.get(
    '/prize-candidates',
    { preHandler: requirePermission('promotions.view') },
    async () => ctrl.listPrizeCandidates(),
  );

  app.get(
    '/:id',
    { preHandler: requirePermission('promotions.view'), schema: { params: IdParam } },
    async (req) => ctrl.getWheel(req.params.id),
  );

  app.get(
    '/:id/plays',
    {
      preHandler: requirePermission('promotions.view'),
      schema: { params: IdParam, querystring: PlaysQuery },
    },
    async (req) => ctrl.listPlays({ id: req.params.id, query: req.query }),
  );

  app.post(
    '/',
    { preHandler: requirePermission('promotions.create'), schema: { body: CreateWheelBody } },
    async (req) => ctrl.createWheel({ body: req.body }),
  );

  app.patch(
    '/:id',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { params: IdParam, body: PatchWheelBody },
    },
    async (req) => ctrl.patchWheel({ id: req.params.id, body: req.body }),
  );

  app.put(
    '/:id/segments',
    {
      preHandler: requirePermission('promotions.create'),
      schema: { params: IdParam, body: SegmentsBody },
    },
    async (req) => ctrl.replaceSegments({ id: req.params.id, body: req.body }),
  );

  // Going live and taking it down are publish-level actions, like a promotion's.
  app.post(
    '/:id/activate',
    { preHandler: requirePermission('promotions.publish'), schema: { params: IdParam } },
    async (req) => ctrl.activateWheel(req.params.id),
  );

  app.post(
    '/:id/pause',
    { preHandler: requirePermission('promotions.publish'), schema: { params: IdParam } },
    async (req) => ctrl.pauseWheel(req.params.id),
  );

  app.post(
    '/:id/archive',
    { preHandler: requirePermission('promotions.publish'), schema: { params: IdParam } },
    async (req) => ctrl.archiveWheel(req.params.id),
  );
};

export default adminSpinWheelRoutes;
