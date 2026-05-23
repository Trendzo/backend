/**
 * Admin staff management (per retailer): list, create, change role, deactivate, reactivate, reset password.
 */
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { generateTempPassword, hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ChangeRoleBody,
  CreateStaffBody,
  OptionalReasonBody,
  ResetPasswordBody,
} from './staff-mgmt.validators.js';

type Auth = AccessTokenPayload;

async function loadRetailerOr404(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
  return retailer;
}

export async function listStaff(input: { id: string }) {
  const retailer = await loadRetailerOr404(input.id);
  if (!retailer.storeId) return ok([]);
  const staff = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, retailer.storeId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  const safe = staff.map(({ passwordHash: _ph, ...rest }) => rest);
  return ok(safe);
}

export async function createStaff(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CreateStaffBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.id);
  if (!retailer.storeId) {
    throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no store yet');
  }
  const existing = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, input.body.email),
  });
  if (existing) {
    throw new AppError(409, ErrorCode.InvalidState, 'Email already in use');
  }
  const id = newId(IdPrefix.Retailer);
  const passwordHash = await hashPassword(input.body.password);
  await db.insert(retailerAccounts).values({
    id,
    storeId: retailer.storeId,
    email: input.body.email,
    passwordHash,
    legalName: input.body.legalName,
    phone: input.body.phone,
    gstin: retailer.gstin,
    subRole: input.body.subRole,
    status: 'active',
  });
  await recordAudit({
    actor: input.auth,
    action: 'staff.create',
    resourceKind: 'retailer_account',
    resourceId: id,
    after: { email: input.body.email, subRole: input.body.subRole },
    impersonatedStoreId: retailer.storeId,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: id,
    kind: 'system',
    title: 'Staff account created by admin',
    body: `Welcome to ClosetX. Sign in with ${input.body.email}.`,
  });
  return ok({ id, email: input.body.email, subRole: input.body.subRole, status: 'active' });
}

export async function changeRole(input: {
  auth: Auth;
  retailerId: string;
  accountId: string;
  body: z.infer<typeof ChangeRoleBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.retailerId);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, input.accountId),
      eq(retailerAccounts.storeId, retailer.storeId ?? ''),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff account not found');
  const before = { subRole: target.subRole };
  const [updated] = await db
    .update(retailerAccounts)
    .set({ subRole: input.body.subRole })
    .where(eq(retailerAccounts.id, target.id))
    .returning();
  await recordAudit({
    actor: input.auth,
    action: 'staff.change_role',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before,
    after: { subRole: input.body.subRole },
    impersonatedStoreId: retailer.storeId,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: target.id,
    kind: 'system',
    title: 'Role changed by admin',
    body: `Your role is now '${input.body.subRole}'.`,
  });
  const { passwordHash: _ph, ...safe } = updated!;
  return ok(safe);
}

export async function deactivateStaff(input: {
  auth: Auth;
  retailerId: string;
  accountId: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.retailerId);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, input.accountId),
      eq(retailerAccounts.storeId, retailer.storeId ?? ''),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff account not found');
  if (target.status === 'terminated') {
    throw new AppError(409, ErrorCode.InvalidState, 'Staff is already terminated');
  }
  await db
    .update(retailerAccounts)
    .set({ status: 'terminated' })
    .where(eq(retailerAccounts.id, target.id));
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'staff.deactivate',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before: { status: target.status },
    after: { status: 'terminated' },
    note: body.reason ?? null,
    impersonatedStoreId: retailer.storeId,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: target.id,
    kind: 'system',
    title: 'Account terminated by admin',
    body: body.reason ?? 'Your account has been terminated.',
  });
  return ok({ id: target.id, status: 'terminated' });
}

export async function reactivateStaff(input: {
  auth: Auth;
  retailerId: string;
  accountId: string;
  body: z.infer<typeof OptionalReasonBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.retailerId);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, input.accountId),
      eq(retailerAccounts.storeId, retailer.storeId ?? ''),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff account not found');
  await db
    .update(retailerAccounts)
    .set({ status: 'active' })
    .where(eq(retailerAccounts.id, target.id));
  const body = input.body as { reason?: string };
  await recordAudit({
    actor: input.auth,
    action: 'staff.reactivate',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    before: { status: target.status },
    after: { status: 'active' },
    note: body.reason ?? null,
    impersonatedStoreId: retailer.storeId,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: target.id,
    kind: 'system',
    title: 'Account reactivated by admin',
  });
  return ok({ id: target.id, status: 'active' });
}

export async function resetPassword(input: {
  auth: Auth;
  retailerId: string;
  accountId: string;
  body: z.infer<typeof ResetPasswordBody>;
  requestId: string;
}) {
  const retailer = await loadRetailerOr404(input.retailerId);
  const target = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.id, input.accountId),
      eq(retailerAccounts.storeId, retailer.storeId ?? ''),
    ),
  });
  if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff account not found');
  const body = input.body as { newPassword?: string };
  const generated = body.newPassword ? null : generateTempPassword();
  const finalPassword = body.newPassword ?? generated!;
  const passwordHash = await hashPassword(finalPassword);
  await db
    .update(retailerAccounts)
    .set({ passwordHash })
    .where(eq(retailerAccounts.id, target.id));
  await recordAudit({
    actor: input.auth,
    action: 'staff.reset_password',
    resourceKind: 'retailer_account',
    resourceId: target.id,
    impersonatedStoreId: retailer.storeId,
    requestId: input.requestId,
  });
  await notify({
    recipientKind: 'retailer',
    recipientId: target.id,
    kind: 'system',
    title: 'Password reset by admin',
    body: 'Your password was reset by ClosetX admin. Use the new credentials to sign in.',
  });
  return ok({
    id: target.id,
    passwordReset: true,
    ...(generated && { tempPassword: generated }),
  });
}
