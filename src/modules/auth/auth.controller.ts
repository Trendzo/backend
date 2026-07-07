import { desc, eq, or } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  consumers,
  deliveryAgents,
  retailerAccounts,
  retailerApplications,
} from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { hashPassword, verifyPassword } from '@/shared/auth/password.js';
import { verifyMsg91AccessToken } from '@/shared/msg91/verify.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { LoginBody, Msg91VerifyBody, SignupBody } from './auth.validators.js';

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

/** Deterministic unique referral code derived from the consumer id (id is unique). */
function referralCodeFor(consumerId: string): string {
  return ('CX' + consumerId.slice(4, 12)).toUpperCase();
}

function shapeConsumer(c: typeof consumers.$inferSelect) {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name,
    email: c.email,
    genderPreference: c.genderPreference,
    referralCode: c.referralCode,
    // Order placement snapshots require both; the app routes incomplete profiles
    // through the complete-profile step before checkout.
    profileComplete: !!(c.name && c.email),
  };
}

/**
 * Consumer phone-OTP login (MSG91). The client completes the OTP flow against MSG91's
 * widget API and posts the resulting access token here; we re-verify it server-side,
 * then find-or-create the consumer by verified phone. Login and signup are the same
 * endpoint — first OTP verify creates the account.
 */
export async function consumerOtpLogin(input: { body: z.infer<typeof Msg91VerifyBody> }) {
  const phone = await verifyMsg91AccessToken(input.body.accessToken);

  let consumer = await db.query.consumers.findFirst({
    where: eq(consumers.phone, phone),
  });

  if (!consumer) {
    const id = newId(IdPrefix.Consumer);
    try {
      const inserted = await db
        .insert(consumers)
        .values({ id, phone, referralCode: referralCodeFor(id), status: 'active' })
        .returning();
      consumer = inserted[0]!;
    } catch (err) {
      // Two first-logins racing on the same phone — the loser re-reads the winner's row.
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      consumer = await db.query.consumers.findFirst({ where: eq(consumers.phone, phone) });
      if (!consumer) {
        throw new AppError(500, ErrorCode.InternalError, 'Could not create account');
      }
    }
  }

  // Mirror the middleware's status gate so a suspended consumer can't mint a fresh token.
  if (consumer.status === 'suspended') {
    throw new AppError(401, ErrorCode.ConsumerSuspended, 'Account is suspended');
  }
  if (consumer.status === 'closed') {
    throw new AppError(401, ErrorCode.ConsumerClosed, 'Account is closed');
  }

  const token = signAccessToken(
    { sub: consumer.id, kind: 'consumer' },
    { expiresIn: env.JWT_CONSUMER_ACCESS_EXPIRES_IN },
  );
  return ok({ token, consumer: shapeConsumer(consumer) });
}

function shapeDriver(d: typeof deliveryAgents.$inferSelect) {
  return {
    id: d.id,
    phone: d.phone,
    name: d.name,
    avatarUrl: d.avatarUrl,
    vehicleType: d.vehicleType,
    vehicleNumber: d.vehicleNumber,
    city: d.city,
    status: d.status,
    // The app routes an incomplete profile through the profile-setup step.
    profileComplete: !!d.name,
  };
}

/**
 * Driver phone-OTP login (MSG91) — standalone identity, mirrors {@link consumerOtpLogin}.
 * Find-or-create by verified phone, instant-active (no approval gate). The driver widget is
 * its own MSG91 account, so it needs a dedicated authkey (503 if unconfigured), same as the
 * retailer flow. First OTP verify creates the account.
 */
