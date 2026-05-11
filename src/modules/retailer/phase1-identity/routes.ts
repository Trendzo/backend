import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  retailerAccounts,
  retailerStaffInvites,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { EmailSchema } from '@/shared/validation/common.js';
import { recordAudit } from '@/shared/audit.js';

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

const retailerPhase1Routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/staff =====
  app.get('/staff', async (req) => {
    const auth = getAuth(req);
    const { store } = await loadRetailerWithStore(auth.sub);
    const staff = await db.query.retailerAccounts.findMany({
      where: eq(retailerAccounts.storeId, store.id),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const safe = staff.map(({ passwordHash: _ph, ...rest }) => rest);
    return ok(safe);
  });

  // ===== GET /retailer/staff/:id =====
  app.get(
    '/staff/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const { store } = await loadRetailerWithStore(auth.sub);
      const member = await db.query.retailerAccounts.findFirst({
        where: and(eq(retailerAccounts.id, req.params.id), eq(retailerAccounts.storeId, store.id)),
      });
      if (!member) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
      const { passwordHash: _, ...safe } = member;
      return ok(safe);
    },
  );

  // ===== PATCH /retailer/staff/:id — change sub-role =====
  app.patch(
    '/staff/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ subRole: z.enum(['manager', 'staff']) }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'owner') throw AppError.forbidden('Only the owner can change staff roles');
      const { retailer, store } = await loadRetailerWithStore(auth.sub);
      if (req.params.id === retailer.id) {
        throw new AppError(409, ErrorCode.InvalidState, 'Cannot change your own role');
      }
      const target = await db.query.retailerAccounts.findFirst({
        where: and(eq(retailerAccounts.id, req.params.id), eq(retailerAccounts.storeId, store.id)),
      });
      if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
      const before = { subRole: target.subRole };
      const [updated] = await db
        .update(retailerAccounts)
        .set({ subRole: req.body.subRole })
        .where(eq(retailerAccounts.id, target.id))
        .returning();
      await recordAudit({
        actor: auth,
        action: 'staff.change_role',
        resourceKind: 'retailer_account',
        resourceId: target.id,
        before,
        after: { subRole: req.body.subRole },
        requestId: req.id,
      });
      const { passwordHash: _ph, ...safe } = updated!;
      return ok(safe);
    },
  );

  // ===== POST /retailer/staff/deactivate/:id =====
  app.post(
    '/staff/deactivate/:id',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'owner') throw AppError.forbidden('Only the owner can deactivate staff');
      const { retailer, store } = await loadRetailerWithStore(auth.sub);
      if (req.params.id === retailer.id) {
        throw new AppError(409, ErrorCode.InvalidState, 'Cannot deactivate your own account');
      }
      const target = await db.query.retailerAccounts.findFirst({
        where: and(eq(retailerAccounts.id, req.params.id), eq(retailerAccounts.storeId, store.id)),
      });
      if (!target) throw new AppError(404, ErrorCode.NotFound, 'Staff member not found');
      await db
        .update(retailerAccounts)
        .set({ status: 'deactivated' })
        .where(eq(retailerAccounts.id, target.id));
      await recordAudit({
        actor: auth,
        action: 'staff.revoke',
        resourceKind: 'retailer_account',
        resourceId: target.id,
        before: { status: target.status },
        after: { status: 'deactivated' },
        requestId: req.id,
      });
      return ok({ id: target.id, status: 'deactivated' });
    },
  );

  // ===== GET /retailer/staff/invites =====
  app.get('/staff/invites', async (req) => {
    const auth = getAuth(req);
    const { store } = await loadRetailerWithStore(auth.sub);
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
  });

  // ===== POST /retailer/staff/invite =====
  app.post(
    '/staff/invite',
    {
      schema: {
        body: z.object({
          email: EmailSchema,
          subRole: z.enum(['manager', 'staff']),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'owner' && auth.subRole !== 'manager') {
        throw AppError.forbidden('Only owners and managers can invite staff');
      }
      const { retailer, store } = await loadRetailerWithStore(auth.sub);
      const { email, subRole } = req.body;

      const existing = await db.query.retailerStaffInvites.findFirst({
        where: and(
          eq(retailerStaffInvites.storeId, store.id),
          eq(retailerStaffInvites.email, email),
          eq(retailerStaffInvites.status, 'pending'),
        ),
      });
      if (existing) {
        throw new AppError(409, ErrorCode.InvalidState, 'A pending invite for this email already exists');
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

      app.log.info({ msg: 'STAFF_INVITE_TOKEN', email, token: rawToken });
      await recordAudit({
        actor: auth,
        action: 'staff.invite',
        resourceKind: 'staff_invite',
        resourceId: id,
        after: { email, subRole },
        requestId: req.id,
      });

      return ok({ id, email, subRole, expiresAt, status: 'pending' });
    },
  );

  // ===== POST /retailer/staff/invites/:id/resend =====
  app.post(
    '/staff/invites/:id/resend',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const auth = getAuth(req);
      const { store } = await loadRetailerWithStore(auth.sub);
      const invite = await db.query.retailerStaffInvites.findFirst({
        where: and(
          eq(retailerStaffInvites.id, req.params.id),
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

      app.log.info({ msg: 'STAFF_INVITE_RESEND_TOKEN', email: invite.email, token: rawToken });
      return ok({ id: invite.id, message: 'Invite resent' });
    },
  );

  // ===== POST /retailer/staff/invites/:id/revoke =====
  app.post(
    '/staff/invites/:id/revoke',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const auth = getAuth(req);
      if (auth.subRole !== 'owner') throw AppError.forbidden('Only the owner can revoke invites');
      const { store } = await loadRetailerWithStore(auth.sub);
      const invite = await db.query.retailerStaffInvites.findFirst({
        where: and(
          eq(retailerStaffInvites.id, req.params.id),
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
        requestId: req.id,
      });

      return ok({ id: invite.id, status: 'revoked' });
    },
  );
};

export default retailerPhase1Routes;
