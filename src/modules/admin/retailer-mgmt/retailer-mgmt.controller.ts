/**
 * Admin retailer-management: create, edit, ban, unban (admin acting on behalf).
 */
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  bankAccounts,
  changeRequests,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  OptionalReasonBody,
  PosBillingBody,
  ReasonBody,
  RetailerCreateBody,
  RetailerEditBody,
} from './retailer-mgmt.validators.js';

type Auth = AccessTokenPayload;

async function loadRetailerOr404(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  return retailer;
}

export async function createRetailer(input: {
  auth: Auth;
  body: z.infer<typeof RetailerCreateBody>;
  requestId: string;
}) {
  const { auth, body } = input;

  const existing = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, body.ownerEmail),
  });
  if (existing) {
    throw new AppError(409, ErrorCode.InvalidState, 'An account with this email already exists');
  }

  const retailerId = newId(IdPrefix.Retailer);
  const storeId = newId(IdPrefix.Store);
  const passwordHash = await hashPassword(body.password);

  await db.transaction(async (tx) => {
    await tx.insert(retailerStores).values({
      id: storeId,
      legalEntityId: retailerId,
      legalName: body.store.storeName,
      gstin: body.gstin,
      pan: body.pan ?? null,
      address: body.store.address,
      stateCode: body.store.stateCode,
      lat: body.store.lat,
      lng: body.store.lng,
      openingHours: body.store.openingHours ?? null,
      status: 'active',
      platformFeeBp: body.store.platformFeeBp,
      payoutCadenceDays: body.store.payoutCadenceDays,
    });

    await tx.insert(retailerAccounts).values({
      id: retailerId,
      storeId,
      email: body.ownerEmail,
      passwordHash,
      legalName: body.legalName,
      phone: body.ownerPhone,
      gstin: body.gstin,
      subRole: 'owner',
      status: 'active',
    });

    if (body.bank) {
      await tx.insert(bankAccounts).values({
        id: newId(IdPrefix.BankAccount),
        storeId,
        accountNumber: body.bank.accountNumber,
        ifsc: body.bank.ifsc,
        legalName: body.bank.legalName,
        isDefault: true,
      });
    }
  });

  await recordAudit({
    actor: auth,
    action: 'retailer.create',
    resourceKind: 'retailer_account',
    resourceId: retailerId,
    after: { email: body.ownerEmail, storeId, storeName: body.store.storeName },
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: retailerId,
    kind: 'system',
    title: 'Welcome to ClosetX',
    body: `Your account was provisioned by ClosetX admin. Sign in with ${body.ownerEmail}.`,
    deepLink: '/retailer/dashboard',
  });

  return ok({
    retailerId,
    storeId,
    email: body.ownerEmail,
    message: 'Retailer + store provisioned. Credentials emailed (logged in dev).',
  });
}

export async function getRetailer(input: { id: string }) {
  const retailer = await loadRetailerOr404(input.id);
  const { passwordHash: _ph, ...safe } = retailer;

  // Surface the store's POS-billing state + whether the retailer has an open activation
  // request, so the admin retailer-detail page can render the toggle without a second call.
  let posBillingEnabled = false;
  let posActivationPending = false;
  if (retailer.storeId) {
    const store = await db.query.retailerStores.findFirst({
      where: eq(retailerStores.id, retailer.storeId),
    });
    posBillingEnabled = store?.posBillingEnabled ?? false;
    const pending = await db.query.changeRequests.findFirst({
      where: and(
        eq(changeRequests.storeId, retailer.storeId),
        eq(changeRequests.field, 'pos_billing_activation'),
        eq(changeRequests.status, 'pending'),
      ),
    });
    posActivationPending = Boolean(pending);
  }

  return ok({ ...safe, posBillingEnabled, posActivationPending });
}

/**
 * Admin flips a store's POS-billing opt-in on/off. Mirrors `setRetailerFeeOverride`
 * (admin/fees): resolve retailer→store, update the column, audit, best-effort notify the
 * store's accounts. Enabling also auto-resolves any open `pos_billing_activation` request so
 * the change-request queue doesn't keep a now-moot pending item (see plan Phase 2 race).
 */
