import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  passwordResetTokens,
  retailerAccounts,
  retailerStaffInvites,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { generateTempPassword, hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { effectivePermissions } from '@/shared/permissions.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateStaffBody,
  InviteStaffBody,
  PatchStaffBody,
} from './access.validators.js';

type Auth = AccessTokenPayload;

async function loadRetailerWithStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw AppError.unauthorized('Retailer account not found');
  if (!retailer.storeId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found — create one first');
  }
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return { retailer, store };
}

export async function getMyPermissions(input: { auth: Auth }) {
  if (!input.auth.subRole) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer token missing subRole');
  }
  const perms = await effectivePermissions('retailer', input.auth.subRole);
  return ok({ scope: 'retailer', subRole: input.auth.subRole, permissions: perms });
}

export async function listStaff(input: { auth: Auth }) {
  const { store } = await loadRetailerWithStore(input.auth.sub);
  const staff = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, store.id),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  const safe = staff.map(({ passwordHash: _ph, ...rest }) => rest);
  return ok(safe);
}

export async function getStaff(input: { auth: Auth; id: string }) {
  const { store } = await loadRetailerWithStore(input.auth.sub);
  const member = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, input.id),
      eq(retailerAccounts.storeId, store.id),
    ),
  });
  if (!member) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
  const { passwordHash: _ph, ...safe } = member;
  return ok(safe);
}

export async function patchStaff(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchStaffBody>;
  requestId: string;
}) {
  const { auth, id, body, requestId } = input;
  const { retailer, store } = await loadRetailerWithStore(auth.sub);
  if (id === retailer.id) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot change your own role');
  }
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, id),
      eq(retailerAccounts.storeId, store.id),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
  const before = { subRole: target.subRole };
  const [updated] = await db
    .update(retailerAccounts)
    .set({ subRole: body.subRole })
    .where(eq(retailerAccounts.id, target.id))
    .returning();
  await recordAudit({
    actor: auth,
    action: 'staff.change_role',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before,
    after: { subRole: body.subRole },
    requestId,
  });
  const { passwordHash: _ph, ...safe } = updated!;
  return ok(safe);
}

export async function deactivateStaff(input: {
  auth: Auth;
  id: string;
  requestId: string;
}) {
  const { auth, id, requestId } = input;
  const { retailer, store } = await loadRetailerWithStore(auth.sub);
  if (id === retailer.id) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot deactivate your own account');
  }
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, id),
      eq(retailerAccounts.storeId, store.id),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
  await db
    .update(retailerAccounts)
    .set({ status: 'terminated' })
    .where(eq(retailerAccounts.id, target.id));
  await recordAudit({
    actor: auth,
    action: 'staff.revoke',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before: { status: target.status },
    after: { status: 'terminated' },
    requestId,
  });
  return ok({ id: target.id, status: 'terminated' });
}

export async function reactivateStaff(input: {
  auth: Auth;
  id: string;
  requestId: string;
}) {
  const { auth, id, requestId } = input;
  const { store } = await loadRetailerWithStore(auth.sub);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, id),
      eq(retailerAccounts.storeId, store.id),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
  await db
    .update(retailerAccounts)
    .set({ status: 'active' })
    .where(eq(retailerAccounts.id, target.id));
  await recordAudit({
    actor: auth,
    action: 'staff.reactivate',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before: { status: target.status },
    after: { status: 'active' },
    requestId,
  });
  return ok({ id: target.id, status: 'active' });
}

export async function resetStaffPassword(input: {
  auth: Auth;
  id: string;
  requestId: string;
}) {
  const { auth, id, requestId } = input;
  const { store } = await loadRetailerWithStore(auth.sub);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, id),
      eq(retailerAccounts.storeId, store.id),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await db
    .update(retailerAccounts)
    .set({ passwordHash })
    .where(eq(retailerAccounts.id, target.id));
  // Invalidate any pending OTP reset tokens so an old emailed code can't
  // be redeemed after the owner has already set a new password.
  await db
    .delete(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.accountKind, 'retailer'),
        eq(passwordResetTokens.accountId, target.id),
      ),
    );
  await recordAudit({
    actor: auth,
    action: 'staff.reset_password',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    requestId,
  });
  // Cleartext returned once. UI must show it in a one-time modal with a
  // copy button; reload of the page must not re-reveal it.
  return ok({ id: target.id, tempPassword });
}

