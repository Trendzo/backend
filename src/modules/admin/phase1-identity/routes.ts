import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  auditLog,
  impersonationSessions,
  retailerStores,
  subRolePermissionOverrides,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';
import { recordAudit } from '@/shared/audit.js';
import { getDefaultMatrix } from '@/shared/permissions.js';

const adminPhase1Routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/team — list admin accounts (super_admin only) =====
  app.get('/team', async (req) => {
    const auth = getAuth(req);
    if (auth.subRole !== 'super_admin') {
      throw AppError.forbidden('Only super_admin can manage the admin team');
    }
    const rows = await db.query.adminAccounts.findMany({
      orderBy: asc(adminAccounts.createdAt),
    });
    const safe = rows.map(({ passwordHash: _ph, ...rest }) => rest);
    return ok(safe);
  });

  // ===== POST /admin/team — create admin account (super_admin only) =====
  app.post(
    '/team',
    {
      schema: {
        body: z.object({
          email: EmailSchema,
          password: PasswordSchema,
          subRole: z.enum(['super_admin', 'ops_admin', 'support']),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'super_admin') {
        throw AppError.forbidden('Only super_admin can manage the admin team');
      }
      const { email, password, subRole } = req.body;
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
        requestId: req.id,
      });
      const created = await db.query.adminAccounts.findFirst({
        where: eq(adminAccounts.id, id),
      });
      const { passwordHash: _ph, ...safe } = created!;
      return ok(safe);
    },
  );

  // ===== POST /admin/team/:id/revoke — deactivate admin account =====
  app.post(
    '/team/:id/revoke',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500).optional() }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'super_admin') {
        throw AppError.forbidden('Only super_admin can manage the admin team');
      }
      const admin = await db.query.adminAccounts.findFirst({
        where: eq(adminAccounts.id, req.params.id),
      });
      if (!admin) throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');
      if (admin.id === auth.sub) {
        throw new AppError(409, ErrorCode.InvalidState, 'Cannot revoke your own account');
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
        note: req.body.reason ?? null,
        requestId: req.id,
      });
      return ok({ id: admin.id, status: 'revoked' });
    },
  );

  // ===== GET /admin/sub-roles — get permission matrix with DB overrides applied =====
  app.get('/sub-roles', async (_req) => {
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
  });

  // ===== PATCH /admin/sub-roles — upsert permission overrides (super_admin only) =====
  app.patch(
    '/sub-roles',
    {
      schema: {
        body: z.object({
          scope: z.enum(['admin', 'retailer']),
          subRole: z.string().min(1),
          action: z.string().min(1),
          allowed: z.boolean(),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'super_admin') {
        throw AppError.forbidden('Only super_admin can edit sub-role permissions');
      }
      const { scope, subRole, action, allowed, note } = req.body;
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
          set: { allowed, note: note ?? null, updatedAt: new Date(), updatedByAccountId: auth.sub },
        });
      await recordAudit({
        actor: auth,
        action: 'sub_roles.edit',
        resourceKind: 'sub_role_override',
        after: { scope, subRole, action, allowed },
        requestId: req.id,
      });
      return ok({ scope, subRole, action, allowed });
    },
  );

  // ===== POST /admin/impersonation/start =====
  app.post(
    '/impersonation/start',
    {
      schema: {
        body: z.object({
          storeId: z.string(),
          reason: z.string().trim().min(1).max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, req.body.storeId),
      });
      if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');

      const sessionId = newId('imp');
      await db.insert(impersonationSessions).values({
        id: sessionId,
        adminId: auth.sub,
        storeId: store.id,
        retailerId: store.legalEntityId,
        reason: req.body.reason ?? null,
      });
      await recordAudit({
        actor: auth,
        action: 'impersonation.start',
        resourceKind: 'impersonation_session',
        resourceId: sessionId,
        after: { storeId: store.id },
        impersonatedStoreId: store.id,
        requestId: req.id,
      });

      const token = signAccessToken({
        sub: auth.sub,
        kind: 'admin',
        subRole: auth.subRole,
        impersonating: { storeId: store.id, sessionId },
      });

      return ok({ sessionId, storeId: store.id, storeName: store.legalName, token });
    },
  );

  // ===== POST /admin/impersonation/stop =====
  app.post(
    '/impersonation/stop',
    {
      schema: {
        body: z.object({ sessionId: z.string() }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const session = await db.query.impersonationSessions.findFirst({
        where: and(
          eq(impersonationSessions.id, req.body.sessionId),
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
        requestId: req.id,
      });
      return ok({ sessionId: session.id, endedAt: new Date() });
    },
  );

  // ===== GET /admin/audit-log — paginated audit log =====
  app.get(
    '/audit-log',
    {
      schema: {
        querystring: z.object({
          resourceKind: z.string().optional(),
          resourceId: z.string().optional(),
          actorId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().datetime().optional(),
        }),
      },
    },
    async (req) => {
      const { resourceKind, resourceId, actorId, limit, before } = req.query;
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
    },
  );
};

export default adminPhase1Routes;
