/**
 * Public, UNAUTHENTICATED share read for moodboards. Mounted as its own plugin (no
 * consumer auth hook) so a public board can be opened via a share link without a token.
 * Only returns boards that are isPublic && status='active'.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import * as ctrl from './moodboards.controller.js';
import { IdParam } from './moodboards.validators.js';

const publicMoodboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:id',
    { schema: { params: IdParam } },
    async (req) => ctrl.getPublicBoard({ id: req.params.id }),
  );
};

export default publicMoodboardRoutes;
