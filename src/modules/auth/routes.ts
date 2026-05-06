import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { adminAccounts, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { hashPassword, verifyPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  EmailSchema,
  GstinSchema,
  PasswordSchema,
  PhoneSchema,
} from '@/shared/validation/common.js';

/**
 * Auth routes. Three identity domains; each login produces a token tagged with `kind` so
 * middleware can keep them strictly separate. No refresh tokens for MVP — access tokens
 * carry the configured longer expiry, frontend re-logs in on expiry.
 */
const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // ===== Admin login =====
  app.post(
    '/admin/login',
    {
      schema: {
body: z.object({
          email: EmailSchema,
          password: PasswordSchema,
        }),
      },
    },
    async (req) => {
      const { email, password } = req.body;
      const admin = await db.query.adminAccounts.findFirst({
        where: eq(adminAccounts.email, email),
      });
      if (!admin) {
        throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
      }
      if (admin.status !== 'active') {
        throw new AppError(403, ErrorCode.Forbidden, 'Admin account is revoked');
      }
      const passwordOk = await verifyPassword(password, admin.passwordHash);
      if (!passwordOk) {
        throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
      }
      const token = signAccessToken({ sub: admin.id, kind: 'admin', subRole: admin.subRole });
      return ok({
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          subRole: admin.subRole,
        },
      });
    },
  );

  // ===== Retailer signup (with auto-accept KYC) =====
  app.post(
    '/retailer/signup',
    {
      schema: {
body: z.object({
          email: EmailSchema,
          password: PasswordSchema,
          legalName: z.string().trim().min(2).max(120),
          phone: PhoneSchema,
          gstin: GstinSchema,
        }),
      },
    },
    async (req) => {
      const { email, password, legalName, phone, gstin } = req.body;

      // Pre-check for friendly error (DB unique would also reject, but with worse UX).
      const existing = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.email, email),
      });
      if (existing) {
        throw new AppError(409, ErrorCode.EmailAlreadyTaken, 'An account with this email already exists');
      }

      const passwordHash = await hashPassword(password);
      const id = newId(IdPrefix.Retailer);

      try {
        await db.insert(retailerAccounts).values({
          id,
          email,
          passwordHash,
          legalName,
          phone,
          gstin,
          subRole: 'owner',
          status: 'pending_approval',
        });
      } catch (err) {
        // Catch race-condition email collisions (unique violation 23505)
        const code = (err as { code?: string }).code;
        if (code === '23505') {
          throw new AppError(409, ErrorCode.EmailAlreadyTaken, 'An account with this email already exists');
        }
        throw err;
      }

      const token = signAccessToken({ sub: id, kind: 'retailer', subRole: 'owner' });
      return ok({
        token,
        retailer: {
          id,
          email,
          legalName,
          phone,
          gstin,
          status: 'pending_approval' as const,
          kycVerified: true,
        },
      });
    },
  );

  // ===== Retailer login =====
  app.post(
    '/retailer/login',
    {
      schema: {
body: z.object({
          email: EmailSchema,
          password: PasswordSchema,
        }),
      },
    },
    async (req) => {
      const { email, password } = req.body;
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.email, email),
      });
      if (!retailer) {
        throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
      }
      if (retailer.status === 'deactivated') {
        throw new AppError(403, ErrorCode.Forbidden, 'Account has been deactivated');
      }
      const passwordOk = await verifyPassword(password, retailer.passwordHash);
      if (!passwordOk) {
        throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
      }
      const token = signAccessToken({ sub: retailer.id, kind: 'retailer', subRole: retailer.subRole });
      return ok({
        token,
        retailer: {
          id: retailer.id,
          email: retailer.email,
          legalName: retailer.legalName,
          phone: retailer.phone,
          gstin: retailer.gstin,
          status: retailer.status,
          storeId: retailer.storeId,
        },
      });
    },
  );
};

export default authRoutes;
