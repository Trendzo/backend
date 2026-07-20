import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './uploads.controller.js';

const uploadRoutes: FastifyPluginAsync = async (app) => {
  // Any signed-in identity may upload. This route was unauthenticated until the S3
  // migration — against our own bucket that is an open write endpoint, and the rich-text
  // sanitizer treats the resulting URLs as trusted, so it has to be gated.
  app.addHook('preHandler', requireAuth('admin', 'retailer', 'consumer', 'driver'));

  app.post('/', async (req) => ctrl.uploadMedia(req));
};

export default uploadRoutes;
