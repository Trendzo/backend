import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './uploads.controller.js';

const uploadRoutes: FastifyPluginAsync = async (app) => {
  // Any signed-in identity may upload. This route was unauthenticated until the S3
  // migration — against our own bucket that is an open write endpoint, and the rich-text
  // sanitizer treats the resulting URLs as trusted, so it has to be gated.
  app.post('/', { preHandler: requireAuth('admin', 'retailer', 'consumer', 'driver') }, async (req) =>
    ctrl.uploadMedia(req),
  );
  // OTP-verified applicants can upload review photos before their retailer account exists.
  // The dedicated route keeps their token away from the general upload endpoint.
  app.post('/onboarding', { preHandler: requireAuth('onboarding') }, async (req) =>
    ctrl.uploadOnboardingDocument(req),
  );
};

export default uploadRoutes;
