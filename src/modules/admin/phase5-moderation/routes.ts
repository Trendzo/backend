import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  listingAuditEntries,
  listingModerationAppeals,
  listingModerationFlags,
  productListings,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';

const adminModerationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/catalog/moderation — flagged listings queue =====
  app.get(
    '/catalog/moderation',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['open', 'under_appeal', 'resolved_taken_down', 'resolved_restored', 'resolved_dismissed']).optional(),
          source: z.enum(['automation', 'user_report', 'admin_review']).optional(),
          listingId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const { status, source, listingId, limit } = req.query;
      const conditions = [];
      if (status) conditions.push(eq(listingModerationFlags.status, status));
      if (source) conditions.push(eq(listingModerationFlags.source, source));
      if (listingId) conditions.push(eq(listingModerationFlags.listingId, listingId));

      const rows = await db.query.listingModerationFlags.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(listingModerationFlags.openedAt),
        limit,
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/catalog/moderation — flag a listing =====
  app.post(
    '/catalog/moderation',
    {
      schema: {
        body: z.object({
          listingId: z.string(),
          source: z.enum(['automation', 'user_report', 'admin_review']),
          reasonCode: z.string().trim().min(1).max(100),
          details: z.string().trim().max(2000).optional(),
          reportedByConsumerId: z.string().optional(),
          ruleKey: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const listing = await db.query.productListings.findFirst({
        where: eq(productListings.id, req.body.listingId),
      });
      if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

      const id = newId('flag');
      await db.insert(listingModerationFlags).values({
        id,
        listingId: listing.id,
        source: req.body.source,
        reasonCode: req.body.reasonCode,
        details: req.body.details ?? null,
        reportedByConsumerId: req.body.reportedByConsumerId ?? null,
        ruleKey: req.body.ruleKey ?? null,
        status: 'open',
      });
      return ok({ id });
    },
  );

  // ===== POST /admin/catalog/moderation/:id/resolve =====
  app.post(
    '/catalog/moderation/:id/resolve',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          outcome: z.enum(['resolved_taken_down', 'resolved_dismissed', 'resolved_restored']),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const flag = await db.query.listingModerationFlags.findFirst({
        where: eq(listingModerationFlags.id, req.params.id),
      });
      if (!flag) throw new AppError(404, ErrorCode.NotFound, 'Moderation flag not found');
      if (flag.status !== 'open' && flag.status !== 'under_appeal') {
        throw new AppError(409, ErrorCode.InvalidState, 'Flag already resolved');
      }
      const [updated] = await db
        .update(listingModerationFlags)
        .set({
          status: req.body.outcome,
          resolvedAt: new Date(),
          resolvedByAccountId: auth.sub,
          resolutionNote: req.body.note ?? null,
        })
        .where(eq(listingModerationFlags.id, flag.id))
        .returning();

      if (req.body.outcome === 'resolved_taken_down') {
        await db.insert(listingAuditEntries).values({
          id: newId('lae'),
          listingId: flag.listingId,
          action: 'takedown',
          actorKind: 'admin',
          actorId: auth.sub,
          note: req.body.note ?? null,
        });
        await db
          .update(productListings)
          .set({ status: 'draft' })
          .where(eq(productListings.id, flag.listingId));
      } else if (req.body.outcome === 'resolved_restored') {
        await db.insert(listingAuditEntries).values({
          id: newId('lae'),
          listingId: flag.listingId,
          action: 'restore',
          actorKind: 'admin',
          actorId: auth.sub,
          note: req.body.note ?? null,
        });
        await db
          .update(productListings)
          .set({ status: 'active' })
          .where(eq(productListings.id, flag.listingId));
      }

      await recordAudit({
        actor: auth,
        action: `moderation.${req.body.outcome}`,
        resourceKind: 'listing_moderation_flag',
        resourceId: flag.id,
        requestId: req.id,
      });
      return ok(updated);
    },
  );

  // ===== GET /admin/catalog/moderation/:id/appeals =====
  app.get(
    '/catalog/moderation/:id/appeals',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const rows = await db.query.listingModerationAppeals.findMany({
        where: eq(listingModerationAppeals.flagId, req.params.id),
        orderBy: (t, { desc }) => [desc(t.filedAt)],
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/catalog/moderation/:flagId/appeals/:id/decide =====
  app.post(
    '/catalog/moderation/:flagId/appeals/:id/decide',
    {
      schema: {
        params: z.object({ flagId: z.string(), id: z.string() }),
        body: z.object({
          outcome: z.enum(['upheld', 'denied']),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const appeal = await db.query.listingModerationAppeals.findFirst({
        where: and(
          eq(listingModerationAppeals.id, req.params.id),
          eq(listingModerationAppeals.flagId, req.params.flagId),
        ),
      });
      if (!appeal) throw new AppError(404, ErrorCode.NotFound, 'Appeal not found');
      if (appeal.decidedAt) throw new AppError(409, ErrorCode.InvalidState, 'Appeal already decided');

      const [updated] = await db
        .update(listingModerationAppeals)
        .set({
          outcome: req.body.outcome,
          decidedAt: new Date(),
          decidedByAccountId: auth.sub,
          decisionNote: req.body.note ?? null,
        })
        .where(eq(listingModerationAppeals.id, appeal.id))
        .returning();

      // Update flag status
      const flagStatus = req.body.outcome === 'upheld' ? 'resolved_taken_down' : 'resolved_dismissed';
      await db
        .update(listingModerationFlags)
        .set({ status: flagStatus, resolvedAt: new Date(), resolvedByAccountId: auth.sub })
        .where(eq(listingModerationFlags.id, req.params.flagId));

      return ok(updated);
    },
  );

  // ===== GET /admin/catalog/listings/:id/audit =====
  app.get(
    '/catalog/listings/:id/audit',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const rows = await db.query.listingAuditEntries.findMany({
        where: eq(listingAuditEntries.listingId, req.params.id),
        orderBy: (t, { desc }) => [desc(t.at)],
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/catalog/listings/:id/retire — retire platform-wide =====
  app.post(
    '/catalog/listings/:id/retire',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const listing = await db.query.productListings.findFirst({
        where: eq(productListings.id, req.params.id),
      });
      if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
      if (listing.status === 'retired') {
        throw new AppError(409, ErrorCode.InvalidState, 'Listing is already retired');
      }

      await db
        .update(productListings)
        .set({ status: 'retired' })
        .where(eq(productListings.id, listing.id));

      await db.insert(listingAuditEntries).values({
        id: newId('lae'),
        listingId: listing.id,
        action: 'retire',
        actorKind: 'admin',
        actorId: auth.sub,
        note: req.body.note ?? null,
      });

      await recordAudit({
        actor: auth,
        action: 'catalog.listing.retire',
        resourceKind: 'listing',
        resourceId: listing.id,
        requestId: req.id,
      });

      return ok({ id: listing.id, status: 'retired' });
    },
  );

  // ===== POST /admin/catalog/listings/:id/audit — record manual admin edit =====
  app.post(
    '/catalog/listings/:id/audit',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          action: z.enum(['edit', 'publish', 'unpublish', 'takedown', 'restore', 'retire']),
          before: z.record(z.unknown()).optional(),
          after: z.record(z.unknown()).optional(),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const id = newId('lae');
      await db.insert(listingAuditEntries).values({
        id,
        listingId: req.params.id,
        action: req.body.action,
        actorKind: 'admin',
        actorId: auth.sub,
        before: req.body.before ?? null,
        after: req.body.after ?? null,
        note: req.body.note ?? null,
      });
      return ok({ id });
    },
  );
};

export default adminModerationRoutes;
