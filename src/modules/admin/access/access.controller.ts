import { and, asc, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  auditLog,
  impersonationSessions,
  retailerAccounts,
  retailerStores,
  subRolePermissionOverrides,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { generateTempPassword, hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { effectivePermissions, getDefaultMatrix } from '@/shared/permissions.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  AuditLogQuery,
  CreateTeamBody,
  ImpersonationStartBody,
  ImpersonationStopBody,
  RevokeBody,
  SubRoleOverrideBody,
  UpdateTeamBody,
} from './access.validators.js';

type Auth = AccessTokenPayload;

export async function getMyPermissions(input: { auth: Auth }) {
  const { auth } = input;
  if (!auth.subRole) {
    throw new AppError(409, ErrorCode.InvalidState, 'Admin token missing subRole');
  }
  const perms = await effectivePermissions('admin', auth.subRole);
  return ok({ scope: 'admin', subRole: auth.subRole, permissions: perms });
}

export async function listTeam() {
  const rows = await db.query.adminAccounts.findMany({
    orderBy: asc(adminAccounts.createdAt),
  });
  const safe = rows.map(({ passwordHash: _ph, ...rest }) => rest);
  return ok(safe);
}

export async function createTeamMember(input: {
  auth: Auth;
  body: z.infer<typeof CreateTeamBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const { email, password, subRole } = body;
  const existing = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.email, email),
  });
  if (existing) {
    throw new AppError(409, ErrorCode.EmailAlreadyTaken, 'Email already in use');
  }
  const passwordHash = await hashPassword(password);
  const id = newId('adm');
  await db.insert(adminAccounts).values({ id, email, passwordHash, subRole });
  await recordAudit({
    actor: auth,
    action: 'team.create',
    resourceKind: 'admin_account',
    resourceId: id,
    after: { email, subRole },
    requestId,
  });
  const created = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, id),
  });
  const { passwordHash: _ph, ...safe } = created!;
  return ok(safe);
}

export async function updateTeamMember(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof UpdateTeamBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const admin = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, id),
  });
  if (!admin) throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');

  // Block demoting the only remaining active super_admin.
  if (
    body.subRole !== undefined &&
    admin.subRole === 'super_admin' &&
    body.subRole !== 'super_admin' &&
    admin.status === 'active'
  ) {
    const rows = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(adminAccounts)
      .where(
        and(
          eq(adminAccounts.subRole, 'super_admin'),
          eq(adminAccounts.status, 'active'),
          ne(adminAccounts.id, admin.id),
        ),
      );
    if ((rows[0]?.cnt ?? 0) === 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot demote the last active super_admin',
      );
    }
  }

  if (body.email && body.email !== admin.email) {
    const collision = await db.query.adminAccounts.findFirst({
      where: eq(adminAccounts.email, body.email),
    });
    if (collision) {
      throw new AppError(409, ErrorCode.EmailAlreadyTaken, 'Email already in use');
    }
  }

  const updates: Partial<typeof adminAccounts.$inferInsert> = {};
  if (body.email !== undefined) updates.email = body.email;
  if (body.subRole !== undefined) updates.subRole = body.subRole;
  await db.update(adminAccounts).set(updates).where(eq(adminAccounts.id, admin.id));

  await recordAudit({
    actor: auth,
    action: 'team.update',
    resourceKind: 'admin_account',
    resourceId: admin.id,
    before: { email: admin.email, subRole: admin.subRole },
    after: updates,
    requestId,
  });

  const updated = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, admin.id),
  });
  const { passwordHash: _ph, ...safe } = updated!;
  return ok(safe);
}

export async function resetTeamPassword(input: {
  id: string;
  auth: Auth;
  requestId: string;
}) {
  const { id, auth, requestId } = input;
  const admin = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, id),
  });
  if (!admin) throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');
  const temp = generateTempPassword();
  const passwordHash = await hashPassword(temp);
  await db.update(adminAccounts).set({ passwordHash }).where(eq(adminAccounts.id, admin.id));
  await recordAudit({
    actor: auth,
    action: 'team.reset_password',
    resourceKind: 'admin_account',
    resourceId: admin.id,
    requestId,
  });
  // Temp password returned once. Admin must share it out-of-band.
  return ok({ id: admin.id, tempPassword: temp });
}

export async function revokeTeamMember(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof RevokeBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const admin = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, id),
  });
  if (!admin) throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');
  if (admin.id === auth.sub) {
    throw new AppError(409, ErrorCode.InvalidState, 'Cannot revoke your own account');
  }
  if (admin.subRole === 'super_admin' && admin.status === 'active') {
    const rows = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(adminAccounts)
      .where(
        and(
          eq(adminAccounts.subRole, 'super_admin'),
          eq(adminAccounts.status, 'active'),
          ne(adminAccounts.id, admin.id),
        ),
      );
    if ((rows[0]?.cnt ?? 0) === 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Cannot revoke the last active super_admin',
      );
    }
  }
  const before = { status: admin.status };
  await db
    .update(adminAccounts)
    .set({ status: 'revoked' })
    .where(eq(adminAccounts.id, admin.id));
  await recordAudit({
    actor: auth,
    action: 'team.revoke',
    resourceKind: 'admin_account',
    resourceId: admin.id,
    before,
    after: { status: 'revoked' },
    note: body.reason ?? null,
    requestId,
  });
  return ok({ id: admin.id, status: 'revoked' });
}

