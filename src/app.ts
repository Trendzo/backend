import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { LoggerOptions } from 'pino';
import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';
import { fail, ok } from '@/shared/http/envelope.js';
import authRoutes from '@/modules/auth/routes.js';
import retailerRoutes from '@/modules/retailer/routes.js';
import adminRoutes from '@/modules/admin/routes.js';
import catalogRoutes from '@/modules/catalog/routes.js';
import uploadRoutes from '@/modules/uploads/routes.js';
import adminPromotionRoutes from '@/modules/admin/promotions/routes.js';
import adminVoucherRoutes from '@/modules/admin/vouchers/routes.js';
import adminClubbingRoutes from '@/modules/admin/clubbing/routes.js';
import adminLoyaltyRoutes from '@/modules/admin/loyalty/routes.js';
import adminSimulateRoutes from '@/modules/admin/simulate/routes.js';
import retailerPromotionRoutes from '@/modules/retailer/promotions/routes.js';
import adminOrderRoutes from '@/modules/admin/orders/routes.js';
import adminTestConsumerRoutes from '@/modules/admin/consumers/test-consumers.js';
import adminConsumerManagementRoutes from '@/modules/admin/consumers/management.js';
import adminDisputeRoutes from '@/modules/admin/disputes/routes.js';
import retailerDisputeRoutes from '@/modules/retailer/disputes/routes.js';
import retailerOrderRoutes from '@/modules/retailer/orders/routes.js';
import retailerInventoryRoutes from '@/modules/retailer/inventory/routes.js';
import adminReturnsRoutes from '@/modules/admin/returns/routes.js';
import retailerReturnsRoutes from '@/modules/retailer/returns/routes.js';
import authPhase1Routes from '@/modules/auth/phase1/routes.js';
import adminPhase1Routes from '@/modules/admin/phase1-identity/routes.js';
import retailerPhase1Routes from '@/modules/retailer/phase1-identity/routes.js';
import adminOnboardingRoutes from '@/modules/admin/phase2-onboarding/routes.js';
import retailerOnboardingRoutes from '@/modules/retailer/phase2-onboarding/routes.js';
import adminComplianceRoutes from '@/modules/admin/phase3-compliance/routes.js';
import retailerComplianceRoutes from '@/modules/retailer/phase3-compliance/routes.js';
import retailerStoreOpsRoutes from '@/modules/retailer/phase4-store-ops/routes.js';
import adminStoreOpsRoutes from '@/modules/admin/phase4-store-ops/routes.js';
import adminModerationRoutes from '@/modules/admin/phase5-moderation/routes.js';
import adminInventoryRoutes from '@/modules/admin/phase6-inventory/routes.js';
import retailerAiCatalogRoutes from '@/modules/retailer/phase7-ai-catalog/routes.js';
import retailerCatalogRoutes from '@/modules/retailer/phase5-catalog/routes.js';
import retailerInvoicingRoutes from '@/modules/retailer/phase17-invoicing/routes.js';
import retailerSettlementRoutes from '@/modules/retailer/phase18-settlement/routes.js';
import adminSettlementRoutes from '@/modules/admin/phase18-settlement/routes.js';
import adminFeesRoutes from '@/modules/admin/phase12-fees/routes.js';
import retailerFeesRoutes from '@/modules/retailer/phase12-fees/routes.js';
import retailerEarlyDisbursementRoutes from '@/modules/retailer/phase18-early-disbursement/routes.js';
import adminEarlyDisbursementRoutes from '@/modules/admin/phase18-early-disbursement/routes.js';
import adminInvoicingRoutes from '@/modules/admin/phase17-invoicing/routes.js';
import adminWalletRoutes from '@/modules/admin/phase14-wallet/routes.js';
import adminPostPayoutRecoveryRoutes from '@/modules/admin/phase16-recovery/routes.js';
import retailerReportsRoutes from '@/modules/retailer/phase21-reports/routes.js';
import adminReportsRoutes from '@/modules/admin/phase21-reports/routes.js';
import adminCommunityRoutes from '@/modules/admin/phase20-community/routes.js';
import adminPaymentsRoutes from '@/modules/admin/phase15-payments/routes.js';

/**
 * Build a Fastify app with strict TypeScript routing via the Zod type provider.
 * No DB calls in here — keep app composition pure and side-effect free for testability.
 */
