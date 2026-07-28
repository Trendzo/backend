/**
 * Spin & Win — public with optional auth, like /pricing.
 *
 * A guest can read the wheel and spin it; only claiming needs an account, which is the whole
 * shape of the feature: play now, sign in when there is something to collect.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, getAuthOptional, optionalAuth, requireAuth } from '@/shared/auth/middleware.js';
import * as ctrl from './spin.controller.js';
import { ClaimBody, PlayBody, WheelQuery } from './spin.validators.js';

const spinRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', optionalAuth('consumer'));

  app.get(
    '/wheel',
    { schema: { querystring: WheelQuery } },
    async (req) => ctrl.getWheel({ auth: getAuthOptional(req), query: req.query }),
  );

  app.post(
    '/play',
    { schema: { body: PlayBody } },
    async (req) => ctrl.play({ auth: getAuthOptional(req), body: req.body }),
  );

  /**
   * Claiming is the one authenticated step. `requireAuth` runs as a route-level preHandler
   * on top of the plugin-wide optional hook — it re-verifies the token and applies the
   * account-status checks that `optionalAuth` deliberately skips.
   */
  app.post(
    '/claim',
    { preHandler: requireAuth('consumer'), schema: { body: ClaimBody } },
    async (req) => ctrl.claim({ auth: getAuth(req), body: req.body }),
  );
};

export default spinRoutes;
