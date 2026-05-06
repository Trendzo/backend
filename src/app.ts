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
      await api.register(uploadRoutes, { prefix: '/uploads' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
