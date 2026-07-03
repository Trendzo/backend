import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { db } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/**
 * Server-side enforcement of the per-retailer POS opt-in. Must run AFTER
 * `requireAuth('retailer')` (reads `req.auth`). Resolves the caller's store and rejects with
 * 403 unless `retailer_stores.pos_billing_enabled` is true — so a retailer whose POS is
 * disabled cannot reach any POS endpoint regardless of UI state, sub-role permissions, or a
 * deep-linked/bookmarked client. This is the authoritative gate; nav hiding + the client-side
 * PosGate are convenience only.
 */
export function requirePosBillingEnabled(): preHandlerAsyncHookHandler {
  return async function posBillingGate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(
        500,
        ErrorCode.InternalError,
        'requirePosBillingEnabled called without requireAuth preHandler',
      );
    }
    const account = await db.query.retailerAccounts.findFirst({
      where: eq(retailerAccounts.id, auth.sub),
    });
    if (!account?.storeId) {
      throw AppError.forbidden('POS billing is not enabled for this store');
    }
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, account.storeId),
    });
    if (!store?.posBillingEnabled) {
      throw AppError.forbidden('POS billing is not enabled for this store');
    }
  };
}
