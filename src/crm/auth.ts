import { eq } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { db } from '@/db/client.js';
import { adminAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { crm } from './db/client.js';
import type { CrmActor } from './store.js';

/**
 * Authentication for the CRM's two principals.
 *
 * SALES (`kind: 'crm'`) — a field salesperson. Account lives in the CRM's MongoDB, signs in
 * with phone OTP. Status is checked here, not in the shared `requireAuth`, because that
 * middleware only knows how to look up Postgres-backed identities.
 *
 * ADMIN (`kind: 'admin'`) — a platform admin, reusing the EXISTING Postgres `admin_accounts`
 * and the existing `/auth/admin/login`. This is the one and only thing the CRM shares with
 * the web portal: the same admin signs into both without a second set of credentials. No CRM
 * business data crosses the boundary in either direction.
 */

/** Resolve the sales user behind a `kind: 'crm'` token, enforcing the active flag. */
export async function resolveSalesActor(req: FastifyRequest): Promise<CrmActor> {
  const payload = getAuth(req);
  if (payload.kind !== 'crm') {
    throw AppError.forbidden('This route requires a sales sign-in');
  }
  const users = await crm.users();
  const user = await users.findOne({ _id: payload.sub });
  if (!user) {
    throw AppError.unauthorized('Account not found');
  }
  if (!user.active) {
    throw new AppError(401, ErrorCode.Forbidden, 'Your access has been deactivated');
  }
  // Revocation check: an admin resetting access (or deactivating and re-enabling) bumps
  // `tokenVersion`, which strands every token minted before that moment.
  if ((payload.ver ?? 0) !== (user.tokenVersion ?? 0)) {
    throw AppError.unauthorized('Your session has ended. Please sign in again.');
  }
  if (user.role === 'admin') {
    // A CRM row flagged 'admin' is a data error — platform admins authenticate through
    // Postgres, never through the sales OTP path.
    throw AppError.forbidden('Use the admin sign-in for this account');
  }
  return {
    kind: 'sales',
    id: user._id,
    name: user.name,
    role: user.role,
    managerId: user.managerId,
  };
}

/** Resolve the platform admin behind a `kind: 'admin'` token. */
export async function resolveAdminActor(req: FastifyRequest): Promise<CrmActor> {
  const payload = getAuth(req);
  if (payload.kind !== 'admin') {
    throw AppError.forbidden('This route requires an admin sign-in');
  }
  const admin = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, payload.sub),
    columns: { id: true, email: true, status: true },
  });
  if (!admin) {
    throw AppError.unauthorized('Account not found');
  }
  if (admin.status !== 'active') {
    throw new AppError(403, ErrorCode.Forbidden, 'Admin account is revoked');
  }
  return { kind: 'admin', id: admin.id, name: admin.email };
}

/**
 * Resolve whichever principal is on the request. Used by the endpoints both sides share
 * (lead detail, the actions endpoint, document download) so one handler serves both without
 * duplicating logic — scoping inside `visibleUserIds` is what keeps a sales rep from seeing
 * another rep's book.
 */
export async function resolveActor(req: FastifyRequest): Promise<CrmActor> {
  const payload = getAuth(req);
  return payload.kind === 'admin' ? resolveAdminActor(req) : resolveSalesActor(req);
}

/** Sales-only routes (the field app). */
export const requireSalesAuth: preHandlerAsyncHookHandler = requireAuth('crm');

/** Admin-only routes (the CRM's manager console). */
export const requireCrmAdminAuth: preHandlerAsyncHookHandler = requireAuth('admin');

/** Routes both principals may call. */
export const requireAnyCrmAuth: preHandlerAsyncHookHandler = requireAuth('crm', 'admin');
