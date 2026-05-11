import { and, desc, eq, ilike, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { consumers, giftCards } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';

const ConsumerStatusEnum = z.enum(['active', 'suspended', 'closed']);

const safeConsumer = (c: typeof consumers.$inferSelect) => {
  const { passwordHash: _ph, ...rest } = c;
  return rest;
};

const adminConsumerManagementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/consumers — list with partial-match search + status filter =====
  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          q: z.string().trim().min(1).max(120).optional(),
          status: ConsumerStatusEnum.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      const { q, status, limit, offset } = req.query;
      const filters = [];
      if (q) {
        const needle = `%${q}%`;
        filters.push(
          or(ilike(consumers.name, needle), ilike(consumers.email, needle), ilike(consumers.phone, needle))!,
        );
      }
      if (status) filters.push(eq(consumers.status, status));
      const where =
        filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

      const rows = await db.query.consumers.findMany({
        ...(where && { where }),
        orderBy: desc(consumers.signupAt),
        limit,
        offset,
      });
      return ok(rows.map(safeConsumer));
    },
  );

  // ===== GET /admin/consumers/:id — full profile =====
  app.get(
    '/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const consumer = await db.query.consumers.findFirst({
        where: eq(consumers.id, req.params.id),
      });
      if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
      return ok(safeConsumer(consumer));
    },
  );

  // ===== POST /admin/consumers/:id/suspend =====
  app.post(
    '/:id/suspend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const consumer = await db.query.consumers.findFirst({
        where: eq(consumers.id, req.params.id),
      });
      if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
      if (consumer.status !== 'active') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot suspend consumer in '${consumer.status}' status`,
        );
      }
      const [updated] = await db
        .update(consumers)
        .set({ status: 'suspended' })
        .where(eq(consumers.id, consumer.id))
        .returning();
      req.log.info({ consumerId: consumer.id, reason: req.body.reason }, 'consumer suspended');
      return ok(safeConsumer(updated!));
    },
  );

  // ===== POST /admin/consumers/:id/unsuspend =====
  app.post(
    '/:id/unsuspend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.preprocess((v) => (v == null ? {} : v), z.object({ reason: z.string().trim().max(500).optional() })),
      },
    },
    async (req) => {
      const consumer = await db.query.consumers.findFirst({
        where: eq(consumers.id, req.params.id),
      });
      if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
      if (consumer.status !== 'suspended') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Consumer is not suspended (current status: '${consumer.status}')`,
        );
      }
      const [updated] = await db
        .update(consumers)
        .set({ status: 'active' })
        .where(eq(consumers.id, consumer.id))
        .returning();
      req.log.info({ consumerId: consumer.id, reason: req.body?.reason }, 'consumer unsuspended');
      return ok(safeConsumer(updated!));
    },
  );

  // ===== POST /admin/consumers/:id/close =====
  // Irreversible. Sets status to 'closed'. Consumer retains their data (GDPR purge is a
  // separate scrub action — not in MVP). Use with caution.
  app.post(
    '/:id/close',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const consumer = await db.query.consumers.findFirst({
        where: eq(consumers.id, req.params.id),
      });
      if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
      if (consumer.status === 'closed') {
        throw new AppError(409, ErrorCode.InvalidState, 'Consumer account is already closed');
      }
      const [updated] = await db
        .update(consumers)
        .set({ status: 'closed' })
        .where(eq(consumers.id, consumer.id))
        .returning();
      req.log.info({ consumerId: consumer.id, reason: req.body.reason }, 'consumer account closed');
      return ok(safeConsumer(updated!));
    },
  );
  // ===== GET /admin/consumers/:id/gift-cards =====
  app.get(
    '/:id/gift-cards',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const cards = await db.query.giftCards.findMany({
        where: eq(giftCards.consumerId, req.params.id),
        orderBy: desc(giftCards.createdAt),
      });
      const totalPaise = cards.reduce((sum, c) => sum + c.balancePaise, 0);
      return ok({
        totalPaise,
        cards: cards.map((c) => ({
          id: c.id,
          code: c.code,
          balancePaise: c.balancePaise,
          expiresOn: c.expiresOn,
        })),
      });
    },
  );
};

export default adminConsumerManagementRoutes;
