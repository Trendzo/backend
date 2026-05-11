import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  applicationDocuments,
  applicationMessages,
  retailerApplications,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { hashPassword } from '@/shared/auth/password.js';
import { GstinSchema, EmailSchema, PhoneSchema } from '@/shared/validation/common.js';

/**
 * Public application submission — no auth required. Applicant fills the form
 * before any account exists.
 */
const retailerOnboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  // ===== POST /applications — submit onboarding application (public) =====
  app.post(
    '/applications',
    {
      schema: {
        body: z.object({
          legalName: z.string().trim().min(2).max(120),
          storeName: z.string().trim().min(2).max(120).optional(),
          gstin: GstinSchema,
          pan: z.string().trim().toUpperCase().length(10).optional(),
          ownerName: z.string().trim().min(2).max(120),
          ownerEmail: EmailSchema,
          ownerPhone: PhoneSchema,
          addressLine: z.string().trim().min(5).max(300),
          pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
          stateCode: z.string().trim().regex(/^\d{2}$/, 'State code must be 2 digits'),
          lat: z.string().optional(),
          lng: z.string().optional(),
          hours: z.record(z.unknown()).optional(),
          categories: z.array(z.string()).optional(),
          brands: z.array(z.string()).optional(),
          sampleSkus: z.array(z.unknown()).optional(),
          bankLegalName: z.string().trim().max(200).optional(),
          bankAccountNumber: z.string().trim().max(20).optional(),
          bankIfsc: z.string().trim().toUpperCase().max(11).optional(),
          documents: z.array(z.object({
            kind: z.enum(['gst_certificate', 'pan', 'address_proof', 'bank_proof', 'storefront_photo', 'other']),
            url: z.string().url(),
          })).optional(),
          password: z.string().min(8).max(128).optional(),
        }),
      },
    },
    async (req) => {
      const id = newId('app');
      const passwordHash = req.body.password ? await hashPassword(req.body.password) : null;
      await db.insert(retailerApplications).values({
        id,
        legalName: req.body.legalName,
        storeName: req.body.storeName ?? null,
        gstin: req.body.gstin,
        pan: req.body.pan ?? null,
        ownerName: req.body.ownerName,
        ownerEmail: req.body.ownerEmail,
        ownerPhone: req.body.ownerPhone,
        addressLine: req.body.addressLine,
        pincode: req.body.pincode,
        stateCode: req.body.stateCode,
        lat: req.body.lat ?? null,
        lng: req.body.lng ?? null,
        hours: req.body.hours ?? null,
        categories: req.body.categories ?? null,
        brands: req.body.brands ?? null,
        sampleSkus: req.body.sampleSkus ?? null,
        bankLegalName: req.body.bankLegalName ?? null,
        bankAccountNumber: req.body.bankAccountNumber ?? null,
        bankIfsc: req.body.bankIfsc ?? null,
        passwordHash,
      });
      if (req.body.documents?.length) {
        await db.insert(applicationDocuments).values(
          req.body.documents.map((d) => ({
            id: newId('adoc'),
            applicationId: id,
            kind: d.kind,
            url: d.url,
          })),
        );
      }
      return ok({ id, status: 'pending', message: 'Application submitted successfully' });
    },
  );

  // ===== GET /applications/:id/status — public status check by applicant email =====
  app.get(
    '/applications/:id/status',
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ email: EmailSchema }),
      },
    },
    async (req) => {
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application || application.ownerEmail !== req.query.email) {
        throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      }
      return ok({
        id: application.id,
        status: application.status,
        submittedAt: application.submittedAt,
        decidedAt: application.decidedAt,
        decisionReason: application.decisionReason,
      });
    },
  );

  // ===== GET /applications/:id/messages — clarification thread for applicant =====
  app.get(
    '/applications/:id/messages',
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ email: EmailSchema }),
      },
    },
    async (req) => {
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application || application.ownerEmail !== req.query.email) {
        throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      }
      const messages = await db.query.applicationMessages.findMany({
        where: eq(applicationMessages.applicationId, application.id),
        orderBy: asc(applicationMessages.at),
      });
      return ok(messages);
    },
  );

  // ===== GET /retailer/application/messages — auth'd: messages for provisioned retailer's application =====
  app.get(
    '/application/messages',
    { preHandler: requireAuth('retailer') },
    async (req) => {
      const auth = getAuth(req);
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.provisionedRetailerAccountId, auth.sub),
      });
      if (!application) return ok([]);

      const msgs = await db.query.applicationMessages.findMany({
        where: eq(applicationMessages.applicationId, application.id),
        orderBy: asc(applicationMessages.at),
      });

      return ok(
        msgs.map((m) => ({
          id: m.id,
          applicationId: m.applicationId,
          authorKind: m.authorKind === 'applicant' ? 'retailer' : m.authorKind,
          authorLabel: m.authorKind === 'admin' ? 'ClosetX admin' : 'You',
          body: m.body,
          attachments: m.attachmentUrls ?? [],
          fieldKey: null as string | null,
          createdAt: m.at.toISOString(),
        })),
      );
    },
  );

  // ===== POST /applications/:id/messages — applicant replies =====
  app.post(
    '/applications/:id/messages',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          applicantEmail: EmailSchema,
          body: z.string().trim().min(1).max(2000),
          attachmentUrls: z.array(z.string().url()).optional(),
        }),
      },
    },
    async (req) => {
      const application = await db.query.retailerApplications.findFirst({
        where: eq(retailerApplications.id, req.params.id),
      });
      if (!application || application.ownerEmail !== req.body.applicantEmail) {
        throw new AppError(404, ErrorCode.NotFound, 'Application not found');
      }
      const id = newId('amsg');
      await db.insert(applicationMessages).values({
        id,
        applicationId: application.id,
        authorKind: 'applicant',
        applicantEmail: req.body.applicantEmail,
        body: req.body.body,
        attachmentUrls: req.body.attachmentUrls ?? null,
      });
      return ok({ id });
    },
  );
};

export default retailerOnboardingRoutes;
