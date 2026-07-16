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
import authRoutes from '@/modules/auth/auth.routes.js';
import retailerProfileRoutes from '@/modules/retailer/profile/profile.routes.js';
import retailerListingsRoutes from '@/modules/retailer/listings/listings.routes.js';
import retailerBrandsRoutes from '@/modules/retailer/brands/brands.routes.js';
import adminRetailersRoutes from '@/modules/admin/retailers/retailers.routes.js';
import adminStoresRoutes from '@/modules/admin/stores/stores.routes.js';
import adminTermsRoutes from '@/modules/admin/terms/terms.routes.js';
import adminCollectionsRoutes from '@/modules/admin/collections/collections.routes.js';
import adminListingsRoutes from '@/modules/admin/listings/listings.routes.js';
import catalogRoutes from '@/modules/catalog/catalog.routes.js';
import uploadRoutes from '@/modules/uploads/uploads.routes.js';
import adminPromotionRoutes from '@/modules/admin/promotions/promotions.routes.js';
import adminVoucherRoutes from '@/modules/admin/vouchers/vouchers.routes.js';
import adminClubbingRoutes from '@/modules/admin/clubbing/clubbing.routes.js';
import adminLoyaltyRoutes from '@/modules/admin/loyalty/loyalty.routes.js';
import adminSimulateRoutes from '@/modules/admin/simulate/simulate.routes.js';
import retailerPromotionRoutes from '@/modules/retailer/promotions/promotions.routes.js';
import adminOrderRoutes from '@/modules/admin/orders/orders.routes.js';
import adminConsumersRoutes from '@/modules/admin/consumers/consumers.routes.js';
import adminDispatchRoutes from '@/modules/admin/dispatch/dispatch.routes.js';
import adminDriversRoutes from '@/modules/admin/drivers/drivers.routes.js';
import adminBrandsRoutes from '@/modules/admin/brands/brands.routes.js';
import adminCategoriesRoutes from '@/modules/admin/categories/categories.routes.js';
import adminPlatformRoutes from '@/modules/admin/platform/platform.routes.js';
import adminDisputeRoutes from '@/modules/admin/disputes/disputes.routes.js';
import retailerDisputeRoutes from '@/modules/retailer/disputes/disputes.routes.js';
import retailerOrderRoutes from '@/modules/retailer/orders/orders.routes.js';
import driverDeliveriesRoutes from '@/modules/driver/deliveries/deliveries.routes.js';
import driverProfileRoutes from '@/modules/driver/profile/profile.routes.js';
import driverLocationRoutes from '@/modules/driver/location/location.routes.js';
import driverEarningsRoutes from '@/modules/driver/earnings/earnings.routes.js';
import driverOffersRoutes from '@/modules/driver/offers/offers.routes.js';
import driverReversePickupsRoutes from '@/modules/driver/reverse-pickups/reverse-pickups.routes.js';
import driverCashRoutes from '@/modules/driver/cash/cash.routes.js';
import razorpayWebhookRoutes from '@/modules/webhooks/razorpay.routes.js';
import retailerInventoryRoutes from '@/modules/retailer/inventory/inventory.routes.js';
import retailerPosRoutes from '@/modules/retailer/pos/pos.routes.js';
import retailerPosStreamRoutes from '@/modules/retailer/pos/pos-stream.routes.js';
import adminReturnsRoutes from '@/modules/admin/returns/returns.routes.js';
import retailerReturnsRoutes from '@/modules/retailer/returns/returns.routes.js';
import authPhase1Routes from '@/modules/auth/access/access.routes.js';
import adminPhase1Routes from '@/modules/admin/access/access.routes.js';
import retailerPhase1Routes from '@/modules/retailer/access/access.routes.js';
import adminOnboardingRoutes from '@/modules/admin/onboarding/onboarding.routes.js';
import retailerOnboardingRoutes from '@/modules/retailer/onboarding/onboarding.routes.js';
import adminComplianceRoutes from '@/modules/admin/compliance/compliance.routes.js';
import retailerComplianceRoutes from '@/modules/retailer/compliance/compliance.routes.js';
import retailerStoreOpsRoutes from '@/modules/retailer/store-ops/store-ops.routes.js';
import adminStoreOpsRoutes from '@/modules/admin/store-ops/store-ops.routes.js';
import adminModerationRoutes from '@/modules/admin/moderation/moderation.routes.js';
import adminInventoryRoutes from '@/modules/admin/inventory/inventory.routes.js';
import retailerAiCatalogRoutes from '@/modules/retailer/ai-catalog/ai-catalog.routes.js';
import retailerAiCatalogBetaRoutes from '@/modules/retailer/ai-catalog-beta/ai-catalog-beta.routes.js';
import retailerCatalogRoutes from '@/modules/retailer/catalog/catalog.routes.js';
import retailerMediaRoutes from '@/modules/retailer/media/media.routes.js';
import retailerInvoicingRoutes from '@/modules/retailer/invoicing/invoicing.routes.js';
import retailerSettlementRoutes from '@/modules/retailer/settlement/settlement.routes.js';
import adminSettlementRoutes from '@/modules/admin/settlement/settlement.routes.js';
import adminFeesRoutes from '@/modules/admin/fees/fees.routes.js';
import retailerFeesRoutes from '@/modules/retailer/fees/fees.routes.js';
import retailerEarlyDisbursementRoutes from '@/modules/retailer/early-disbursement/early-disbursement.routes.js';
import adminEarlyDisbursementRoutes from '@/modules/admin/early-disbursement/early-disbursement.routes.js';
import adminInvoicingRoutes from '@/modules/admin/invoicing/invoicing.routes.js';
import adminWalletRoutes from '@/modules/admin/wallet/wallet.routes.js';
import adminPostPayoutRecoveryRoutes from '@/modules/admin/recovery/recovery.routes.js';
import adminPayoutHoldsRoutes from '@/modules/admin/payout-holds/payout-holds.routes.js';
import adminPayoutAdjustmentsRoutes from '@/modules/admin/payout-adjustments/payout-adjustments.routes.js';
import retailerReportsRoutes from '@/modules/retailer/reports/reports.routes.js';
import adminReportsRoutes from '@/modules/admin/reports/reports.routes.js';
import adminStoreReportsRoutes from '@/modules/admin/store-reports/store-reports.routes.js';
import adminCommunityRoutes from '@/modules/admin/community/community.routes.js';
import adminReelsRoutes from '@/modules/admin/reels/reels.routes.js';
import adminPaymentsRoutes from '@/modules/admin/payments/payments.routes.js';
import adminRetailerMgmtRoutes from '@/modules/admin/retailer-mgmt/retailer-mgmt.routes.js';
import adminStoreMgmtRoutes from '@/modules/admin/store-mgmt/store-mgmt.routes.js';
import adminStaffMgmtRoutes from '@/modules/admin/staff-mgmt/staff-mgmt.routes.js';
import adminStoreCatalogRoutes from '@/modules/admin/store-catalog/store-catalog.routes.js';
import adminStoreListingsRoutes from '@/modules/admin/store-listings/store-listings.routes.js';
import adminStoreVariantsRoutes from '@/modules/admin/store-variants/store-variants.routes.js';
import adminStoreInventoryRoutes from '@/modules/admin/store-inventory/store-inventory.routes.js';
import adminStoreOrdersRoutes from '@/modules/admin/store-orders/store-orders.routes.js';
import adminStoreReturnsRoutes from '@/modules/admin/store-returns/store-returns.routes.js';
import adminStorePromotionsRoutes from '@/modules/admin/store-promotions/store-promotions.routes.js';
import adminOrderGroupRoutes from '@/modules/admin/order-groups/order-groups.routes.js';
import consumerAddressRoutes from '@/modules/consumer/addresses/addresses.routes.js';
import adminIssuesRoutes from '@/modules/admin/issues/issues.routes.js';
import retailerIssuesRoutes from '@/modules/retailer/issues/issues.routes.js';
import consumerIssuesRoutes from '@/modules/consumer/issues/issues.routes.js';
import consumerCommunityRoutes from '@/modules/consumer/community/community.routes.js';
import consumerReelsRoutes from '@/modules/consumer/reels/reels.routes.js';
import consumerEventsRoutes from '@/modules/consumer/events/events.routes.js';
import consumerCheckoutRoutes from '@/modules/consumer/checkout/checkout.routes.js';
import consumerGiftCardRoutes from '@/modules/consumer/gift-cards/gift-cards.routes.js';
import consumerMoodboardRoutes from '@/modules/consumer/moodboards/moodboards.routes.js';
import consumerReferralRoutes from '@/modules/consumer/referrals/referrals.routes.js';
import consumerWalletRoutes from '@/modules/consumer/wallet/wallet.routes.js';
import consumerLoyaltyRoutes from '@/modules/consumer/loyalty/loyalty.routes.js';
import consumerCartRoutes from '@/modules/consumer/cart/cart.routes.js';
import publicAbandonedCartsRoutes from '@/modules/consumer/abandoned-carts/abandoned-carts.routes.js';
import consumerReturnsRoutes from '@/modules/consumer/returns/returns.routes.js';
import publicPromotionRoutes from '@/modules/promotions/public.routes.js';
import pricingRoutes from '@/modules/pricing/pricing.routes.js';
import consumerProfileRoutes from '@/modules/consumer/profile/profile.routes.js';
import publicMoodboardRoutes from '@/modules/consumer/moodboards/public.routes.js';
import adminMoodboardRoutes from '@/modules/admin/moodboards/moodboards.routes.js';
import retailerPushRoutes from '@/modules/retailer/push/push.routes.js';
import adminPushRoutes from '@/modules/admin/push/push.routes.js';
import consumerPushRoutes from '@/modules/consumer/push/push.routes.js';
import adminBannersRoutes from '@/modules/admin/banners/banners.routes.js';
import retailerBannersRoutes from '@/modules/retailer/banners/banners.routes.js';
import adminDigestRoutes from '@/modules/admin/digest/digest.routes.js';
import pincodeRoutes from '@/modules/_shared/pincode/pincode.routes.js';
import publicLegalRoutes from '@/modules/public/legal.routes.js';
import publicLegalApiRoutes from '@/modules/public/legal-api.routes.js';

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
    // Silence Fastify's automatic per-request/response logs (method, url, remote
    // IP, user-agent, response time). Only what we explicitly log is printed —
    // keeps output compact. Errors still surface via the error handler below.
    disableRequestLogging: true,
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

  // CORS: allow ANY origin. `origin: true` reflects the caller's Origin header
  // (works alongside `credentials: true`, which a literal `*` would not).
  // Intentionally permissive — any site may call this API with cookies. If
  // CORS_ORIGIN is set it restricts to that allow-list; otherwise reflect all.
  const corsOrigin = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : true;
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

  // Public pages required for App Store privacy, support, and deletion URLs.
  void app.register(publicLegalRoutes);

  // /api/v1 prefix gets registered here as feature modules come online.
  void app.register(
    async (api) => {
      api.get('/ping', () => ok({ pong: true }));

      // Terminated retailers keep READ access (owners/managers can retrieve
      // orders, invoices, statements after shutdown); every mutating request
      // is rejected centrally inside `requireAuth` — see
      // shared/auth/middleware.ts. No route-level hook needed here.
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(catalogRoutes, { prefix: '/catalog' });
      await api.register(pincodeRoutes, { prefix: '/pincode' });
      await api.register(retailerProfileRoutes, { prefix: '/retailer' });
      await api.register(retailerListingsRoutes, { prefix: '/retailer' });
      await api.register(retailerBrandsRoutes, { prefix: '/retailer/brands' });
      await api.register(retailerPromotionRoutes, { prefix: '/retailer/promotions' });
      await api.register(adminRetailersRoutes, { prefix: '/admin/retailers' });
      await api.register(adminStoresRoutes, { prefix: '/admin/stores' });
      await api.register(adminTermsRoutes, { prefix: '/admin/terms' });
      await api.register(adminCollectionsRoutes, { prefix: '/admin/collections' });
      await api.register(adminListingsRoutes, { prefix: '/admin/listings' });
      await api.register(adminPromotionRoutes, { prefix: '/admin/promotions' });
      await api.register(adminVoucherRoutes, { prefix: '/admin/promotions' });
      await api.register(adminClubbingRoutes, { prefix: '/admin/clubbing-matrix' });
      await api.register(adminLoyaltyRoutes, { prefix: '/admin/loyalty' });
      await api.register(adminSimulateRoutes, { prefix: '/admin' });
      await api.register(adminOrderRoutes, { prefix: '/admin' });
      await api.register(adminConsumersRoutes, { prefix: '/admin/consumers' });
      await api.register(adminDispatchRoutes, { prefix: '/admin/dispatch' });
      await api.register(adminDriversRoutes, { prefix: '/admin/drivers' });
      await api.register(adminBrandsRoutes, { prefix: '/admin/brands' });
      await api.register(adminCategoriesRoutes, { prefix: '/admin/categories' });
      await api.register(adminPlatformRoutes, { prefix: '/admin/platform' });
      await api.register(adminDisputeRoutes, { prefix: '/admin' });
      await api.register(retailerDisputeRoutes, { prefix: '/retailer' });
      await api.register(retailerOrderRoutes, { prefix: '/retailer/orders' });
      await api.register(driverDeliveriesRoutes, { prefix: '/driver/deliveries' });
      await api.register(driverProfileRoutes, { prefix: '/driver/profile' });
      await api.register(driverLocationRoutes, { prefix: '/driver/location' });
      await api.register(driverEarningsRoutes, { prefix: '/driver/earnings' });
      await api.register(driverOffersRoutes, { prefix: '/driver/offers' });
      await api.register(driverReversePickupsRoutes, { prefix: '/driver/reverse-pickups' });
      await api.register(driverCashRoutes, { prefix: '/driver/cash' });
      // Server-to-server, no auth (HMAC-signed by Razorpay). Register the SAME
      // URL in the Razorpay dashboard: <base>/api/v1/webhooks/razorpay
      await api.register(razorpayWebhookRoutes, { prefix: '/webhooks/razorpay' });
      await api.register(retailerInventoryRoutes, { prefix: '/retailer/inventory' });
      await api.register(retailerPosRoutes, { prefix: '/retailer/pos' });
      // Separate plugin: SSE stream authenticates via ?token= (EventSource can't set headers).
      await api.register(retailerPosStreamRoutes, { prefix: '/retailer/pos' });
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
      // Public read-only legal content (latest published T&C / privacy) — no auth.
      await api.register(publicLegalApiRoutes, { prefix: '/legal' });
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
      await api.register(retailerMediaRoutes, { prefix: '/retailer' });
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
      await api.register(adminPayoutHoldsRoutes, { prefix: '/admin' });
      await api.register(adminPayoutAdjustmentsRoutes, { prefix: '/admin' });
      // §7 AI Catalog
      await api.register(retailerAiCatalogRoutes, { prefix: '/retailer' });
      // §7b AI Catalog BETA (product-last flow; coexists with legacy)
      await api.register(retailerAiCatalogBetaRoutes, { prefix: '/retailer' });
      // §21 Reports
      await api.register(retailerReportsRoutes, { prefix: '/retailer' });
      await api.register(adminReportsRoutes, { prefix: '/admin' });
      await api.register(adminStoreReportsRoutes, { prefix: '/admin/stores' });
      // §20 Community moderation
      await api.register(adminCommunityRoutes, { prefix: '/admin' });
      // §15 Payment failures
      await api.register(adminPaymentsRoutes, { prefix: '/admin' });
      // Admin store management (direct retailer/store/staff/catalog CRUD)
      await api.register(adminRetailerMgmtRoutes, { prefix: '/admin/retailers' });
      await api.register(adminStoreMgmtRoutes, { prefix: '/admin/stores' });
      await api.register(adminStaffMgmtRoutes, { prefix: '/admin/retailers' });
      await api.register(adminStoreCatalogRoutes, { prefix: '/admin/stores' });
      await api.register(adminStoreListingsRoutes, { prefix: '/admin/stores' });
      await api.register(adminStoreVariantsRoutes, { prefix: '/admin/stores' });
      await api.register(adminStoreInventoryRoutes, { prefix: '/admin/stores' });
      await api.register(adminStoreOrdersRoutes, { prefix: '/admin/stores' });
      await api.register(adminStoreReturnsRoutes, { prefix: '/admin/stores' });
      await api.register(adminStorePromotionsRoutes, { prefix: '/admin/stores' });
      // Admin order groups
      await api.register(adminOrderGroupRoutes, { prefix: '/admin' });
      // Consumer address book
      await api.register(consumerAddressRoutes, { prefix: '/consumer/addresses' });
      // §19 Customer Issues (unified tickets/queries/disputes)
      await api.register(adminIssuesRoutes, { prefix: '/admin' });
      await api.register(retailerIssuesRoutes, { prefix: '/retailer' });
      await api.register(consumerIssuesRoutes, { prefix: '/consumer/issues' });
      // §20 Consumer Community (posts, reviews, reports)
      await api.register(consumerCommunityRoutes, { prefix: '/consumer/community' });
      // Reels — consumer feed + social layer, and admin reel moderation
      await api.register(consumerReelsRoutes, { prefix: '/consumer/reels' });
      await api.register(adminReelsRoutes, { prefix: '/admin/reels' });
      // §21 Analytics event ingest
      await api.register(consumerEventsRoutes, { prefix: '/consumer/events' });
      // Consumer checkout: quote, place order, order history
      await api.register(consumerCheckoutRoutes, { prefix: '/consumer/checkout' });
      // Consumer gift cards: list + redeem-to-wallet
      await api.register(consumerGiftCardRoutes, { prefix: '/consumer/gift-cards' });
      // Consumer moodboards: owner CRUD + items
      await api.register(consumerMoodboardRoutes, { prefix: '/consumer/moodboards' });
      // Consumer referrals: my code/stats + redeem
      await api.register(consumerReferralRoutes, { prefix: '/consumer/referrals' });
      // Consumer wallet: balance + ledger (read-only)
      await api.register(consumerWalletRoutes, { prefix: '/consumer/wallet' });
      // Consumer loyalty: points balance + ledger (read-only)
      await api.register(consumerLoyaltyRoutes, { prefix: '/consumer/loyalty' });
      // Consumer cart: cross-device sync for logged-in users
      await api.register(consumerCartRoutes, { prefix: '/consumer/cart' });
      await api.register(publicAbandonedCartsRoutes, { prefix: '/public/abandoned-carts' });
      // Consumer returns: open + track post-delivery returns and their refunds
      await api.register(consumerReturnsRoutes, { prefix: '/consumer/returns' });
      // Consumer self-profile (OTP signups fill in name/email here before checkout)
      await api.register(consumerProfileRoutes, { prefix: '/consumer/profile' });
      // Public share read for moodboards (UNAUTHENTICATED — no auth hook)
      await api.register(publicMoodboardRoutes, { prefix: '/public/moodboards' });
      // Public live offers + coupons (UNAUTHENTICATED — drives banners + coupon wallet)
      await api.register(publicPromotionRoutes, { prefix: '/promotions' });
      // Pricing — the single source of truth (optional auth: guest preview or full quote)
      await api.register(pricingRoutes, { prefix: '/pricing' });
      // Admin moodboard moderation (takedown/restore)
      await api.register(adminMoodboardRoutes, { prefix: '/admin/moodboards' });
      // §22 Push subscriptions
      await api.register(retailerPushRoutes, { prefix: '/retailer/push-subscriptions' });
      await api.register(adminPushRoutes, { prefix: '/admin/push-subscriptions' });
      await api.register(consumerPushRoutes, { prefix: '/consumer/push-subscriptions' });
      // §22 Banners
      await api.register(adminBannersRoutes, { prefix: '/admin/banners' });
      await api.register(retailerBannersRoutes, { prefix: '/retailer/banners' });
      // §22 Daily digest
      await api.register(adminDigestRoutes, { prefix: '/admin/digest' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