export function buildApp() {
  const loggerOptions: LoggerOptions =
    env.NODE_ENV === 'development'
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : { level: env.LOG_LEVEL };

  const app = Fastify({
    logger: loggerOptions,
    trustProxy: env.NODE_ENV === 'production',
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Centralised error handler — translate AppError + Fastify framework errors + unknowns
  // into the envelope. Fastify framework errors (4xx for malformed body, missing headers,
  // payload too large, etc.) carry a `statusCode` we honour rather than burying as 500.
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.httpStatus).send(fail(err.code, err.message, err.details));
      return;
    }
    if ('validation' in err && err.validation) {
      void reply.status(422).send(fail('validation_error', err.message, err.validation));
      return;
    }
    if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
      const code = ('code' in err && typeof err.code === 'string' && err.code) || 'bad_request';
      void reply.status(err.statusCode).send(fail(code.toLowerCase(), err.message));
      return;
    }
    app.log.error({ err }, 'unhandled error');
    void reply.status(500).send(fail('internal_error', 'Internal server error'));
  });

  // CORS:
  // - dev: allow any origin (so the local dashboard on :5173, curl, Postman, etc. all work)
  // - prod: allow only origins explicitly listed in CORS_ORIGIN (comma-separated).
  //   If CORS_ORIGIN is unset in prod, CORS is OFF — same-origin only.
  const corsOrigin = (() => {
    if (env.NODE_ENV !== 'production') return true;
    if (!env.CORS_ORIGIN) return false;
    return env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  })();
  void app.register(cors, { origin: corsOrigin, credentials: true });

  // Multipart parser — only activates on `multipart/form-data` requests, leaves the
  // Zod-validated JSON routes untouched. Cap each upload at 25 MB.
  void app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  });

  // Wrap unknown routes in our envelope (instead of Fastify's default).
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(fail('not_found', `Route ${req.method}:${req.url} not found`));
  });

  // Health check
  app.get('/health', () => ok({ status: 'ok', uptime: process.uptime() }));

  // /api/v1 prefix gets registered here as feature modules come online.
  void app.register(
    async (api) => {
      api.get('/ping', () => ok({ pong: true }));
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(catalogRoutes, { prefix: '/catalog' });
      await api.register(retailerRoutes, { prefix: '/retailer' });
      await api.register(retailerPromotionRoutes, { prefix: '/retailer/promotions' });
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(adminPromotionRoutes, { prefix: '/admin/promotions' });
      await api.register(adminVoucherRoutes, { prefix: '/admin/promotions' });
      await api.register(adminClubbingRoutes, { prefix: '/admin/clubbing-matrix' });
      await api.register(adminLoyaltyRoutes, { prefix: '/admin/loyalty' });
      await api.register(adminSimulateRoutes, { prefix: '/admin' });
      await api.register(adminOrderRoutes, { prefix: '/admin' });
      await api.register(adminTestConsumerRoutes, { prefix: '/admin/consumers' });
      await api.register(adminConsumerManagementRoutes, { prefix: '/admin/consumers' });
      await api.register(adminDisputeRoutes, { prefix: '/admin' });
      await api.register(retailerDisputeRoutes, { prefix: '/retailer' });
      await api.register(retailerOrderRoutes, { prefix: '/retailer/orders' });
      await api.register(retailerInventoryRoutes, { prefix: '/retailer/inventory' });
      await api.register(adminReturnsRoutes, { prefix: '/admin' });
      await api.register(retailerReturnsRoutes, { prefix: '/retailer' });
      await api.register(uploadRoutes, { prefix: '/uploads' });
      // §1 Identity & Access
      await api.register(authPhase1Routes, { prefix: '/auth' });
      await api.register(adminPhase1Routes, { prefix: '/admin' });
      await api.register(retailerPhase1Routes, { prefix: '/retailer' });
      // §2 Retailer Onboarding
      await api.register(adminOnboardingRoutes, { prefix: '/admin' });
      await api.register(retailerOnboardingRoutes, { prefix: '' });
      // §3 KYC & Compliance
      await api.register(adminComplianceRoutes, { prefix: '/admin' });
      await api.register(retailerComplianceRoutes, { prefix: '/retailer' });
      // §4 Store Operations
      await api.register(retailerStoreOpsRoutes, { prefix: '/retailer' });
      await api.register(adminStoreOpsRoutes, { prefix: '/admin' });
      // §5 Catalog Moderation
      await api.register(adminModerationRoutes, { prefix: '/admin' });
      // §6 Inventory
      await api.register(adminInventoryRoutes, { prefix: '/admin' });
      // §5 Catalog — attribute templates
      await api.register(retailerCatalogRoutes, { prefix: '/retailer' });
      // §17 Tax Invoices
      await api.register(retailerInvoicingRoutes, { prefix: '/retailer' });
      // §18 Settlement
      await api.register(retailerSettlementRoutes, { prefix: '/retailer' });
      await api.register(adminSettlementRoutes, { prefix: '/admin' });
      // §12 Fees
      await api.register(adminFeesRoutes, { prefix: '/admin' });
      await api.register(retailerFeesRoutes, { prefix: '/retailer' });
      // §18 Early Disbursement
      await api.register(retailerEarlyDisbursementRoutes, { prefix: '/retailer' });
      await api.register(adminEarlyDisbursementRoutes, { prefix: '/admin' });
      // §17 Admin Invoicing (GST returns + invoice numbering)
      await api.register(adminInvoicingRoutes, { prefix: '/admin' });
      // §14 Wallet Payouts
      await api.register(adminWalletRoutes, { prefix: '/admin' });
      // §16 Post-Payout Recovery
      await api.register(adminPostPayoutRecoveryRoutes, { prefix: '/admin' });
      // §7 AI Catalog
      await api.register(retailerAiCatalogRoutes, { prefix: '/retailer' });
      // §21 Reports
      await api.register(retailerReportsRoutes, { prefix: '/retailer' });
      await api.register(adminReportsRoutes, { prefix: '/admin' });
      // §20 Community moderation
      await api.register(adminCommunityRoutes, { prefix: '/admin' });
      // §15 Payment failures
      await api.register(adminPaymentsRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
