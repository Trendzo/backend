import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import * as ctrl from './consumer-tryon.controller.js';
import { ConsumerTryOnBody } from './consumer-tryon.validators.js';

/**
 * Consumer virtual try-on (Vertex `virtual-try-on-001`). Person photo + a
 * garment image the user picked from the product's own images.
 *
 * On a provider failure — notably 429 RESOURCE_EXHAUSTED when the Vertex tier is
 * saturated under load — we log the EXACT provider error server-side (for us)
 * and return a friendly, retryable message to the app (for the user). Client
 * errors (bad garment, missing product) pass through with their own message.
 */
const consumerTryOnRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('consumer'));

  app.post('/', { schema: { body: ConsumerTryOnBody } }, async (req) => {
    try {
      return await ctrl.tryOn({ auth: getAuth(req), body: req.body });
    } catch (err) {
      // Client-side (4xx) errors carry a user-meaningful message already.
      if (err instanceof AppError && err.httpStatus < 500) throw err;

      const raw = err instanceof Error ? err.message : String(err);
      req.log.error(
        { provider: 'vertex', model: 'virtual-try-on-001', error: raw },
        'consumer try-on failed',
      );

      if (/\b429\b|RESOURCE_EXHAUSTED/i.test(raw)) {
        throw new AppError(
          503,
          ErrorCode.RateLimited,
          'Try-on is busy right now — please try again in a moment.',
        );
      }
      throw new AppError(502, ErrorCode.InternalError, 'Try-on failed — please try again.');
    }
  });
};

export default consumerTryOnRoutes;
