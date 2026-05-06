import { and, asc, eq, lte, gte, or, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  collectionListings,
  collections,
  productListings,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';

const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend']);
const GenderEnum = z.enum(['her', 'him', 'unisex']);

/**
 * Public read-only catalog metadata. Retailer UIs read these to populate brand/category
 * dropdowns; consumer-facing browse uses richer endpoints (later phase).
 */
const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  // ===== GET /categories =====
  app.get(
    '/categories',
    {
      schema: {
querystring: z.object({
          gender: z.enum(['her', 'him', 'unisex']).optional(),
          activeOnly: z
            .enum(['true', 'false'])
            .default('true')
            .transform((v) => v === 'true'),
        }),
      },
    },
    async (req) => {
      const filters = [];
      if (req.query.gender) filters.push(eq(categories.gender, req.query.gender));
      if (req.query.activeOnly) filters.push(eq(categories.isActive, true));
      const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db.query.categories.findMany({
        ...(where && { where }),
        orderBy: [asc(categories.sortOrder), asc(categories.label)],
      });
      return ok(rows);
    },
  );

  // ===== GET /brands =====
  app.get(
    '/brands',
    {
      schema: {
querystring: z.object({
          activeOnly: z
            .enum(['true', 'false'])
            .default('true')
            .transform((v) => v === 'true'),
        }),
      },
    },
    async (req) => {
      const where = req.query.activeOnly ? eq(brands.isActive, true) : undefined;
      const rows = await db.query.brands.findMany({
        ...(where && { where }),
        orderBy: asc(brands.name),
      });
      return ok(rows);
    },
  );

  // ===== GET /collections — public list of *active* collections =====
  // Filtered by gender + kind for the consumer app's per-section rails ("Outfits for HER",
  // "Occasions for HIM"). Drafts and archived collections are never shown here.
  // Time-bounded collections (drops) are excluded outside their window.
  app.get(
    '/collections',
    {
      schema: {
        querystring: z.object({
          kind: CollectionKindEnum.optional(),
          gender: GenderEnum.optional(),
          featured: z.enum(['true', 'false']).optional().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined),
        }),
      },
    },
    async (req) => {
      const now = new Date();
      const filters = [eq(collections.status, 'active')];
      if (req.query.kind) filters.push(eq(collections.kind, req.query.kind));
      if (req.query.gender) {
        // For gender filter we want the requested gender + 'unisex' (an outfit
        // marked unisex shows up on both HER and HIM rails).
        filters.push(or(eq(collections.gender, req.query.gender), eq(collections.gender, 'unisex'))!);
      }
      if (req.query.featured !== undefined) filters.push(eq(collections.isFeatured, req.query.featured));
      // Time-window guard: hide collections whose drop window hasn't started or has ended.
      filters.push(or(isNull(collections.startsAt), lte(collections.startsAt, now))!);
      filters.push(or(isNull(collections.endsAt), gte(collections.endsAt, now))!);
      const rows = await db.query.collections.findMany({
        where: and(...filters),
        orderBy: [asc(collections.sortOrder), asc(collections.createdAt)],
      });
      return ok(rows);
    },
  );

  // ===== GET /collections/:slug — full collection with ordered listings =====
  // Slug rather than id so consumer-app deep links are readable. Returns 404 for
  // draft/archived collections (don't leak presentational queues).
  app.get(
    '/collections/:slug',
    {
      schema: {
        params: z.object({ slug: z.string() }),
      },
    },
    async (req) => {
      const c = await db.query.collections.findFirst({
        where: eq(collections.slug, req.params.slug),
      });
      if (!c || c.status !== 'active') {
        throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
      }
      const now = new Date();
      if (c.startsAt && c.startsAt > now) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
      if (c.endsAt && c.endsAt < now) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

      const memberships = await db
        .select({ listing: productListings, sortOrder: collectionListings.sortOrder })
        .from(collectionListings)
        .innerJoin(productListings, eq(productListings.id, collectionListings.listingId))
        .where(
          and(
            eq(collectionListings.collectionId, c.id),
            eq(productListings.status, 'active'),
          ),
        )
        .orderBy(asc(collectionListings.sortOrder));
      return ok({
        ...c,
        listings: memberships.map((m) => ({ ...m.listing, sortOrder: m.sortOrder })),
      });
    },
  );
};

export default catalogRoutes;
