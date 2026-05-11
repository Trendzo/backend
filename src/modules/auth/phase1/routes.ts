import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  passwordResetTokens,
  retailerAccounts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { hashPassword, verifyPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';

const OTP_EXPIRES_MINUTES = 15;

const authPhase1Routes: FastifyPluginAsyncZod = async (app) => {
  // ===== POST /auth/admin/hardware-key-challenge — stub for MFA flow =====
  app.post(
    '/admin/hardware-key-challenge',
    {
      schema: {
        body: z.object({
          adminId: z.string(),
        }),
      },
    },
    async (req) => {
      // In production this would initiate a FIDO2 / WebAuthn challenge.
      // For MVP: always succeeds after simulated 800 ms (frontend already shows the UX).
      const admin = await db.query.adminAccounts.findFirst({
        where: eq(adminAccounts.id, req.body.adminId),
      });
      if (!admin || admin.status !== 'active') {
        throw new AppError(404, ErrorCode.NotFound, 'Admin account not found');
      }
      return ok({ challengeId: newId('hwk'), expiresInMs: 30_000 });
    },
  );

  // ===== POST /auth/password-reset/start =====
  app.post(
    '/password-reset/start',
    {
      schema: {
        body: z.object({
          kind: z.enum(['retailer', 'admin']),
          email: EmailSchema,
        }),
      },
    },
    async (req) => {
      const { kind, email } = req.body;

      let accountId: string | undefined;
      if (kind === 'admin') {
        const admin = await db.query.adminAccounts.findFirst({
          where: eq(adminAccounts.email, email),
        });
        if (admin?.status === 'active') accountId = admin.id;
      } else {
        const retailer = await db.query.retailerAccounts.findFirst({
          where: eq(retailerAccounts.email, email),
        });
        if (retailer && retailer.status !== 'deactivated') accountId = retailer.id;
      }

      if (accountId) {
        const rawCode = Math.floor(100_000 + Math.random() * 900_000).toString();
        const codeHash = await hashPassword(rawCode);
        const expiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);
        await db.insert(passwordResetTokens).values({
          id: newId('prt'),
          accountKind: kind,
          accountId,
          codeHash,
          expiresAt,
        });
        // In production: send rawCode via email. In dev: log it.
        app.log.info({ msg: 'PASSWORD_RESET_OTP', email, code: rawCode });
      }

      // Always return success — don't leak whether the email exists.
      return ok({ message: 'If the email exists, a reset code has been sent' });
    },
  );

  // ===== POST /auth/password-reset/complete =====
  app.post(
    '/password-reset/complete',
    {
      schema: {
        body: z.object({
          kind: z.enum(['retailer', 'admin']),
          email: EmailSchema,
          code: z.string().length(6),
          newPassword: PasswordSchema,
        }),
      },
    },
    async (req) => {
      const { kind, email, code, newPassword } = req.body;

      let accountId: string | undefined;
      if (kind === 'admin') {
        const admin = await db.query.adminAccounts.findFirst({
          where: eq(adminAccounts.email, email),
        });
        if (admin?.status === 'active') accountId = admin.id;
      } else {
        const retailer = await db.query.retailerAccounts.findFirst({
          where: eq(retailerAccounts.email, email),
        });
        if (retailer && retailer.status !== 'deactivated') accountId = retailer.id;
      }

      if (!accountId) {
        throw new AppError(400, ErrorCode.InvalidCredentials, 'Invalid or expired reset code');
      }

      const token = await db.query.passwordResetTokens.findFirst({
        where: and(
          eq(passwordResetTokens.accountKind, kind),
          eq(passwordResetTokens.accountId, accountId),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      if (!token) {
        throw new AppError(400, ErrorCode.InvalidCredentials, 'Invalid or expired reset code');
      }

      const codeOk = await verifyPassword(code, token.codeHash);
      if (!codeOk) {
        throw new AppError(400, ErrorCode.InvalidCredentials, 'Invalid or expired reset code');
      }

      // Mark used
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, token.id));

      const newHash = await hashPassword(newPassword);
      if (kind === 'admin') {
        await db
          .update(adminAccounts)
          .set({ passwordHash: newHash })
          .where(eq(adminAccounts.id, accountId));
      } else {
        await db
          .update(retailerAccounts)
          .set({ passwordHash: newHash })
          .where(eq(retailerAccounts.id, accountId));
      }

      return ok({ message: 'Password updated successfully' });
    },
  );
};

export default authPhase1Routes;
