/**
 * Admin routes for the Home CMS.
 *
 * Gated on its own `cms.*` keys rather than `platform_config.*` (the convention terms and
 * banners follow) because `ops_admin` is explicitly denied `platform_config.edit`, and ops is
 * exactly who runs campaigns. Publishing is a separate key from editing: editing is invisible,
 * publishing is what every customer sees.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './cms.controller.js';
import {
  AssetsQuery,
  CreateItemBody,
  IdParam,
  PatchItemBody,
  PatchSectionBody,
  PreviewQuery,
  PublishBody,
  ReorderBody,
  SectionKeyParam,
  VersionParam,
} from './cms.validators.js';

const adminCmsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ── Reads. Static paths first so `/sections/:key` cannot swallow them. ──

  app.get('/schema', { preHandler: requirePermission('cms.view') }, async () => ctrl.getSchema());

  app.get(
    '/assets',
    { preHandler: requirePermission('cms.view'), schema: { querystring: AssetsQuery } },
    async (req) => ctrl.listAssets({ query: req.query }),
  );

  app.get(
    '/preview',
    { preHandler: requirePermission('cms.view'), schema: { querystring: PreviewQuery } },
    async (req) => ctrl.preview({ query: req.query }),
  );

  app.get('/publications', { preHandler: requirePermission('cms.view') }, async () =>
    ctrl.listPublications(),
  );

  app.get('/sections', { preHandler: requirePermission('cms.view') }, async () =>
    ctrl.listSections(),
  );

  app.get(
    '/sections/:key',
    { preHandler: requirePermission('cms.view'), schema: { params: SectionKeyParam } },
    async (req) => ctrl.getSection(req.params.key),
  );

  // ── Draft writes. Invisible to customers until Publish runs. ──

  app.patch(
    '/sections/:key',
    {
      preHandler: requirePermission('cms.edit'),
      schema: { params: SectionKeyParam, body: PatchSectionBody },
    },
    async (req) =>
      ctrl.patchSection({ key: req.params.key, body: req.body, actor: getAuth(req) }),
  );

  app.post(
    '/sections/:key/items',
    {
      preHandler: requirePermission('cms.edit'),
      schema: { params: SectionKeyParam, body: CreateItemBody },
    },
    async (req) =>
      ctrl.createItem({ sectionKey: req.params.key, body: req.body, actor: getAuth(req) }),
  );

  app.put(
    '/sections/:key/items/order',
    {
      preHandler: requirePermission('cms.edit'),
      schema: { params: SectionKeyParam, body: ReorderBody },
    },
    async (req) =>
      ctrl.reorderItems({
        sectionKey: req.params.key,
        itemIds: req.body.itemIds,
        actor: getAuth(req),
      }),
  );

  app.patch(
    '/items/:id',
    { preHandler: requirePermission('cms.edit'), schema: { params: IdParam, body: PatchItemBody } },
    async (req) => ctrl.patchItem({ id: req.params.id, body: req.body, actor: getAuth(req) }),
  );

  app.delete(
    '/items/:id',
    { preHandler: requirePermission('cms.edit'), schema: { params: IdParam } },
    async (req) => ctrl.deleteItem({ id: req.params.id, actor: getAuth(req) }),
  );

  // ── Going live. ──

  app.post(
    '/publish',
    { preHandler: requirePermission('cms.publish'), schema: { body: PublishBody } },
    async (req) => ctrl.publish({ ...req.body, actor: getAuth(req) }),
  );

  // Restores the DRAFT from an old snapshot; a normal Publish still has to follow.
  app.post(
    '/publications/:version/restore',
    { preHandler: requirePermission('cms.publish'), schema: { params: VersionParam } },
    async (req) => ctrl.restorePublication({ version: req.params.version, actor: getAuth(req) }),
  );
};

export default adminCmsRoutes;
