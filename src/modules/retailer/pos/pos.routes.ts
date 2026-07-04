import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { requirePermission } from '@/shared/permissions.js';
import { requirePosBillingEnabled } from '@/shared/pos/require-pos-billing.js';
import * as ctrl from './pos.controller.js';
import {
  CreateSaleBody,
  CustomersQuery,
  HoldSaleBody,
  IdParam,
  ListSalesQuery,
  LookupQuery,
  PrinterConfigBody,
  PrintSaleBody,
  QuoteBody,
  ReceiptQuery,
  ResolveScanQuery,
  ReturnSaleBody,
  ScanBody,
  SummaryQuery,
  VoidSaleBody,
} from './pos.validators.js';

const retailerPosRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));
  // Per-retailer POS opt-in — runs after auth (needs req.auth) and before every route's
  // permission gate. Blocks all POS endpoints with 403 when the store's POS is disabled.
  app.addHook('preHandler', requirePosBillingEnabled());

  app.get(
    '/lookup',
    { preHandler: requirePermission('pos.sell'), schema: { querystring: LookupQuery } },
    async (req) => ctrl.lookup({ auth: getAuth(req), query: req.query }),
  );

  app.post(
    '/quote',
    { preHandler: requirePermission('pos.sell'), schema: { body: QuoteBody } },
    async (req) => ctrl.quote({ auth: getAuth(req), body: req.body }),
  );

  // ── QR scan → register (mobile app scans; web register receives over SSE) ──
  app.get(
    '/scan/resolve',
    { preHandler: requirePermission('pos.sell'), schema: { querystring: ResolveScanQuery } },
    async (req) => ctrl.resolveScan({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/registers',
    { preHandler: requirePermission('pos.sell') },
    async (req) => ctrl.listRegisters({ auth: getAuth(req) }),
  );

  app.post(
    '/scan',
    { preHandler: requirePermission('pos.sell'), schema: { body: ScanBody } },
    async (req) => ctrl.pushScan({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales',
    { preHandler: requirePermission('pos.sell'), schema: { body: CreateSaleBody } },
    async (req) => ctrl.createSale({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales/hold',
    { preHandler: requirePermission('pos.sell'), schema: { body: HoldSaleBody } },
    async (req) => ctrl.holdSale({ auth: getAuth(req), body: req.body }),
  );

  app.post(
    '/sales/:id/void',
    { preHandler: requirePermission('pos.refund'), schema: { params: IdParam, body: VoidSaleBody } },
    async (req) => ctrl.voidSale({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/sales/:id/returns',
    { preHandler: requirePermission('pos.refund'), schema: { params: IdParam, body: ReturnSaleBody } },
    async (req) => ctrl.returnSale({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.get(
    '/sales',
    { preHandler: requirePermission('pos.view'), schema: { querystring: ListSalesQuery } },
    async (req) => ctrl.listSales({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/held',
    { preHandler: requirePermission('pos.sell') },
    async (req) => ctrl.listHeld({ auth: getAuth(req) }),
  );

  app.get(
    '/customers',
    { preHandler: requirePermission('pos.sell'), schema: { querystring: CustomersQuery } },
    async (req) => ctrl.listCustomers({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/summary',
    { preHandler: requirePermission('pos.view'), schema: { querystring: SummaryQuery } },
    async (req) => ctrl.daySummary({ auth: getAuth(req), query: req.query }),
  );

  app.get(
    '/sales/:id',
    { preHandler: requirePermission('pos.view'), schema: { params: IdParam } },
    async (req) => ctrl.getSale({ auth: getAuth(req), id: req.params.id }),
  );

  app.get(
    '/sales/:id/invoice',
    { preHandler: requirePermission('pos.view'), schema: { params: IdParam } },
    async (req) => ctrl.getSaleInvoice({ auth: getAuth(req), id: req.params.id }),
  );

  // ── printer / cash-drawer configuration + actions ──
  app.get(
    '/printer-config',
    { preHandler: requirePermission('pos.settings') },
    async (req) => ctrl.getPrinter({ auth: getAuth(req) }),
  );

  app.put(
    '/printer-config',
    { preHandler: requirePermission('pos.settings'), schema: { body: PrinterConfigBody } },
    async (req) => ctrl.putPrinter({ auth: getAuth(req), body: req.body }),
  );

  app.get(
    '/sales/:id/receipt',
    { preHandler: requirePermission('pos.view'), schema: { params: IdParam, querystring: ReceiptQuery } },
    async (req) => ctrl.getReceipt({ auth: getAuth(req), id: req.params.id, query: req.query }),
  );

  app.post(
    '/sales/:id/print',
    { preHandler: requirePermission('pos.sell'), schema: { params: IdParam, body: PrintSaleBody } },
    async (req) => ctrl.printSale({ auth: getAuth(req), id: req.params.id, body: req.body }),
  );

  app.post(
    '/open-drawer',
    { preHandler: requirePermission('pos.sell') },
    async (req) => ctrl.openDrawer({ auth: getAuth(req) }),
  );
};

export default retailerPosRoutes;
