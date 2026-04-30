import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { LoggerOptions } from 'pino';
import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';
import { fail, ok } from '@/shared/http/envelope.js';

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

  // Centralised error handler — translate AppError + unknowns into the envelope.
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.httpStatus).send(fail(err.code, err.message, err.details));
      return;
    }
    if ('validation' in err && err.validation) {
      void reply.status(422).send(fail('validation_error', err.message, err.validation));
      return;
    }
    app.log.error({ err }, 'unhandled error');
    void reply.status(500).send(fail('internal_error', 'Internal server error'));
  });

  // CORS — tighten in production via env-driven origins.
  void app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
  });

  // Wrap unknown routes in our envelope (instead of Fastify's default).
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(fail('not_found', `Route ${req.method}:${req.url} not found`));
  });

  // Health check
  app.get('/health', () => ok({ status: 'ok', uptime: process.uptime() }));

  // /api/v1 prefix gets registered here as feature modules come online.
  void app.register(
    (api, _opts, done) => {
      api.get('/ping', () => ok({ pong: true }));
      // Phase 2+ routes mount here: api.register(authRoutes), api.register(catalogRoutes), …
      done();
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
