import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  aiCatalogSubmissions,
  productListings,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

// Quota constants (configurable per-store in a future iteration)
const MONTHLY_QUOTA = 50;

const aiCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/ai-catalog — submissions list =====
  app.get(
    '/ai-catalog',
    {
      schema: {
        querystring: z.object({
          status: z
            .enum(['submitted', 'processing', 'ready_for_review', 'accepted', 'rejected', 'regenerating', 'failed'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      const conditions = [eq(aiCatalogSubmissions.storeId, store.id)];
      if (req.query.status) conditions.push(eq(aiCatalogSubmissions.status, req.query.status));
      const rows = await db.query.aiCatalogSubmissions.findMany({
        where: and(...conditions),
        orderBy: desc(aiCatalogSubmissions.at),
        limit: req.query.limit,
      });
      return ok(rows);
    },
  );

  // ===== GET /retailer/ai-catalog/quota =====
  app.get('/ai-catalog/quota', async (req) => {
    const auth = getAuth(req);
    const store = await loadStore(auth.sub);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { gte, count } = await import('drizzle-orm');
    const [result] = await db
      .select({ used: count() })
      .from(aiCatalogSubmissions)
      .where(and(eq(aiCatalogSubmissions.storeId, store.id), gte(aiCatalogSubmissions.at, startOfMonth)));

    const used = result?.used ?? 0;
    return ok({ used, total: MONTHLY_QUOTA, remaining: Math.max(0, MONTHLY_QUOTA - used) });
  });

  // ===== GET /retailer/ai-catalog/:id =====
  app.get(
    '/ai-catalog/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);
      const sub = await db.query.aiCatalogSubmissions.findFirst({
        where: and(
          eq(aiCatalogSubmissions.id, req.params.id),
          eq(aiCatalogSubmissions.storeId, store.id),
        ),
      });
      if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
      return ok(sub);
    },
  );

  // ===== POST /retailer/ai-catalog — create submission =====
  app.post(
    '/ai-catalog',
    {
      schema: {
        body: z.object({
          listingId: z.string().optional(),
          mode: z.enum(['without_model', 'with_model']),
          rawPhotos: z.array(z.string().url()).min(1).max(10),
          posePreferences: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);

      if (req.body.listingId) {
        const listing = await db.query.productListings.findFirst({
          where: and(
            eq(productListings.id, req.body.listingId),
            eq(productListings.storeId, store.id),
          ),
        });
        if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
      }

      const id = newId('aic');
      await db.insert(aiCatalogSubmissions).values({
        id,
        storeId: store.id,
        listingId: req.body.listingId ?? null,
        mode: req.body.mode,
        rawPhotos: req.body.rawPhotos,
        outputUrls: [],
        status: 'submitted',
      });

      return ok({ id, status: 'submitted' });
    },
  );

  // ===== POST /retailer/ai-catalog/:id/accept — accept all outputs and attach to listing =====
  app.post(
    '/ai-catalog/:id/accept',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          selectedUrls: z.array(z.string().url()).min(1),
          listingId: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);

      const sub = await db.query.aiCatalogSubmissions.findFirst({
        where: and(
          eq(aiCatalogSubmissions.id, req.params.id),
          eq(aiCatalogSubmissions.storeId, store.id),
        ),
      });
      if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
      if (sub.status !== 'ready_for_review') {
        throw new AppError(409, ErrorCode.InvalidState, 'Submission not ready for review');
      }

      await db
        .update(aiCatalogSubmissions)
        .set({ status: 'accepted' })
        .where(eq(aiCatalogSubmissions.id, sub.id));

      // Attach selected URLs to listing gallery if listingId provided
      const targetListingId = req.body.listingId ?? sub.listingId;
      if (targetListingId) {
        const listing = await db.query.productListings.findFirst({
          where: and(eq(productListings.id, targetListingId), eq(productListings.storeId, store.id)),
        });
        if (listing) {
          const merged = [...new Set([...(listing.galleryUrls ?? []), ...req.body.selectedUrls])];
          await db
            .update(productListings)
            .set({ galleryUrls: merged })
            .where(eq(productListings.id, listing.id));
        }
      }

      return ok({ id: sub.id, status: 'accepted' });
    },
  );

  // ===== POST /retailer/ai-catalog/:id/reject =====
  app.post(
    '/ai-catalog/:id/reject',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const store = await loadStore(auth.sub);

      const sub = await db.query.aiCatalogSubmissions.findFirst({
        where: and(
          eq(aiCatalogSubmissions.id, req.params.id),
          eq(aiCatalogSubmissions.storeId, store.id),
        ),
      });
      if (!sub) throw new AppError(404, ErrorCode.NotFound, 'Submission not found');
      if (sub.status !== 'ready_for_review') {
        throw new AppError(409, ErrorCode.InvalidState, 'Submission not ready for review');
      }

      await db
        .update(aiCatalogSubmissions)
        .set({ status: 'rejected' })
        .where(eq(aiCatalogSubmissions.id, sub.id));

      return ok({ id: sub.id, status: 'rejected' });
    },
  );
};

export default aiCatalogRoutes;