export async function reinstateTeamMember(input: {
  id: string;
  auth: Auth;
  requestId: string;
}) {
  const { id, auth, requestId } = input;
  const admin = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, id),
  });
  if (!admin) throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');
  if (admin.status !== 'revoked') {
    throw new AppError(409, ErrorCode.InvalidState, 'Account is not revoked');
  }
  await db
    .update(adminAccounts)
    .set({ status: 'active' })
    .where(eq(adminAccounts.id, admin.id));
  await recordAudit({
    actor: auth,
    action: 'team.reinstate',
    resourceKind: 'admin_account',
    resourceId: admin.id,
    before: { status: 'revoked' },
    after: { status: 'active' },
    requestId,
  });
  return ok({ id: admin.id, status: 'active' });
}

export async function listSubRoles() {
  const overrides = await db.query.subRolePermissionOverrides.findMany();
  const adminDefaults = getDefaultMatrix('admin');
  const retailerDefaults = getDefaultMatrix('retailer');

  const adminMatrix = Object.fromEntries(
    Object.entries(adminDefaults).map(([role, actions]) => [
      role,
      Object.fromEntries(
        Object.entries(actions).map(([action, defaultAllow]) => {
          const override = overrides.find(
            (o) => o.scope === 'admin' && o.subRole === role && o.action === action,
          );
          return [action, override ? override.allowed : defaultAllow];
        }),
      ),
    ]),
  );
  const retailerMatrix = Object.fromEntries(
    Object.entries(retailerDefaults).map(([role, actions]) => [
      role,
      Object.fromEntries(
        Object.entries(actions).map(([action, defaultAllow]) => {
          const override = overrides.find(
            (o) => o.scope === 'retailer' && o.subRole === role && o.action === action,
          );
          return [action, override ? override.allowed : defaultAllow];
        }),
      ),
    ]),
  );

  return ok({ admin: adminMatrix, retailer: retailerMatrix, overrides });
}

export async function upsertSubRoleOverride(input: {
  auth: Auth;
  body: z.infer<typeof SubRoleOverrideBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const { scope, subRole, action, allowed, note } = body;
  await db
    .insert(subRolePermissionOverrides)
    .values({
      scope,
      subRole,
      action,
      allowed,
      note: note ?? null,
      updatedAt: new Date(),
      updatedByAccountId: auth.sub,
    })
    .onConflictDoUpdate({
      target: [
        subRolePermissionOverrides.scope,
        subRolePermissionOverrides.subRole,
        subRolePermissionOverrides.action,
      ],
      set: {
        allowed,
        note: note ?? null,
        updatedAt: new Date(),
        updatedByAccountId: auth.sub,
      },
    });
  await recordAudit({
    actor: auth,
    action: 'sub_roles.edit',
    resourceKind: 'sub_role_override',
    after: { scope, subRole, action, allowed },
    requestId,
  });
  return ok({ scope, subRole, action, allowed });
}

export async function startImpersonation(input: {
  auth: Auth;
  body: z.infer<typeof ImpersonationStartBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, body.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

  // Locate the owner account for this store — the impersonation token will be
  // signed as that retailer so retailer routes (with `requireAuth('retailer')`)
  // accept it transparently. Audit captures the admin actor.
  const owner = await db.query.retailerAccounts.findFirst({
    where: and(
      eq(retailerAccounts.storeId, store.id),
      eq(retailerAccounts.subRole, 'owner'),
    ),
  });
  if (!owner) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Store has no owner account — cannot impersonate',
    );
  }
  if (owner.status !== 'active') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Owner account is '${owner.status}' — cannot impersonate`,
    );
  }

  const sessionId = newId('imp');
  await db.insert(impersonationSessions).values({
    id: sessionId,
    adminId: auth.sub,
    storeId: store.id,
    retailerId: owner.id,
    reason: body.reason ?? null,
  });
  await recordAudit({
    actor: auth,
    action: 'impersonation.start',
    resourceKind: 'impersonation_session',
    resourceId: sessionId,
    after: { storeId: store.id, retailerId: owner.id },
    impersonatedStoreId: store.id,
    requestId,
  });

  const token = signAccessToken({
    sub: owner.id,
    kind: 'retailer',
    subRole: owner.subRole,
    impersonator: { adminId: auth.sub, sessionId },
  });

  const { passwordHash: _ph, ...retailer } = owner;

  return ok({
    sessionId,
    storeId: store.id,
    storeName: store.legalName,
    token,
    retailer,
  });
}

export async function stopImpersonation(input: {
  auth: Auth;
  body: z.infer<typeof ImpersonationStopBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const session = await db.query.impersonationSessions.findFirst({
    where: and(
      eq(impersonationSessions.id, body.sessionId),
      eq(impersonationSessions.adminId, auth.sub),
      isNull(impersonationSessions.endedAt),
    ),
  });
  if (!session) {
    throw new AppError(404, ErrorCode.NotFound, 'Active impersonation session not found');
  }
  await db
    .update(impersonationSessions)
    .set({ endedAt: new Date() })
    .where(eq(impersonationSessions.id, session.id));
  await recordAudit({
    actor: auth,
    action: 'impersonation.stop',
    resourceKind: 'impersonation_session',
    resourceId: session.id,
    impersonatedStoreId: session.storeId,
    requestId,
  });
  return ok({ sessionId: session.id, endedAt: new Date() });
}

export async function listAuditLog(input: { query: z.infer<typeof AuditLogQuery> }) {
  const { resourceKind, resourceId, actorId, limit, before } = input.query;
  const conditions = [];
  if (resourceKind) conditions.push(eq(auditLog.resourceKind, resourceKind));
  if (resourceId) conditions.push(eq(auditLog.resourceId, resourceId));
  if (actorId) conditions.push(eq(auditLog.actorId, actorId));
  if (before) conditions.push(lt(auditLog.at, new Date(before)));

  const rows = await db.query.auditLog.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(auditLog.at),
    limit,
  });
  return ok(rows);
}
