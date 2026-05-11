import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  collectionListings,
  collections,
  productListings,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';

const RetailerStatusFilter = z.enum(['pending_approval', 'active', 'deactivated']);
const StoreStatusFilter = z.enum(['onboarding', 'active', 'paused', 'suspended', 'terminated']);
const CollectionKindEnum = z.enum(['outfit', 'occasion', 'drop', 'edit', 'trend']);
const CollectionStatusEnum = z.enum(['draft', 'active', 'archived']);
const GenderEnum = z.enum(['her', 'him', 'unisex']);

/** URL-safe slug. Lowercase, digits, hyphens; must start with a letter or digit. */
const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters/digits/hyphens');

const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /retailers — list retailers (optionally filter by status) =====
  app.get(
    '/retailers',
    {
      schema: {
querystring: z.object({
          status: RetailerStatusFilter.optional(),
        }),
      },
    },
    async (req) => {
      const where = req.query.status
        ? eq(retailerAccounts.status, req.query.status)
        : undefined;
      const rows = await db.query.retailerAccounts.findMany({
        ...(where && { where }),
        orderBy: desc(retailerAccounts.createdAt),
      });
      // Strip password hash before returning
      const safe = rows.map(({ passwordHash: _ph, ...rest }) => rest);
      return ok(safe);
    },
  );

  // ===== POST /retailers/:id/approve =====
  app.post(
    '/retailers/:id/approve',
    {
      schema: {
params: z.object({ id: z.string() }),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, req.params.id),
      });
      if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
      if (retailer.status !== 'pending_approval') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Retailer is in '${retailer.status}', can only approve from 'pending_approval'`,
        );
      }
      const [updated] = await db
        .update(retailerAccounts)
        .set({ status: 'active' })
        .where(eq(retailerAccounts.id, retailer.id))
        .returning();
      const { passwordHash: _ph, ...safe } = updated!;
      return ok(safe);
    },
  );

  // ===== POST /retailers/:id/reject =====
  app.post(
    '/retailers/:id/reject',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, req.params.id),
      });
      if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
      if (retailer.status === 'deactivated') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          'Retailer is already deactivated',
        );
      }
      const [updated] = await db
        .update(retailerAccounts)
        .set({ status: 'deactivated' })
        .where(eq(retailerAccounts.id, retailer.id))
        .returning();
      const { passwordHash: _ph, ...safe } = updated!;
      // For MVP we don't persist the reason; log it so it shows up in request logs.
      req.log.info({ retailerId: retailer.id, reason: req.body.reason }, 'retailer rejected');
      return ok(safe);
    },
  );

  // ===== POST /retailers/:id/suspend — suspend retailer's store =====
  // Keeps the retailer account active (so they can login and see the notice) but
  // pauses fulfilment by setting the store to 'suspended'.
  app.post(
    '/retailers/:id/suspend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, req.params.id),
      });
      if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
      if (retailer.status !== 'active') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot suspend retailer in '${retailer.status}' status`,
        );
      }
      if (!retailer.storeId) {
        throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no associated store');
      }
      const currentStore = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, retailer.storeId),
      });
      if (currentStore?.status === 'suspended') {
        throw new AppError(409, ErrorCode.InvalidState, 'Store is already suspended');
      }
      const [updatedStore] = await db
        .update(retailerStores)
        .set({ status: 'suspended' })
        .where(eq(retailerStores.id, retailer.storeId))
        .returning();
      req.log.info({ retailerId: retailer.id, reason: req.body.reason }, 'retailer store suspended');
      const { passwordHash: _ph, ...safe } = retailer;
      return ok({ retailer: safe, store: updatedStore });
    },
  );

  // ===== POST /retailers/:id/unsuspend — lift suspension =====
  app.post(
    '/retailers/:id/unsuspend',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.preprocess((v) => (v == null ? {} : v), z.object({ reason: z.string().trim().max(500).optional() })),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, req.params.id),
      });
      if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
      if (!retailer.storeId) {
        throw new AppError(409, ErrorCode.InvalidState, 'Retailer has no associated store');
      }
      const store = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, retailer.storeId),
      });
      if (store?.status !== 'suspended') {
        throw new AppError(409, ErrorCode.InvalidState, 'Store is not currently suspended');
      }
      const [updatedStore] = await db
        .update(retailerStores)
        .set({ status: 'active' })
        .where(eq(retailerStores.id, retailer.storeId))
        .returning();
      req.log.info({ retailerId: retailer.id, reason: req.body?.reason }, 'retailer store unsuspended');
      const { passwordHash: _ph, ...safe } = retailer;
      return ok({ retailer: safe, store: updatedStore });
    },
  );

  // ===== POST /retailers/:id/terminate — permanently terminate retailer =====
  // Deactivates the retailer account and terminates the store. Irreversible.
  app.post(
    '/retailers/:id/terminate',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const retailer = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.id, req.params.id),
      });
      if (!retailer) throw new AppError(404, ErrorCode.NotFound, 'Retailer not found');
      if (retailer.status === 'deactivated') {
        throw new AppError(409, ErrorCode.InvalidState, 'Retailer is already deactivated');
      }
      await db.transaction(async (tx) => {
        await tx
          .update(retailerAccounts)
          .set({ status: 'deactivated' })
          .where(eq(retailerAccounts.id, retailer.id));
        if (retailer.storeId) {
          await tx
            .update(retailerStores)
            .set({ status: 'terminated' })
            .where(eq(retailerStores.id, retailer.storeId));
        }
      });
      req.log.info({ retailerId: retailer.id, reason: req.body.reason }, 'retailer terminated');
      return ok({ retailerId: retailer.id, terminated: true });
    },
  );

  // ===== GET /stores — list stores (optionally filter by status) =====
  // Includes a `retailer` summary on each row so the UI can disclose the cross-entity
  // approval gate ("can't approve store until retailer is active") before the admin clicks.
  app.get(
    '/stores',
    {
      schema: {
        querystring: z.object({
          status: StoreStatusFilter.optional(),
        }),
      },
    },
    async (req) => {
      const where = req.query.status
        ? eq(retailerStores.status, req.query.status)
        : undefined;
      const rows = await db.query.retailerStores.findMany({
        ...(where && { where }),
        orderBy: desc(retailerStores.createdAt),
        with: { accounts: { columns: { id: true, email: true, legalName: true, status: true } } },
      });
      // Surface the owning retailer (the lone account in MVP — sub-roles deferred) at
      // the top level so the admin UI can read `store.retailer.status` directly.
      const view = rows.map(({ accounts, ...store }) => ({
        ...store,
        retailer: accounts[0] ?? null,
      }));
      return ok(view);
    },
  );

  // ===== POST /stores/:id/approve =====
  // Admin sets the platform fee AND payout cadence here — this is the only point in the
  // lifecycle where these get written. Body is optional; falls back to 1500 bp (15%)
  // and 7 days so legacy smoke tests and admins who don't override the defaults still work.
  app.post(
    '/stores/:id/approve',
    {
      schema: {
        params: z.object({ id: z.string() }),
        // Fastify passes `null` as the body for empty POSTs (no content-type, no payload).
        // `preprocess` coerces null/undefined to `{}` so Zod parsing succeeds and the smoke
        // tests that fire `POST .../approve` with no body keep working.
        body: z.preprocess(
          (v) => (v == null ? {} : v),
          z.object({
            platformFeeBp: z.number().int().min(0).max(10_000).optional(),
            payoutCadenceDays: z.number().int().min(1).max(30).optional(),
          }),
        ),
      },
    },
    async (req) => {
      const platformFeeBp = req.body?.platformFeeBp ?? 1500;
      const payoutCadenceDays = req.body?.payoutCadenceDays ?? 7;
      const store = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, req.params.id),
      });
      if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
      if (store.status !== 'onboarding') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Store is in '${store.status}', can only approve from 'onboarding'`,
        );
      }

      // Cross-entity gate: a storefront's owning retailer must be approved first.
      // Without this, admin can wave through a store whose retailer is still in
      // `pending_approval` (or `deactivated`), which leaves the marketplace in an
      // inconsistent state.
      const owner = await db.query.retailerAccounts.findFirst({
        where: eq(retailerAccounts.storeId, store.id),
      });
      if (!owner) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          'Storefront has no owning retailer on file — investigate.',
        );
      }
      if (owner.status !== 'active') {
        throw new AppError(
          409,
          ErrorCode.RetailerNotApproved,
          `Approve the retailer (${owner.email}) before approving its storefront — currently '${owner.status}'.`,
        );
      }

      const [updated] = await db
        .update(retailerStores)
        .set({ status: 'active', platformFeeBp, payoutCadenceDays })
        .where(eq(retailerStores.id, store.id))
        .returning();
      return ok(updated);
    },
  );

  // ===== POST /stores/:id/reject =====
  app.post(
    '/stores/:id/reject',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    async (req) => {
      const store = await db.query.retailerStores.findFirst({
        where: eq(retailerStores.id, req.params.id),
      });
      if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
      if (store.status === 'terminated') {
        throw new AppError(409, ErrorCode.InvalidState, 'Store is already terminated');
      }
      const [updated] = await db
        .update(retailerStores)
        .set({ status: 'terminated' })
        .where(eq(retailerStores.id, store.id))
        .returning();
      req.log.info({ storeId: store.id, reason: req.body.reason }, 'store rejected');
      return ok(updated);
    },
  );

  // ====================================================================
  // Collections — admin-curated groupings of listings (outfits, drops…)
  // ====================================================================

  // ===== GET /collections — list with filters =====
  app.get(
    '/collections',
    {
      schema: {
        querystring: z.object({
          kind: CollectionKindEnum.optional(),
          gender: GenderEnum.optional(),
          status: CollectionStatusEnum.optional(),
          featured: z.enum(['true', 'false']).optional().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined),
        }),
      },
    },
    async (req) => {
      const filters = [];
      if (req.query.kind) filters.push(eq(collections.kind, req.query.kind));
      if (req.query.gender) filters.push(eq(collections.gender, req.query.gender));
      if (req.query.status) filters.push(eq(collections.status, req.query.status));
      if (req.query.featured !== undefined) filters.push(eq(collections.isFeatured, req.query.featured));
      const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db.query.collections.findMany({
        ...(where && { where }),
        orderBy: [asc(collections.sortOrder), desc(collections.createdAt)],
      });
      // Cheap listing-count rollup so the index page can show "12 products" without
      // shipping the full membership for every row. One query per page load is fine —
      // collections are dozens, not millions.
      const counts = rows.length === 0
        ? []
        : await db
            .select({
              collectionId: collectionListings.collectionId,
              count: sql<number>`cast(count(*) as int)`,
            })
            .from(collectionListings)
            .where(inArray(collectionListings.collectionId, rows.map((r) => r.id)))
            .groupBy(collectionListings.collectionId);
      const countMap = new Map(counts.map((c) => [c.collectionId, c.count]));
      return ok(rows.map((c) => ({ ...c, listingCount: countMap.get(c.id) ?? 0 })));
    },
  );

  // ===== POST /collections — create =====
  app.post(
    '/collections',
    {
      schema: {
        body: z.object({
          slug: SlugSchema,
          name: z.string().trim().min(1).max(120),
          kind: CollectionKindEnum,
          gender: GenderEnum.default('unisex'),
          description: z.string().trim().max(1000).optional(),
          heroImageUrl: z.string().url().optional(),
          accentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),
          sortOrder: z.number().int().default(0),
          isFeatured: z.boolean().default(false),
          status: CollectionStatusEnum.default('draft'),
          startsAt: z.string().datetime().optional(),
          endsAt: z.string().datetime().optional(),
        }).refine(
          (v) => !(v.startsAt && v.endsAt) || new Date(v.endsAt) > new Date(v.startsAt),
          { message: 'endsAt must be after startsAt', path: ['endsAt'] },
        ),
      },
    },
    async (req) => {
      const id = newId(IdPrefix.Collection);
      try {
        const [created] = await db
          .insert(collections)
          .values({
            id,
            slug: req.body.slug,
            name: req.body.name,
            kind: req.body.kind,
            gender: req.body.gender,
            ...(req.body.description !== undefined && { description: req.body.description }),
            ...(req.body.heroImageUrl !== undefined && { heroImageUrl: req.body.heroImageUrl }),
            accentColors: req.body.accentColors,
            sortOrder: req.body.sortOrder,
            isFeatured: req.body.isFeatured,
            status: req.body.status,
            ...(req.body.startsAt && { startsAt: new Date(req.body.startsAt) }),
            ...(req.body.endsAt && { endsAt: new Date(req.body.endsAt) }),
          })
          .returning();
        return ok(created);
      } catch (err) {
        // collections_slug_idx is UNIQUE — surface as a clean 409 instead of bubbling
        // the raw "duplicate key" Postgres error to the admin.
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, ErrorCode.InvalidState, `Slug '${req.body.slug}' is already taken`);
        }
        throw err;
      }
    },
  );

  // ===== GET /collections/:id — full detail with ordered listings =====
  app.get(
    '/collections/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
      },
    },
    async (req) => {
      const c = await db.query.collections.findFirst({
        where: eq(collections.id, req.params.id),
      });
      if (!c) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
      const memberships = await db
        .select({
          listingId: collectionListings.listingId,
          sortOrder: collectionListings.sortOrder,
          listing: productListings,
        })
        .from(collectionListings)
        .innerJoin(productListings, eq(productListings.id, collectionListings.listingId))
        .where(eq(collectionListings.collectionId, c.id))
        .orderBy(asc(collectionListings.sortOrder));
      return ok({
        ...c,
        listings: memberships.map((m) => ({ ...m.listing, sortOrder: m.sortOrder })),
      });
    },
  );

  // ===== PATCH /collections/:id — partial edit =====
  app.patch(
    '/collections/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({
          slug: SlugSchema.optional(),
          name: z.string().trim().min(1).max(120).optional(),
          kind: CollectionKindEnum.optional(),
          gender: GenderEnum.optional(),
          description: z.string().trim().max(1000).nullable().optional(),
          heroImageUrl: z.string().url().nullable().optional(),
          accentColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).optional(),
          sortOrder: z.number().int().optional(),
          isFeatured: z.boolean().optional(),
          status: CollectionStatusEnum.optional(),
          startsAt: z.string().datetime().nullable().optional(),
          endsAt: z.string().datetime().nullable().optional(),
        }).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      },
    },
    async (req) => {
      const existing = await db.query.collections.findFirst({
        where: eq(collections.id, req.params.id),
      });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

      const effectiveStart = req.body.startsAt === undefined
        ? existing.startsAt
        : req.body.startsAt === null ? null : new Date(req.body.startsAt);
      const effectiveEnd = req.body.endsAt === undefined
        ? existing.endsAt
        : req.body.endsAt === null ? null : new Date(req.body.endsAt);
      if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) {
        throw new AppError(422, ErrorCode.ValidationError, 'endsAt must be after startsAt');
      }

      // Strip the ISO-string date fields from the spread before swapping in their
      // Date-typed equivalents — TS can't follow the override otherwise.
      const { startsAt: _sa, endsAt: _ea, ...rest } = req.body;
      const patch = compact({
        ...rest,
        ...(req.body.startsAt !== undefined && {
          startsAt: req.body.startsAt === null ? null : new Date(req.body.startsAt),
        }),
        ...(req.body.endsAt !== undefined && {
          endsAt: req.body.endsAt === null ? null : new Date(req.body.endsAt),
        }),
      });

      try {
        const [updated] = await db
          .update(collections)
          .set(patch)
          .where(eq(collections.id, existing.id))
          .returning();
        return ok(updated);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, ErrorCode.InvalidState, `Slug '${req.body.slug}' is already taken`);
        }
        throw err;
      }
    },
  );

  // ===== DELETE /collections/:id — hard delete (cascades to memberships) =====
  // We do not keep tombstones for collections — they're presentational. Use
  // status='archived' if you want it hidden but auditable; DELETE is the harder option.
  app.delete(
    '/collections/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
      },
    },
    async (req) => {
      const existing = await db.query.collections.findFirst({
        where: eq(collections.id, req.params.id),
      });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
      await db.delete(collections).where(eq(collections.id, existing.id));
      return ok({ id: existing.id, deleted: true });
    },
  );

  // ===== PUT /collections/:id/listings — replace the membership set, in order =====
  // Single endpoint for set + reorder so the dashboard can save the picker / drag
  // result atomically. listingIds[i] gets sortOrder = i.
  app.put(
    '/collections/:id/listings',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({
          listingIds: z.array(z.string()).max(500),
        }),
      },
    },
    async (req) => {
      const c = await db.query.collections.findFirst({
        where: eq(collections.id, req.params.id),
      });
      if (!c) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

      const ids = req.body.listingIds;
      // Reject duplicates — composite PK would do it server-side, but a clean 422
      // beats a "duplicate key" surfacing as 500 for the dashboard.
      if (new Set(ids).size !== ids.length) {
        throw new AppError(422, ErrorCode.ValidationError, 'Duplicate listing IDs in payload');
      }
      // Validate every listing exists before nuking memberships — otherwise we'd
      // orphan a partial save on a typo.
      if (ids.length > 0) {
        const found = await db.query.productListings.findMany({
          where: inArray(productListings.id, ids),
          columns: { id: true },
        });
        if (found.length !== ids.length) {
          const foundSet = new Set(found.map((f) => f.id));
          const missing = ids.filter((id) => !foundSet.has(id));
          throw new AppError(404, ErrorCode.NotFound, `Listings not found: ${missing.join(', ')}`);
        }
      }

      await db.transaction(async (tx) => {
        await tx.delete(collectionListings).where(eq(collectionListings.collectionId, c.id));
        if (ids.length > 0) {
          await tx.insert(collectionListings).values(
            ids.map((listingId, i) => ({ collectionId: c.id, listingId, sortOrder: i })),
          );
        }
      });
      return ok({ collectionId: c.id, listingCount: ids.length });
    },
  );

  // ===== GET /listings — admin-side listing search for the collection picker =====
  // Public catalog browse will get its own gender/serviceability-aware endpoint later;
  // this one is intentionally simple: text + brand + category + status filters,
  // capped at 50, scoped to admin only.
  app.get(
    '/listings',
    {
      schema: {
        querystring: z.object({
          q: z.string().trim().min(1).max(80).optional(),
          brandId: z.string().optional(),
          categoryId: z.string().optional(),
          gender: GenderEnum.optional(),
          status: z.enum(['draft', 'active', 'retired']).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(25),
        }),
      },
    },
    async (req) => {
      const filters = [];
      if (req.query.q) {
        const needle = `%${req.query.q}%`;
        filters.push(or(ilike(productListings.name, needle), ilike(productListings.description, needle))!);
      }
      if (req.query.brandId) filters.push(eq(productListings.brandId, req.query.brandId));
      if (req.query.categoryId) filters.push(eq(productListings.categoryId, req.query.categoryId));
      if (req.query.gender) filters.push(eq(productListings.gender, req.query.gender));
      if (req.query.status) filters.push(eq(productListings.status, req.query.status));
      const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db.query.productListings.findMany({
        ...(where && { where }),
        orderBy: desc(productListings.createdAt),
        limit: req.query.limit,
      });
      return ok(rows);
    },
  );

  // ====================================================================
  // Categories — taxonomy with parent/child hierarchy
  // ====================================================================

  // ===== GET /categories — flat list, client builds the tree =====
  // We could return a pre-built tree, but the dashboard re-shuffles freely on
  // reparent and the client renderer needs the flat list anyway. Each row carries
  // a `listingCount` so the delete-confirm UI can warn the admin before they try.
  app.get(
    '/categories',
    {
      schema: {
        querystring: z.object({
          gender: GenderEnum.optional(),
          activeOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined),
        }),
      },
    },
    async (req) => {
      const filters = [];
      if (req.query.gender) filters.push(eq(categories.gender, req.query.gender));
      if (req.query.activeOnly !== undefined) filters.push(eq(categories.isActive, req.query.activeOnly));
      const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
      const rows = await db.query.categories.findMany({
        ...(where && { where }),
        orderBy: [asc(categories.sortOrder), asc(categories.label)],
      });
      const counts = rows.length === 0
        ? []
        : await db
            .select({ categoryId: productListings.categoryId, count: sql<number>`cast(count(*) as int)` })
            .from(productListings)
            .where(inArray(productListings.categoryId, rows.map((r) => r.id)))
            .groupBy(productListings.categoryId);
      const countMap = new Map(counts.map((c) => [c.categoryId, c.count]));
      return ok(rows.map((c) => ({ ...c, listingCount: countMap.get(c.id) ?? 0 })));
    },
  );

  // ===== POST /categories — create (optionally as a child) =====
  app.post(
    '/categories',
    {
      schema: {
        body: z.object({
          slug: SlugSchema,
          label: z.string().trim().min(1).max(120),
          parentId: z.string().nullable().optional(),
          gender: GenderEnum.default('unisex'),
          iconName: z.string().trim().max(60).optional(),
          tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          imageUrl: z.string().url().optional(),
          sortOrder: z.number().int().default(0),
          isActive: z.boolean().default(true),
        }),
      },
    },
    async (req) => {
      if (req.body.parentId) {
        const parent = await db.query.categories.findFirst({ where: eq(categories.id, req.body.parentId) });
        if (!parent) throw new AppError(404, ErrorCode.NotFound, 'Parent category not found');
      }
      const id = newId(IdPrefix.Category);
      try {
        const [created] = await db
          .insert(categories)
          .values({
            id,
            slug: req.body.slug,
            label: req.body.label,
            parentId: req.body.parentId ?? null,
            gender: req.body.gender,
            ...(req.body.iconName !== undefined && { iconName: req.body.iconName }),
            ...(req.body.tintColor !== undefined && { tintColor: req.body.tintColor }),
            ...(req.body.imageUrl !== undefined && { imageUrl: req.body.imageUrl }),
            sortOrder: req.body.sortOrder,
            isActive: req.body.isActive,
          })
          .returning();
        return ok(created);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, ErrorCode.InvalidState, `Slug '${req.body.slug}' is already taken`);
        }
        throw err;
      }
    },
  );

  // ===== PATCH /categories/:id — supports re-parenting =====
  app.patch(
    '/categories/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({
          slug: SlugSchema.optional(),
          label: z.string().trim().min(1).max(120).optional(),
          parentId: z.string().nullable().optional(),
          gender: GenderEnum.optional(),
          iconName: z.string().trim().max(60).nullable().optional(),
          tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
          imageUrl: z.string().url().nullable().optional(),
          sortOrder: z.number().int().optional(),
          isActive: z.boolean().optional(),
        }).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      },
    },
    async (req) => {
      const existing = await db.query.categories.findFirst({ where: eq(categories.id, req.params.id) });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Category not found');

      // Reparent guard — block the three failure modes:
      //   1. self-parent  (id == parentId)
      //   2. parent doesn't exist
      //   3. cycle: walking up the proposed parent's chain returns to this category
      if (req.body.parentId !== undefined && req.body.parentId !== existing.parentId) {
        if (req.body.parentId === existing.id) {
          throw new AppError(422, ErrorCode.ValidationError, 'A category cannot be its own parent.');
        }
        if (req.body.parentId !== null) {
          const targetParent = await db.query.categories.findFirst({
            where: eq(categories.id, req.body.parentId),
          });
          if (!targetParent) throw new AppError(404, ErrorCode.NotFound, 'New parent category not found');
          // Walk ancestry — refuse if we'd reach this category on the way up.
          let cursor: typeof targetParent | undefined = targetParent;
          const visited = new Set<string>();
          while (cursor) {
            if (cursor.id === existing.id) {
              throw new AppError(422, ErrorCode.ValidationError, 'Re-parenting would create a cycle.');
            }
            if (visited.has(cursor.id)) break; // defensive — shouldn't happen
            visited.add(cursor.id);
            if (!cursor.parentId) break;
            cursor = await db.query.categories.findFirst({ where: eq(categories.id, cursor.parentId) });
          }
        }
      }

      try {
        const [updated] = await db
          .update(categories)
          .set(compact(req.body))
          .where(eq(categories.id, existing.id))
          .returning();
        return ok(updated);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, ErrorCode.InvalidState, `Slug '${req.body.slug}' is already taken`);
        }
        throw err;
      }
    },
  );

  // ===== DELETE /categories/:id =====
  // Categories are stronger taxonomy than brands — every listing must have one for
  // the consumer-app browse to work. So we block deletion if (a) it has children
  // (force leaf-first) or (b) it has listings (force the retailer to re-categorise).
  // The error includes the count so the dashboard can show a useful confirm dialog.
  app.delete(
    '/categories/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
      },
    },
    async (req) => {
      const existing = await db.query.categories.findFirst({ where: eq(categories.id, req.params.id) });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Category not found');

      const childCount = await db.$count(categories, eq(categories.parentId, existing.id));
      if (childCount > 0) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot delete — category has ${childCount} sub-categor${childCount === 1 ? 'y' : 'ies'}. Delete or re-parent them first.`,
        );
      }
      const listingCount = await db.$count(productListings, eq(productListings.categoryId, existing.id));
      if (listingCount > 0) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot delete — ${listingCount} listing${listingCount === 1 ? '' : 's'} still reference this category. Re-categorise them first.`,
        );
      }

      await db.delete(categories).where(eq(categories.id, existing.id));
      return ok({ id: existing.id, deleted: true });
    },
  );

  // ====================================================================
  // Brands — admin owns the canonical list; retailers can self-serve adds
  // ====================================================================

  // ===== GET /brands — list with listing counts =====
  app.get(
    '/brands',
    {
      schema: {
        querystring: z.object({
          activeOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true' ? true : v === 'false' ? false : undefined),
        }),
      },
    },
    async (req) => {
      const where = req.query.activeOnly !== undefined ? eq(brands.isActive, req.query.activeOnly) : undefined;
      const rows = await db.query.brands.findMany({
        ...(where && { where }),
        orderBy: asc(brands.name),
      });
      const counts = rows.length === 0
        ? []
        : await db
            .select({ brandId: productListings.brandId, count: sql<number>`cast(count(*) as int)` })
            .from(productListings)
            .where(inArray(productListings.brandId, rows.map((r) => r.id)))
            .groupBy(productListings.brandId);
      const countMap = new Map(counts.map((c) => [c.brandId, c.count]));
      return ok(rows.map((b) => ({ ...b, listingCount: countMap.get(b.id) ?? 0 })));
    },
  );

  // ===== POST /brands — admin-side brand create =====
  app.post(
    '/brands',
    {
      schema: {
        body: z.object({
          slug: SlugSchema,
          name: z.string().trim().min(1).max(120),
          tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          logoUrl: z.string().url().optional(),
          domain: z.string().url().optional(),
          isActive: z.boolean().default(true),
        }),
      },
    },
    async (req) => {
      const id = newId(IdPrefix.Brand);
      try {
        const [created] = await db
          .insert(brands)
          .values({
            id,
            slug: req.body.slug,
            name: req.body.name,
            ...(req.body.tintColor !== undefined && { tintColor: req.body.tintColor }),
            ...(req.body.logoUrl !== undefined && { logoUrl: req.body.logoUrl }),
            ...(req.body.domain !== undefined && { domain: req.body.domain }),
            isActive: req.body.isActive,
          })
          .returning();
        return ok(created);
      } catch (err) {
        translateBrandUniqueViolation(err, req.body.slug, req.body.name);
        throw err;
      }
    },
  );

  // ===== PATCH /brands/:id =====
  app.patch(
    '/brands/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z.object({
          slug: SlugSchema.optional(),
          name: z.string().trim().min(1).max(120).optional(),
          tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
          logoUrl: z.string().url().nullable().optional(),
          domain: z.string().url().nullable().optional(),
          isActive: z.boolean().optional(),
        }).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      },
    },
    async (req) => {
      const existing = await db.query.brands.findFirst({ where: eq(brands.id, req.params.id) });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Brand not found');
      try {
        const [updated] = await db
          .update(brands)
          .set(compact(req.body))
          .where(eq(brands.id, existing.id))
          .returning();
        return ok(updated);
      } catch (err) {
        translateBrandUniqueViolation(err, req.body.slug, req.body.name);
        throw err;
      }
    },
  );

  // ===== DELETE /brands/:id =====
  // The FK on product_listings.brand_id is ON DELETE SET NULL — listings stay
  // visible/published, just unbranded. The response carries the affected count so
  // the dashboard can show "12 listings became unbranded" after the delete.
  app.delete(
    '/brands/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
      },
    },
    async (req) => {
      const existing = await db.query.brands.findFirst({ where: eq(brands.id, req.params.id) });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Brand not found');
      const orphanCount = await db.$count(productListings, eq(productListings.brandId, existing.id));
      await db.delete(brands).where(eq(brands.id, existing.id));
      return ok({ id: existing.id, deleted: true, listingsUnbranded: orphanCount });
    },
  );
};

/**
 * Map Postgres unique-violation errors on the brands table back to a friendly
 * message. Cheaper than two pre-flight SELECTs and races safely.
 */
function translateBrandUniqueViolation(err: unknown, slug?: string, name?: string): void {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return;
  if (e.constraint === 'brands_slug_idx') {
    throw new AppError(409, ErrorCode.InvalidState, `Brand slug '${slug ?? '?'}' already exists`);
  }
  if (e.constraint === 'brands_name_lower_idx') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A brand named '${name ?? '?'}' already exists (matched case-insensitively).`,
    );
  }
  throw new AppError(409, ErrorCode.InvalidState, 'Brand uniqueness violation');
}

export default adminRoutes;