export async function listInvites(input: { auth: Auth }) {
  const { store } = await loadRetailerWithStore(input.auth.sub);
  const invites = await db.query.retailerStaffInvites.findMany({
    where: and(
      eq(retailerStaffInvites.storeId, store.id),
      isNull(retailerStaffInvites.acceptedAt),
      isNull(retailerStaffInvites.revokedAt),
    ),
    orderBy: (t, { desc }) => [desc(t.invitedAt)],
  });
  const safe = invites.map(({ tokenHash: _th, ...rest }) => rest);
  return ok(safe);
}

export async function createStaff(input: {
  auth: Auth;
  body: z.infer<typeof CreateStaffBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const { store } = await loadRetailerWithStore(auth.sub);
  const { legalName, email, password, subRole } = body;

  const existing = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, email),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'An account with this email already exists',
    );
  }

  const passwordHash = await hashPassword(password);
  const id = newId('ret');

  await db.insert(retailerAccounts).values({
    id,
    storeId: store.id,
    email,
    passwordHash,
    legalName,
    phone: '',
    gstin: '',
    subRole,
    status: 'active',
  });

  await recordAudit({
    actor: auth,
    action: 'staff.create',
    resourceKind: 'retailer_account',
    resourceId: id,
    after: { email, subRole, legalName },
    requestId,
  });

  return ok({ id, email, legalName, subRole, status: 'active' });
}

export async function inviteStaff(input: {
  auth: Auth;
  body: z.infer<typeof InviteStaffBody>;
  requestId: string;
  log: FastifyBaseLogger;
}) {
  const { auth, body, requestId, log } = input;
  const { retailer, store } = await loadRetailerWithStore(auth.sub);
  const { email, subRole } = body;

  const existing = await db.query.retailerStaffInvites.findFirst({
    where: and(
      eq(retailerStaffInvites.storeId, store.id),
      eq(retailerStaffInvites.email, email),
      eq(retailerStaffInvites.status, 'pending'),
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'A pending invite for this email already exists',
    );
  }

  const rawToken = `${newId('tok')}-${Date.now()}`;
  const tokenHash = await hashPassword(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const id = newId('inv');

  await db.insert(retailerStaffInvites).values({
    id,
    storeId: store.id,
    email,
    subRole,
    invitedByAccountId: retailer.id,
    tokenHash,
    expiresAt,
    status: 'pending',
  });

  log.info({ msg: 'STAFF_INVITE_TOKEN', email, token: rawToken });
  await recordAudit({
    actor: auth,
    action: 'staff.invite',
    resourceKind: 'staff_invite',
    resourceId: id,
    after: { email, subRole },
    requestId,
  });

  return ok({ id, email, subRole, expiresAt, status: 'pending' });
}

export async function resendInvite(input: {
  auth: Auth;
  id: string;
  log: FastifyBaseLogger;
}) {
  const { auth, id, log } = input;
  const { store } = await loadRetailerWithStore(auth.sub);
  const invite = await db.query.retailerStaffInvites.findFirst({
    where: and(
      eq(retailerStaffInvites.id, id),
      eq(retailerStaffInvites.storeId, store.id),
      eq(retailerStaffInvites.status, 'pending'),
    ),
  });
  if (!invite) throw new AppError(404, ErrorCode.NotFound, 'Pending invite not found');

  const rawToken = `${newId('tok')}-${Date.now()}`;
  const tokenHash = await hashPassword(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db
    .update(retailerStaffInvites)
    .set({ tokenHash, expiresAt })
    .where(eq(retailerStaffInvites.id, invite.id));

  log.info({ msg: 'STAFF_INVITE_RESEND_TOKEN', email: invite.email, token: rawToken });
  void auth;
  return ok({ id: invite.id, message: 'Invite resent' });
}

export async function revokeInvite(input: {
  auth: Auth;
  id: string;
  requestId: string;
}) {
  const { auth, id, requestId } = input;
  const { store } = await loadRetailerWithStore(auth.sub);
  const invite = await db.query.retailerStaffInvites.findFirst({
    where: and(
      eq(retailerStaffInvites.id, id),
      eq(retailerStaffInvites.storeId, store.id),
      eq(retailerStaffInvites.status, 'pending'),
    ),
  });
  if (!invite) throw new AppError(404, ErrorCode.NotFound, 'Pending invite not found');

  await db
    .update(retailerStaffInvites)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(eq(retailerStaffInvites.id, invite.id));

  await recordAudit({
    actor: auth,
    action: 'staff.revoke_invite',
    resourceKind: 'staff_invite',
    resourceId: invite.id,
    requestId,
  });

  return ok({ id: invite.id, status: 'revoked' });
}
