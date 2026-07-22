import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import * as ctrl from './store-ops.controller.js';
import {
  DateParam,
  HolidayCreateBody,
  IdParam,
  InboxQuery,
  NotificationPrefsBody,
  OrderAcceptanceBody,
  PickupSlotCreateBody,
  PickupSlotPatchBody,
  StoreHoursBody,
  StorePauseBody,
  UploadDocBody,
} from './store-ops.validators.js';

const retailerStoreOpsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  app.get(
    '/store/hours',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.getHours({ auth: getAuth(req) }),
  );

  app.put(
    '/store/hours',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { body: StoreHoursBody },
    },
    async (req) => ctrl.putHours({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/store/bank',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.getBank({ auth: getAuth(req) }),
  );

  app.get(
    '/store/documents',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.getDocuments({ auth: getAuth(req) }),
  );

  app.post(
    '/store/documents/:id/upload',
    {
      preHandler: requirePermission('kyc.respond'),
      schema: { params: IdParam, body: UploadDocBody },
    },
    async (req) =>
      ctrl.uploadDocument({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.get(
    '/store/holiday-closures',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.listHolidayClosures({ auth: getAuth(req) }),
  );

  app.post(
    '/store/holiday-closures',
    {
      preHandler: requirePermission('store.holidays_edit'),
      schema: { body: HolidayCreateBody },
    },
    async (req) =>
      ctrl.createHolidayClosure({ auth: getAuth(req), body: req.body }),
  );

  app.delete(
    '/store/holiday-closures/:date',
    {
      preHandler: requirePermission('store.holidays_edit'),
      schema: { params: DateParam },
    },
    async (req) =>
      ctrl.deleteHolidayClosure({ auth: getAuth(req), date: req.params.date }),
  );

  app.get(
    '/store/order-acceptance',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.getOrderAcceptance({ auth: getAuth(req) }),
  );

  app.put(
    '/store/order-acceptance',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { body: OrderAcceptanceBody },
    },
    async (req) =>
      ctrl.setOrderAcceptance({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/store/pause',
    {
      preHandler: requirePermission('store.pause'),
      schema: { body: StorePauseBody },
    },
    async (req) =>
      ctrl.pauseStore({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.post(
    '/store/resume',
    { preHandler: requirePermission('store.resume') },
    async (req) =>
      ctrl.resumeStore({ auth: getAuth(req), requestId: req.id }),
  );

  app.get('/notification-prefs', async (req) =>
    ctrl.getNotificationPrefs({ auth: getAuth(req) }),
  );

  app.put(
    '/notification-prefs',
    { schema: { body: NotificationPrefsBody } },
    async (req) =>
      ctrl.putNotificationPrefs({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/inbox',
    { schema: { querystring: InboxQuery } },
    async (req) => ctrl.listInbox({ auth: getAuth(req), query: req.query }),
  );

  app.post(
    '/inbox/:id/read',
    { schema: { params: IdParam } },
    async (req) =>
      ctrl.markInboxRead({ auth: getAuth(req), id: req.params.id }),
  );

  app.post('/inbox/read-all', async (req) =>
    ctrl.markAllRead({ auth: getAuth(req) }),
  );

  app.get(
    '/store/pickup-slots',
    { preHandler: requirePermission('store.view_profile') },
    async (req) => ctrl.listPickupSlots({ auth: getAuth(req) }),
  );

  app.post(
    '/store/pickup-slots',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { body: PickupSlotCreateBody },
    },
    async (req) =>
      ctrl.createPickupSlot({
        auth: getAuth(req),
        body: req.body,
        requestId: req.id,
      }),
  );

  app.patch(
    '/store/pickup-slots/:id',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { params: IdParam, body: PickupSlotPatchBody },
    },
    async (req) =>
      ctrl.patchPickupSlot({
        auth: getAuth(req),
        id: req.params.id,
        body: req.body,
      }),
  );

  app.delete(
    '/store/pickup-slots/:id',
    {
      preHandler: requirePermission('store.edit_profile'),
      schema: { params: IdParam },
    },
    async (req) =>
      ctrl.deletePickupSlot({ auth: getAuth(req), id: req.params.id }),
  );

  app.get('/inbox/unread-count', async (req) =>
    ctrl.getInboxUnreadCount({ auth: getAuth(req) }),
  );
};

export default retailerStoreOpsRoutes;
