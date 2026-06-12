import { desc, eq, or } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  retailerAccounts,
  retailerApplications,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { hashPassword, verifyPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { LoginBody, SignupBody } from './auth.validators.js';

/**
 * Auth controller. Three identity domains; each login produces a token tagged with `kind`
 * so middleware can keep them strictly separate. No refresh tokens for MVP — access tokens
 * carry the configured longer expiry, frontend re-logs in on expiry.
 */

export async function adminLogin(input: { body: z.infer<typeof LoginBody> }) {
  const { email, password } = input.body;
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
}

export async function retailerSignup(input: { body: z.infer<typeof SignupBody> }) {
  const { email, password, legalName, phone, gstin } = input.body;

  // Email collision in retailer_accounts.
  const emailCollision = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, email),
  });
  if (emailCollision) {
    throw new AppError(
      409,
      ErrorCode.EmailAlreadyTaken,
      'An account with this email already exists',
    );
  }
  // Phone collision in retailer_accounts. Phones are 1:1 with retailer accounts.
  const phoneCollision = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.phone, phone),
  });
  if (phoneCollision) {
    throw new AppError(
      409,
      ErrorCode.EmailAlreadyTaken,
      'An account with this phone number already exists',
    );
  }
  // Block signup when an existing application uses this email/phone — including a
  // rejected one. Rejected applicants must re-apply via the status page, not start over
  // with a fresh account (which would orphan the prior submission history).
  const appCollision = await db.query.retailerApplications.findFirst({
    where: or(
      eq(retailerApplications.ownerEmail, email),
      eq(retailerApplications.ownerPhone, phone),
    ),
    columns: { id: true, status: true, ownerEmail: true, ownerPhone: true },
  });
  if (appCollision) {
    if (appCollision.status === 'rejected') {
      throw new AppError(
        409,
        ErrorCode.ApplicationRejected,
        'A previous application with this email or phone was rejected. Sign in on the status page to re-apply on the same record.',
        { applicationId: appCollision.id },
      );
    }
    throw new AppError(
      409,
      ErrorCode.ApplicationPending,
      'An application with this email or phone is already on file. Sign in on the status page to view it.',
      { applicationId: appCollision.id },
    );
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
      throw new AppError(
        409,
        ErrorCode.EmailAlreadyTaken,
        'An account with this email already exists',
      );
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
}

export async function retailerLogin(input: { body: z.infer<typeof LoginBody> }) {
  const { email, password } = input.body;
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, email),
  });
  if (!retailer) {
    // Check if this email belongs to a pending/under-review application.
    const application = await db.query.retailerApplications.findFirst({
      where: eq(retailerApplications.ownerEmail, email),
      columns: { id: true, status: true },
      orderBy: desc(retailerApplications.submittedAt),
    });
    if (application) {
      if (application.status === 'rejected') {
        throw new AppError(
          403,
          ErrorCode.ApplicationRejected,
          'Your application was not approved. Contact support for details.',
          { applicationId: application.id },
        );
      }
      throw new AppError(
        403,
        ErrorCode.ApplicationPending,
        'Your application is under review. You will be able to log in once ClosetX approves it.',
        { applicationId: application.id },
      );
    }
    throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
  }
  // Terminated retailers may still sign in — they get read-only access so
  // owners/managers can retrieve their records (orders, invoices, statements).
  // Every mutating request is rejected centrally in `requireAuth` (see
  // shared/auth/middleware.ts), and store-level guards block publishes anyway.
  const passwordOk = await verifyPassword(password, retailer.passwordHash);
  if (!passwordOk) {
    throw new AppError(401, ErrorCode.InvalidCredentials, 'Email or password is incorrect');
  }
  const token = signAccessToken({
    sub: retailer.id,
    kind: 'retailer',
    subRole: retailer.subRole,
  });
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
      subRole: retailer.subRole,
    },
  });
}
