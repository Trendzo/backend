import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

// Community posts and product reviews tables are not yet in the schema.
// These endpoints return empty queues until the community/reviews schema is added.
const adminCommunityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get('/community-moderation', async () => ok([]));
  app.get('/reviews-moderation', async () => ok([]));
};

export default adminCommunityRoutes;