export async function setPosBilling(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PosBillingBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const retailer = await loadRetailerOr404(input.id);
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no store yet');
  }
  const storeId = retailer.storeId;

  const priorStore = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
  });
  const priorEnabled = priorStore?.posBillingEnabled ?? false;

  await db.transaction(async (tx) => {
    await tx
      .update(retailerStores)
      .set({ posBillingEnabled: body.enabled })
      .where(eq(retailerStores.id, storeId));
    if (body.enabled) {
      // Close any open activation request — enabling directly satisfies it.
      await tx
        .update(changeRequests)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionNote: 'Auto-approved: admin enabled POS billing directly.',
        })
        .where(
          and(
            eq(changeRequests.storeId, storeId),
            eq(changeRequests.field, 'pos_billing_activation'),
            eq(changeRequests.status, 'pending'),
          ),
        );
    }
  });

  await recordAudit({
    actor: auth,
    action: 'store.pos_billing_toggle',
    resourceKind: 'retailer_store',
    resourceId: storeId,
    before: { posBillingEnabled: priorEnabled },
    after: { posBillingEnabled: body.enabled },
    note: body.reason ?? null,
    requestId,
  });

  // Best-effort retailer notification — failure must not block the admin action.
  await notifyStoreAccounts({
    storeId,
    kind: 'system',
    title: body.enabled ? 'POS billing enabled' : 'POS billing disabled',
    body: body.enabled
      ? 'The offline POS / counter-billing surface is now available in your dashboard.'
      : `POS billing was turned off for your store.${body.reason ? ` Reason: ${body.reason}` : ''}`,
    deepLink: body.enabled ? '/retailer/pos' : '/retailer/store/status',
  }).catch(() => undefined);

  return ok({ storeId, posBillingEnabled: body.enabled });
}

export async function editRetailer(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof RetailerEditBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.id);
  const before = {
    legalName: retailer.legalName,
    phone: retailer.phone,
    gstin: retailer.gstin,
  };
  const [updated] = await db
    .update(retailerAccounts)
    .set(compact(input.body))
    .where(eq(retailerAccounts.id, retailer.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'retailer.update',
    resourceKind: 'retailer_account',
    resourceId: retailer.id,
    before,
    after: compact(input.body) as Record<string, unknown>,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: retailer.id,
    kind: 'system',
    title: 'Account profile updated by admin',
    body: 'An admin updated your account details. Review your profile.',
    deepLink: '/retailer/store',
  });
  const { passwordHash: _ph, ...safe } = updated!;
  return ok(safe);
}

export async function banRetailer(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof ReasonBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.id);
  if (retailer.permanentSuspend) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer is already banned');
  }
  const before = { status: retailer.status, permanentSuspend: retailer.permanentSuspend };
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(retailerAccounts)
      .set({
        status: 'terminated',
        permanentSuspend: true,
        suspendReason: input.body.reason,
        suspendedAt: now,
        suspendedByAccountId: input.auth.sub,
      })
      .where(eq(retailerAccounts.id, retailer.id));
    if (retailer.storeId) {
      await tx
        .update(retailerStores)
        .set({
          status: 'suspended',
          permanentSuspend: true,
          suspendReason: input.body.reason,
          suspendedAt: now,
          suspendedByAccountId: input.auth.sub,
        })
        .where(eq(retailerStores.id, retailer.storeId));
    }
  });
  await recordAudit({
    actor: input.auth,
    action: 'retailer.ban',
    resourceKind: 'retailer_account',
    resourceId: retailer.id,
    before,
    after: { status: 'terminated', permanentSuspend: true },
    note: input.body.reason,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: retailer.id,
    kind: 'system',
    title: 'Account banned',
    body: `Your ClosetX account has been permanently banned. Reason: ${input.body.reason}`,
  });
  return ok({ id: retailer.id, banned: true });
}

export async function unbanRetailer(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.id);
  if (!retailer.permanentSuspend) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer is not banned');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(retailerAccounts)
      .set({
        status: 'active',
        permanentSuspend: false,
        suspendReason: null,
        suspendedAt: null,
        suspendedByAccountId: null,
      })
      .where(eq(retailerAccounts.id, retailer.id));
    if (retailer.storeId) {
      await tx
        .update(retailerStores)
        .set({
          status: 'active',
          permanentSuspend: false,
          suspendReason: null,
          suspendedAt: null,
          suspendedByAccountId: null,
        })
        .where(eq(retailerStores.id, retailer.storeId));
    }
  });
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'retailer.unban',
    resourceKind: 'retailer_account',
    resourceId: retailer.id,
    after: { status: 'active', permanentSuspend: false },
    note: body.reason ?? null,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: retailer.id,
    kind: 'system',
    title: 'Account reinstated',
    body: 'Your ClosetX account ban has been lifted. You can sign in again.',
    deepLink: '/retailer/dashboard',
  });
  return ok({ id: retailer.id, banned: false });
}