export async function driverOtpLogin(input: { body: z.infer<typeof Msg91VerifyBody> }) {
  // The driver app reuses the retailer MSG91 widget/account, so its tokens verify against the
  // retailer authkey. Prefer a dedicated driver key if one is ever configured.
  const driverAuthKey = env.MSG91_DRIVER_AUTH_KEY ?? env.MSG91_RETAILER_AUTH_KEY;
  if (!driverAuthKey) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'Driver OTP verification is not configured (missing MSG91 credentials).',
    );
  }
  const phone = await verifyMsg91AccessToken(input.body.accessToken, {
    format: 'e164',
    authKey: driverAuthKey,
  });

  let driver = await db.query.deliveryAgents.findFirst({
    where: eq(deliveryAgents.phone, phone),
  });

  // `isNew` = this verified phone had no account, so the app routes to the signup
  // (profile-completion) flow instead of straight into the app.
  let isNew = false;
  if (!driver) {
    isNew = true;
    const id = newId(IdPrefix.Driver);
    try {
      const inserted = await db
        .insert(deliveryAgents)
        .values({ id, phone, status: 'active' })
        .returning();
      driver = inserted[0]!;
    } catch (err) {
      // Two first-logins racing on the same phone — the loser re-reads the winner's row.
      const code = (err as { code?: string }).code;
      if (code !== '23505') throw err;
      isNew = false;
      driver = await db.query.deliveryAgents.findFirst({ where: eq(deliveryAgents.phone, phone) });
      if (!driver) {
        throw new AppError(500, ErrorCode.InternalError, 'Could not create account');
      }
    }
  }

  // Mirror the middleware's status gate so a suspended/inactive driver can't mint a token.
  if (driver.status === 'suspended') {
    throw new AppError(401, ErrorCode.DriverSuspended, 'Account is suspended');
  }
  if (driver.status === 'inactive') {
    throw new AppError(401, ErrorCode.DriverInactive, 'Account is inactive');
  }

  const token = signAccessToken(
    { sub: driver.id, kind: 'driver' },
    { expiresIn: env.JWT_DRIVER_ACCESS_EXPIRES_IN },
  );
  return ok({ token, driver: shapeDriver(driver), isNew });
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
  assertRetailerNotDeleted(retailer.suspendReason);
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

/**
 * Retailer phone-OTP login (MSG91). Alternative to email+password: the client completes the
 * OTP flow against MSG91's widget and posts the access token here; we re-verify it and match
 * the verified phone (canonical E.164) to an existing retailer account. Unlike consumer login,
 * this NEVER creates an account — retailers must onboard/be approved first. Onboarding does no
 * phone verification; OTP only happens here at login.
 */
export async function retailerOtpLogin(input: { body: z.infer<typeof Msg91VerifyBody> }) {
  // Retailer widget is a different MSG91 account than consumer, so it needs its own
  // authkey; don't fall back to the consumer key (that would verify against the wrong
  // account and fail confusingly). Surface a clear 503 when it's not configured.
  const retailerAuthKey = env.MSG91_RETAILER_AUTH_KEY;
  if (!retailerAuthKey) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'Retailer OTP verification is not configured (missing MSG91 credentials).',
    );
  }
  const phone = await verifyMsg91AccessToken(input.body.accessToken, {
    format: 'e164',
    authKey: retailerAuthKey,
  });

  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.phone, phone),
  });
  if (!retailer) {
    // No account on this phone — surface a pending/rejected application if one exists,
    // mirroring the email-based gating in retailerLogin.
    const application = await db.query.retailerApplications.findFirst({
      where: eq(retailerApplications.ownerPhone, phone),
      columns: { id: true, status: true, ownerEmail: true },
      orderBy: desc(retailerApplications.submittedAt),
    });
    if (application) {
      // The application-status/resubmit screens key off the owner email (thread
      // identity), which OTP login never collects — so hand it back in the error
      // details for the client to route with.
      if (application.status === 'rejected') {
        throw new AppError(
          403,
          ErrorCode.ApplicationRejected,
          'Your application was not approved. Contact support for details.',
          { applicationId: application.id, ownerEmail: application.ownerEmail },
        );
      }
      throw new AppError(
        403,
        ErrorCode.ApplicationPending,
        'Your application is under review. You will be able to log in once ClosetX approves it.',
        { applicationId: application.id, ownerEmail: application.ownerEmail },
      );
    }
    throw new AppError(
      401,
      ErrorCode.InvalidCredentials,
      'No retailer account is linked to this phone number',
    );
  }
  assertRetailerNotDeleted(retailer.suspendReason);
  // Terminated retailers may still sign in (read-only), same as password login — every
  // mutating request is rejected centrally in requireAuth.
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

function assertRetailerNotDeleted(suspendReason: string | null): void {
  if (suspendReason === 'account_deleted_by_user') {
    throw AppError.unauthorized('This account has been deleted');
  }
}
