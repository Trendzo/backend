import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { ok } from '@/shared/http/envelope.js';
import {
  createBanner,
  getBannersForAdmin,
  listAdminCreatedBanners,
  revokeBanner,
} from '@/shared/banners/banners.js';

const CreateBody = z.object({
  scope: z.enum(['all_retailers', 'store', 'all_admins']),
  storeId: z.string().optional(),
  severity: z.enum(['info', 'warning', 'critical']).default('info'),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).optional(),
  deepLink: z.string().max(500).optional(),
  dismissible: z.boolean().optional(),
  activeUntil: z.string().datetime().optional(),
});

const IdParam = z.object({ id: z.string() });

const adminBannersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { preHandler: requirePermission('platform_config.view') },
    async (req) => {
      const auth = getAuth(req);
      return ok(await getBannersForAdmin(auth.sub));
    },
  );

  app.get(
    '/all',
    { preHandler: requirePermission('platform_config.view') },
    async () => ok(await listAdminCreatedBanners()),
  );

  app.post(
    '/',
    {
      preHandler: requirePermission('platform_config.edit'),
      schema: { body: CreateBody },
    },
    async (req) => {
      const auth = getAuth(req);
      const id = await createBanner({
        scope: req.body.scope,
        storeId: req.body.storeId,
        severity: req.body.severity,
        title: req.body.title,
        body: req.body.body,
        deepLink: req.body.deepLink,
        dismissible: req.body.dismissible,
        activeUntil: req.body.activeUntil ? new Date(req.body.activeUntil) : undefined,
        createdByAdminId: auth.sub,
      });
      return ok({ id });
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: requirePermission('platform_config.edit'),
      schema: { params: IdParam },
    },
    async (req) => ok({ revoked: await revokeBanner(req.params.id) }),
  );
};

export default adminBannersRoutes;
