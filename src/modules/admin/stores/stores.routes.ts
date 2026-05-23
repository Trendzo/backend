import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/shared/auth/middleware.js';
import { db } from '@/db/client.js';
import { bankAccounts } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import * as ctrl from './stores.controller.js';
import { ApproveBody, IdParam, ListQuery, RejectBody } from './stores.validators.js';

const adminStoresRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  app.get(
    '/',
    { schema: { querystring: ListQuery } },
    async (req) => ctrl.listStores({ query: req.query }),
  );

  app.post(
    '/:id/approve',
    { schema: { params: IdParam, body: ApproveBody } },
    async (req) => ctrl.approveStore({ id: req.params.id, body: req.body }),
  );

  app.post(
    '/:id/reject',
    { schema: { params: IdParam, body: RejectBody } },
    async (req) =>
      ctrl.rejectStore({ id: req.params.id, body: req.body, log: req.log }),
  );

  // §18 bank-account picker for payout dialogs.
  app.get(
    '/:id/bank-accounts',
    { schema: { params: IdParam } },
    async (req) => {
      const rows = await db.query.bankAccounts.findMany({
        where: eq(bankAccounts.storeId, req.params.id),
      });
      return ok(
        rows.map((r) => ({
          id: r.id,
          accountNumber: r.accountNumber,
          ifsc: r.ifsc,
          legalName: r.legalName,
          isDefault: r.isDefault,
          verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
        })),
      );
    },
  );
};

export default adminStoresRoutes;
