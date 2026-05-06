import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '@/shared/errors/app-error.js';
import { verifyAccessToken, type AccessTokenPayload, type TokenKind } from './jwt.js';

/**
 * Augment FastifyRequest so handlers can read the authenticated principal off `req.auth`
 * after the appropriate `requireAuth(...)` preHandler has run. Untouched on public routes.
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessTokenPayload;
  }
}

function extractBearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw AppError.unauthorized('Missing bearer token');
  }
  const token = header.slice(7).trim();
  if (!token) {
    throw AppError.unauthorized('Empty bearer token');
  }
  return token;
}

/**
 * Build a preHandler that decodes the bearer token and asserts its `kind` matches one of
 * `allowedKinds`. The decoded payload is attached to `req.auth`.
 */
export function requireAuth(...allowedKinds: TokenKind[]): preHandlerAsyncHookHandler {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearer(req);
    let payload: AccessTokenPayload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw AppError.unauthorized('Invalid or expired token');
    }
    if (!allowedKinds.includes(payload.kind)) {
      throw AppError.forbidden(`Token kind '${payload.kind}' is not allowed on this route`);
    }
    req.auth = payload;
  };
}

/**
 * Convenience accessor — handlers call this after the preHandler so `req.auth` is guaranteed
 * present. Throws if the route was misconfigured (no preHandler attached).
 */
export function getAuth(req: FastifyRequest): AccessTokenPayload {
  if (!req.auth) {
    throw AppError.internal('getAuth called on a route without requireAuth preHandler');
  }
  return req.auth;
}
