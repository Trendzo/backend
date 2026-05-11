import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  applicationMessages,
  applicationVerificationChecks,
  bankAccounts,
  retailerAccounts,
  retailerApplications,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { hashPassword } from '@/shared/auth/password.js';
import { newId } from '@/shared/ids.js';
import { PasswordSchema } from '@/shared/validation/common.js';
import { recordAudit } from '@/shared/audit.js';

const adminOnboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/applications — application review queue =====
  app.get(
    '/applications',
    {
      schema: {
        querystring: z.object({
          status: z
            .enum(['pending', 'under_review', 'docs_requested', 'approved', 'rejected'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const { status, limit } = req.query;
      const rows = await db.query.retailerApplications.findMany({
        where: status ? eq(retailerApplications.status, status) : undefined,
        orderBy: desc(retailerApplications.submittedAt),
        limit,
        with: {
          documents: { columns: { id: true } },
          checks: { columns: { kind: true, status: true } },
          messages: { columns: { id: true, authorKind: true } },
        },
      });

      return ok(
        rows.map((r) => {
          const pennyCheck = r.checks.filter((c) => c.kind === 'bank_penny_drop').pop();
          const gstinCheck = r.checks.filter((c) => c.kind === 'gstin').pop();
          return {
            id: r.id,
            legalName: r.legalName,
            email: r.ownerEmail,
            phone: r.ownerPhone,
            gstin: r.gstin,
            pan: r.pan ?? null,
            addressLine: r.addressLine,
            pincode: r.pincode,
            stateCode: r.stateCode,
            submittedAt: r.submittedAt.toISOString(),
            status: r.status,
            documentsCount: r.documents.length,
            clarificationCount: r.messages.filter((m) => m.authorKind === 'admin').length,
            pennyDropResult: !pennyCheck
              ? 'not_attempted'
              : pennyCheck.status === 'verified'
                ? 'matched'
                : pennyCheck.status === 'failed'
                  ? 'failed'
                  : 'not_attempted',
            gstinVerification: !gstinCheck
              ? 'not_attempted'
              : gstinCheck.status === 'verified'
                ? 'valid'
                : gstinCheck.status === 'failed'
                  ? 'invalid'
                  : 'not_attempted',
          };
        }),
      );
    },
  );

  // ===== GET /admin/applications/:id =====
  app.get(
    '/applications/:id',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const r = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
        with: { documents: true, checks: true, messages: { orderBy: asc(applicationMessages.at) } },
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Application not found');

      const pennyCheck = r.checks.filter((c) => c.kind === 'bank_penny_drop').pop();
      const gstinCheck = r.checks.filter((c) => c.kind === 'gstin').pop();

      return ok({
        id: r.id,
        legalName: r.legalName,
        email: r.ownerEmail,
        phone: r.ownerPhone,
        gstin: r.gstin,
        pan: r.pan ?? null,
        addressLine: r.addressLine,
        pincode: r.pincode,
        stateCode: r.stateCode,
        submittedAt: r.submittedAt.toISOString(),
        status: r.status,
        documentsCount: r.documents.length,
        clarificationCount: r.messages.filter((m) => m.authorKind === 'admin').length,
        pennyDropResult: !pennyCheck
          ? 'not_attempted'
          : pennyCheck.status === 'verified'
            ? 'matched'
            : pennyCheck.status === 'failed'
              ? 'failed'
              : 'not_attempted',
        gstinVerification: !gstinCheck
          ? 'not_attempted'
          : gstinCheck.status === 'verified'
            ? 'valid'
            : gstinCheck.status === 'failed'
              ? 'invalid'
              : 'not_attempted',
        documents: r.documents,
        messages: r.messages.map((m) => ({
          id: m.id,
          applicationId: m.applicationId,
          authorKind: m.authorKind,
          authorLabel: m.authorKind === 'admin' ? 'ClosetX admin' : 'Applicant',
          body: m.body,
          attachments: m.attachmentUrls ?? [],
          fieldKey: null as string | null,
          createdAt: m.at.toISOString(),
        })),
      });
    },
  );

  // ===== PATCH /admin/applications/:id/status — move to under_review / docs_requested =====
  app.patch(
    '/applications/:id/status',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          status: z.enum(['under_review', 'docs_requested']),
          reason: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      const before = { status: application.status };
      const [updated] = await db
        .update(retailerApplications)
        .set({ status: req.body.status })
        .where(eq(retailerApplications.id, application.id))
        .returning();
      await recordAudit({
        actor: auth,
        action: `application.${req.body.status}`,
        resourceKind: 'retailer_application',
        resourceId: application.id,
        before,
        after: { status: req.body.status },
        note: req.body.reason ?? null,
        requestId: req.id,
      });
      return ok(updated);
    },
  );

  // ===== POST /admin/applications/:id/approve — provision retailer account =====
  app.post(
    '/applications/:id/approve',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          // Optional if the applicant set a password during signup.
          tempPassword: PasswordSchema.optional(),
          note: z.string().trim().max(500).optional(),
          // Platform fee in basis points (e.g. 1000 = 10%). Defaults to 1000.
          platformFeeBp: z.coerce.number().int().min(0).max(10000).default(1000),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      req.log.info({ applicationId: req.params.id }, 'approve: starting');
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      req.log.info({ status: application.status, hasPasswordHash: !!application.passwordHash }, 'approve: application found');
      if (application.status === 'approved') {
        throw new AppError(409, ErrorCode.InvalidState, 'Application already approved');
      }
      if (application.status === 'rejected') {
        throw new AppError(409, ErrorCode.InvalidState, 'Cannot approve a rejected application');
      }

      const retailerId = newId('ret');
      const storeId = newId('str');

      // Use applicant-set password if present; otherwise require tempPassword from admin.
      const passwordHash = application.passwordHash
        ? application.passwordHash
        : req.body.tempPassword
          ? await hashPassword(req.body.tempPassword)
          : (() => { throw new AppError(400, ErrorCode.ValidationError, 'tempPassword required: applicant did not set a password during signup'); })();

      req.log.info({ storeId, retailerId }, 'approve: inserting retailerStores');
      // Create the store first so we can link the account to it.
      await db.insert(retailerStores).values({
        id: storeId,
        legalEntityId: retailerId,
        legalName: application.storeName ?? application.legalName,
        gstin: application.gstin,
        pan: application.pan ?? null,
        address: application.addressLine,
        stateCode: application.stateCode,
        lat: application.lat ? parseFloat(application.lat) : 0,
        lng: application.lng ? parseFloat(application.lng) : 0,
        openingHours: (application.hours as Record<string, { open: string; close: string }[]>) ?? null,
        status: 'onboarding',
        platformFeeBp: req.body.platformFeeBp,
      });
      req.log.info('approve: retailerStores inserted');

      // Optionally record bank account from application.
      if (application.bankAccountNumber && application.bankIfsc && application.bankLegalName) {
        req.log.info('approve: inserting bankAccounts');
        await db.insert(bankAccounts).values({
          id: newId('bnk'),
          storeId,
          accountNumber: application.bankAccountNumber,
          ifsc: application.bankIfsc,
          legalName: application.bankLegalName,
          isDefault: true,
        });
        req.log.info('approve: bankAccounts inserted');
      }

      req.log.info({ retailerId, email: application.ownerEmail }, 'approve: inserting retailerAccounts');
      await db.insert(retailerAccounts).values({
        id: retailerId,
        email: application.ownerEmail,
        passwordHash,
        legalName: application.legalName,
        phone: application.ownerPhone,
        gstin: application.gstin,
        storeId,
        subRole: 'owner',
        status: 'active',
      });
      req.log.info('approve: retailerAccounts inserted');

      await db
        .update(retailerApplications)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionReason: req.body.note ?? null,
          provisionedRetailerAccountId: retailerId,
        })
        .where(eq(retailerApplications.id, application.id));

      req.log.info('approve: application status updated');
      await recordAudit({
        actor: auth,
        action: 'application.approve',
        resourceKind: 'retailer_application',
        resourceId: application.id,
        after: { provisionedRetailerId: retailerId, provisionedStoreId: storeId },
        note: req.body.note ?? null,
        requestId: req.id,
      });

      return ok({ retailerId, storeId, message: 'Application approved; retailer account and store provisioned' });
    },
  );

  // ===== POST /admin/applications/:id/reject =====
  app.post(
    '/applications/:id/reject',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      if (application.status === 'approved') {
        throw new AppError(409, ErrorCode.InvalidState, 'Cannot reject an approved application');
      }
      const [updated] = await db
        .update(retailerApplications)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionReason: req.body.reason,
        })
        .where(eq(retailerApplications.id, application.id))
        .returning();
      await recordAudit({
        actor: auth,
        action: 'application.reject',
        resourceKind: 'retailer_application',
        resourceId: application.id,
        after: { reason: req.body.reason },
        requestId: req.id,
      });
      return ok(updated);
    },
  );

  // ===== POST /admin/applications/:id/messages — admin sends clarification message =====
  app.post(
    '/applications/:id/messages',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          body: z.string().trim().min(1).max(2000),
          attachmentUrls: z.array(z.string().url()).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      const id = newId('amsg');
      await db.insert(applicationMessages).values({
        id,
        applicationId: application.id,
        authorKind: 'admin',
        authorAccountId: auth.sub,
        body: req.body.body,
        attachmentUrls: req.body.attachmentUrls ?? null,
      });
      return ok({ id });
    },
  );

  // ===== POST /admin/applications/:id/verification-checks — trigger/record verification =====
  app.post(
    '/applications/:id/verification-checks',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          kind: z.enum(['gstin', 'pan', 'bank_penny_drop']),
          status: z.enum(['pending', 'in_progress', 'verified', 'failed']),
          rawResponse: z.record(z.unknown()).optional(),
          errorCode: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application) throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      const id = newId('vchk');
      const now = new Date();
      await db.insert(applicationVerificationChecks).values({
        id,
        applicationId: application.id,
        kind: req.body.kind,
        status: req.body.status,
        rawResponse: req.body.rawResponse ?? null,
        errorCode: req.body.errorCode ?? null,
        finishedAt: ['verified', 'failed'].includes(req.body.status) ? now : null,
      });
      return ok({ id, kind: req.body.kind, status: req.body.status });
    },
  );
};

export default adminOnboardingRoutes;
