/**
 * Admin routes for festival themes.
 *
 * Gated on the same `cms.*` keys as the Home CMS — themes are campaign content run by the
 * same operators, and `ops_admin` (denied `platform_config.edit`) is exactly who runs them.
 * Editing is invisible; publishing is what every phone sees; disable-now is publishing's
 * emergency sibling, so both sit behind `cms.publish`.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './cms-themes.controller.js';
import {
  CloneThemeBody,
  CreateThemeBody,
  PatchThemeBody,
  PublishThemesBody,
  ThemeIdParam,
  ThemePreviewQuery,
  VersionParam,
} from './cms-themes.validators.js';

const adminCmsThemeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ── Reads. Static paths first so `/:id` cannot swallow them. ──

  app.get('/', { preHandler: requirePermission('cms.view') }, async () => ctrl.listThemes());

  app.get(
    '/preview',
    { preHandler: requirePermission('cms.view'), schema: { querystring: ThemePreviewQuery } },
    async (req) => ctrl.preview({ query: req.query }),
  );

  app.get('/publications', { preHandler: requirePermission('cms.view') }, async () =>
    ctrl.listThemePublications(),
  );

  // ── Publish lifecycle. What phones see; stricter permission than editing. ──

  app.post(
    '/publish',
    { preHandler: requirePermission('cms.publish'), schema: { body: PublishThemesBody } },
    async (req) => ctrl.publishThemes({ note: req.body.note, actor: getAuth(req) }),
  );

  app.post(
    '/publications/:version/restore',
    { preHandler: requirePermission('cms.publish'), schema: { params: VersionParam } },
    async (req) => ctrl.restoreThemePublication({ version: req.params.version, actor: getAuth(req) }),
  );

  // ── Draft writes. Invisible to phones until Publish runs. ──

  app.post(
    '/',
    { preHandler: requirePermission('cms.edit'), schema: { body: CreateThemeBody } },
    async (req) => ctrl.createTheme({ body: req.body, actor: getAuth(req) }),
  );

  app.get(
    '/:id',
    { preHandler: requirePermission('cms.view'), schema: { params: ThemeIdParam } },
    async (req) => ctrl.getTheme(req.params.id),
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission('cms.edit'), schema: { params: ThemeIdParam, body: PatchThemeBody } },
    async (req) => ctrl.patchTheme({ id: req.params.id, body: req.body, actor: getAuth(req) }),
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission('cms.edit'), schema: { params: ThemeIdParam } },
    async (req) => ctrl.deleteTheme({ id: req.params.id, actor: getAuth(req) }),
  );

  app.post(
    '/:id/clone',
    { preHandler: requirePermission('cms.edit'), schema: { params: ThemeIdParam, body: CloneThemeBody } },
    async (req) => ctrl.cloneTheme({ id: req.params.id, body: req.body, actor: getAuth(req) }),
  );

  app.post(
    '/:id/disable-now',
    { preHandler: requirePermission('cms.publish'), schema: { params: ThemeIdParam } },
    async (req) => ctrl.disableNow({ id: req.params.id, actor: getAuth(req) }),
  );
};

export default adminCmsThemeRoutes;
