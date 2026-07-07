import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { db } from '@/db/client.js';
import { consumers, deliveryAgents, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { verifyAccessToken, type AccessTokenPayload, type TokenKind } from './jwt.js';

/** HTTP methods that never mutate state — allowed for terminated retailers. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    if (payload.kind === 'consumer') {
      const row = await db.query.consumers.findFirst({
        where: eq(consumers.id, payload.sub),
        columns: { status: true },
      });
      if (!row) {
        throw AppError.unauthorized('Account not found');
      }
      if (row.status === 'suspended') {
        throw new AppError(401, ErrorCode.ConsumerSuspended, 'Account is suspended');
      }
      if (row.status === 'closed') {
        throw new AppError(401, ErrorCode.ConsumerClosed, 'Account is closed');
      }
    }
    if (payload.kind === 'driver') {
      const row = await db.query.deliveryAgents.findFirst({
        where: eq(deliveryAgents.id, payload.sub),
        columns: { status: true },
      });
      if (!row) {
        throw AppError.unauthorized('Account not found');
      }
      if (row.status === 'suspended') {
        throw new AppError(401, ErrorCode.DriverSuspended, 'Account is suspended');
      }
      if (row.status === 'inactive') {
        throw new AppError(401, ErrorCode.DriverInactive, 'Account is inactive');
      }
    }
    if (payload.kind === 'retailer') {
      // Terminated retailers retain read-only access so owners/managers can
      // retrieve their records (orders, invoices, statements) after the store
      // is shut down. Any mutating verb is rejected here, centrally, so no
      // individual controller needs its own terminated-check.
      const row = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, payload.sub),
        columns: { status: true, permanentSuspend: true },
      });
      if (!row) {
        throw AppError.unauthorized('Account not found');
      }
      const locked = row.status === 'terminated' || row.permanentSuspend;
      if (locked && !READ_METHODS.has(req.method.toUpperCase())) {
        throw new AppError(
          403,
          ErrorCode.Forbidden,
          'Account is terminated — access is read-only. Contact support to export or restore your data.',
        );
      }
    }
    req.auth = payload;
  };
}

/**
 * Build a preHandler that decodes the bearer token IF one is present and its `kind`
 * matches, attaching it to `req.auth`. Never rejects: a missing/invalid token (or a
 * mismatched kind) simply leaves `req.auth` undefined. For routes that serve both
 * guests and signed-in users (e.g. pricing previews), where auth only enriches the
 * result. Account status checks are skipped here (a degraded token → treated as guest).
 */
export function optionalAuth(...allowedKinds: TokenKind[]): preHandlerAsyncHookHandler {
  return async function maybeAuthenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) return;
    const token = header.slice(7).trim();
    if (!token) return;
    try {
      const payload = verifyAccessToken(token);
      if (allowedKinds.includes(payload.kind)) req.auth = payload;
    } catch {
      // Invalid/expired token → treat as a guest, don't reject.
    }
  };
}

/** Like {@link getAuth} but returns undefined when unauthenticated (optionalAuth routes). */
export function getAuthOptional(req: FastifyRequest): AccessTokenPayload | undefined {
  return req.auth;
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
