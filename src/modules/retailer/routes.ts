import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  brands,
  categories,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import {
  PositivePaiseSchema,
  StateCodeSchema,
  StockSchema,
} from '@/shared/validation/common.js';

/**
 * Helper: load the authenticated retailer account, asserting its existence.
 * Used by every protected handler in this module.
 */
async function loadRetailer(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer) {
    throw AppError.unauthorized('Retailer account no longer exists');
  }
  return retailer;
}

/**
 * Helper: load the retailer's store via storeId on the account, asserting it exists. Used
 * for every operation that modifies a store / its listings / variants.
 */
async function loadOwnedStore(retailerStoreId: string | null) {
  if (!retailerStoreId) {
    throw new AppError(404, ErrorCode.NotFound, 'No store found — create one first');
  }
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailerStoreId),
  });
  if (!store) {
    throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  }
  return store;
}

/** Helper: assert that the retailer is approved AND their store is active before a mutation. */
/**
 * A variant's `imageUrls` must be drawn from its parent listing's gallery — Shopify-
 * style: one media library per product, each variant references a subset. Reject any
 * URL that isn't in the gallery rather than silently dropping it (silent drop hides
 * client bugs and confuses the retailer who expects what they sent to be saved).
 */
function assertSubsetOfGallery(picked: string[], gallery: string[]): void {
  const allowed = new Set(gallery);
  const stray = picked.filter((u) => !allowed.has(u));
  if (stray.length > 0) {
    throw new AppError(
      422,
      ErrorCode.ValidationError,
      `Variant images must come from the listing gallery — unknown URL: ${stray[0]!}`,
    );
  }
}

function assertCanPublish(retailerStatus: string, storeStatus: string): void {
  if (retailerStatus !== 'active') {
    throw new AppError(
      403,
      ErrorCode.RetailerNotApproved,
      'Your retailer account is not approved yet — wait for admin approval',
    );
  }
  if (storeStatus !== 'active') {
    throw new AppError(
      403,
      ErrorCode.StoreNotActive,
      `Your store is ${storeStatus}, must be 'active' to publish products`,
    );
  }
}

const retailerRoutes: FastifyPluginAsyncZod = async (app) => {
  // All routes here require a retailer token.
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /me — current retailer + store snapshot =====
  app.get(
    '/me',
    {},
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = retailer.storeId
        ? await db.query.retailerStores.findFirst({ where: eq(retailerStores.id, retailer.storeId) })
        : null;
      return ok({
        retailer: {
          id: retailer.id,
          email: retailer.email,
          legalName: retailer.legalName,
          phone: retailer.phone,
          gstin: retailer.gstin,
          status: retailer.status,
        },
        store: store
          ? {
              id: store.id,
              legalName: store.legalName,
              gstin: store.gstin,
              address: store.address,
              stateCode: store.stateCode,
              lat: store.lat,
              lng: store.lng,
              status: store.status,
              platformFeeBp: store.platformFeeBp,
              payoutCadenceDays: store.payoutCadenceDays,
            }
          : null,
      });
    },
  );

  // ===== POST /store — create the (single) store for this retailer =====
  app.post(
    '/store',
    {
      schema: {
body: z.object({
          legalName: z.string().trim().min(2).max(120),
          address: z.string().trim().min(5).max(500),
          stateCode: StateCodeSchema,
          lat: z.number().gte(-90).lte(90),
          lng: z.number().gte(-180).lte(180),
          openingHours: z
            .record(
              z.string(),
              z.array(
                z.object({
                  open: z.string().regex(/^\d{2}:\d{2}$/),
                  close: z.string().regex(/^\d{2}:\d{2}$/),
                }),
              ),
            )
            .optional(),
          // Platform fee AND payout cadence are admin-controlled — set when admin approves
          // the storefront, not by the retailer themselves. We insert sentinel zeros and
          // let POST /admin/stores/:id/approve overwrite them on transition to active.
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);

      if (retailer.storeId) {
        throw new AppError(
          409,
          ErrorCode.StoreAlreadyExists,
          'This account already owns a store — only one store per retailer in MVP',
        );
      }

      const id = newId(IdPrefix.Store);
      const body = req.body;

      // Insert store + link account in a single transaction so we never end up with
      // an orphaned store row.
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(retailerStores)
          .values({
            id,
            legalEntityId: retailer.id, // MVP: account.id doubles as legal entity id
            legalName: body.legalName,
            gstin: retailer.gstin, // copied from retailer's verified GSTIN
            address: body.address,
            stateCode: body.stateCode,
            lat: body.lat,
            lng: body.lng,
            ...(body.openingHours !== undefined && { openingHours: body.openingHours }),
            status: 'onboarding',
            platformFeeBp: 0, // sentinel — admin sets at approve-time
            payoutCadenceDays: 0, // sentinel — admin sets at approve-time

          })
          .returning();
        if (!row) throw AppError.internal('store insert returned no row');

        await tx
          .update(retailerAccounts)
          .set({ storeId: id })
          .where(eq(retailerAccounts.id, retailer.id));

        return row;
      });

      return ok({
        id: created.id,
        legalName: created.legalName,
        gstin: created.gstin,
        address: created.address,
        stateCode: created.stateCode,
        lat: created.lat,
        lng: created.lng,
        status: created.status,
        platformFeeBp: created.platformFeeBp,
        payoutCadenceDays: created.payoutCadenceDays,
      });
    },
  );

  // ===== POST /listings — create a product listing =====
  app.post(
    '/listings',
    {
      schema: {
body: z.object({
          name: z.string().trim().min(1).max(200),
          description: z.string().trim().max(5_000).optional(),
          brandId: z.string().min(1),
          categoryId: z.string().min(1),
          gender: z.enum(['her', 'him', 'unisex']),
          badge: z.enum(['new', 'hot', 'trending', 'none']).default('none'),
          listingPolicy: z.enum(['return', 'replace', 'final_sale']).default('return'),
          galleryUrls: z.array(z.string().url()).default([]),
          hsn: z.string().trim().max(8).optional(),
          // No `status` on create — listings always start as `draft`. Publishing
          // (status='active') happens via PATCH after at least one variant and one
          // gallery image exist.
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);
      assertCanPublish(retailer.status, store.status);

      const body = req.body;

      // FK existence checks — friendlier than waiting for the DB FK to error.
      const [brand, category] = await Promise.all([
        db.query.brands.findFirst({ where: eq(brands.id, body.brandId) }),
        db.query.categories.findFirst({ where: eq(categories.id, body.categoryId) }),
      ]);
      if (!brand) throw new AppError(404, ErrorCode.NotFound, `Brand ${body.brandId} not found`);
      if (!category) throw new AppError(404, ErrorCode.NotFound, `Category ${body.categoryId} not found`);

      const id = newId(IdPrefix.Listing);
      const [created] = await db
        .insert(productListings)
        .values({
          id,
          storeId: store.id,
          brandId: body.brandId,
          categoryId: body.categoryId,
          name: body.name,
          ...(body.description !== undefined && { description: body.description }),
          ...(body.hsn !== undefined && { hsn: body.hsn }),
          gender: body.gender,
          badge: body.badge,
          listingPolicy: body.listingPolicy,
          galleryUrls: body.galleryUrls,
          status: 'draft',
        })
        .returning();
      if (!created) throw AppError.internal('listing insert returned no row');

      return ok(created);
    },
  );

  // ===== GET /listings — list this store's product listings =====
  app.get(
    '/listings',
    {
      schema: {
querystring: z.object({
          status: z.enum(['draft', 'active', 'retired']).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const where = req.query.status
        ? and(eq(productListings.storeId, store.id), eq(productListings.status, req.query.status))
        : eq(productListings.storeId, store.id);

      const rows = await db.query.productListings.findMany({
        where,
        with: { variants: true, brand: true, category: true },
      });
      return ok(rows);
    },
  );

  // ===== PATCH /listings/:id — update name/description/badge/policy/status/etc. =====
  app.patch(
    '/listings/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            description: z.string().trim().max(5_000).optional(),
            brandId: z.string().min(1).optional(),
            categoryId: z.string().min(1).optional(),
            gender: z.enum(['her', 'him', 'unisex']).optional(),
            badge: z.enum(['new', 'hot', 'trending', 'none']).optional(),
            listingPolicy: z.enum(['return', 'replace', 'final_sale']).optional(),
            galleryUrls: z.array(z.string().url()).optional(),
            hsn: z.string().trim().max(8).optional(),
            status: z.enum(['draft', 'active', 'retired']).optional(),
          })
          .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const existing = await db.query.productListings.findFirst({
        where: eq(productListings.id, req.params.id),
      });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
      if (existing.storeId !== store.id) {
        throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
      }

      const body = req.body;

      // Optional FK existence checks
      if (body.brandId) {
        const brand = await db.query.brands.findFirst({ where: eq(brands.id, body.brandId) });
        if (!brand) throw new AppError(404, ErrorCode.NotFound, `Brand ${body.brandId} not found`);
      }
      if (body.categoryId) {
        const cat = await db.query.categories.findFirst({ where: eq(categories.id, body.categoryId) });
        if (!cat) throw new AppError(404, ErrorCode.NotFound, `Category ${body.categoryId} not found`);
      }

      // Status transition guard: can't activate a listing on a non-active store.
      if (body.status === 'active') {
        assertCanPublish(retailer.status, store.status);

        // Catalog quality bar: a published listing must have at least one variant
        // (so price + stock exist) and at least one gallery image. Effective gallery
        // is the patched value if provided, else the existing one — same for "we
        // already had variants before this PATCH" check.
        const effectiveGallery = body.galleryUrls ?? existing.galleryUrls;
        const variantCount = await db.$count(variants, eq(variants.listingId, existing.id));
        const missing: string[] = [];
        if (variantCount < 1) missing.push('at least one variant (size/colour with price and stock)');
        if (effectiveGallery.length < 1) missing.push('at least one gallery image');
        if (missing.length > 0) {
          throw new AppError(
            409,
            ErrorCode.CannotPublishIncomplete,
            `Cannot publish — needs ${missing.join(' and ')}.`,
          );
        }
      }

      // If galleryUrls shrank, every variant that referenced a now-removed URL needs
      // its imageUrls pruned in the same transaction — otherwise the consumer card
      // render would 404 on a stale URL. (We do not warn the retailer; in the dashboard
      // the picker already shows the live gallery, so picks are tied to current URLs.)
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(productListings)
          .set(compact(body))
          .where(eq(productListings.id, existing.id))
          .returning();
        if (body.galleryUrls !== undefined) {
          const allowed = new Set(body.galleryUrls);
          const childVariants = await tx.query.variants.findMany({
            where: eq(variants.listingId, existing.id),
          });
          for (const v of childVariants) {
            const pruned = v.imageUrls.filter((u) => allowed.has(u));
            if (pruned.length !== v.imageUrls.length) {
              await tx.update(variants).set({ imageUrls: pruned }).where(eq(variants.id, v.id));
            }
          }
        }
        return row;
      });
      return ok(updated);
    },
  );

  // ===== POST /listings/:listingId/variants — create a variant =====
  app.post(
    '/listings/:listingId/variants',
    {
      schema: {
params: z.object({ listingId: z.string() }),
        body: z.object({
          attributes: z.record(z.string(), z.string()),
          attributesLabel: z.string().trim().min(1).max(120),
          sku: z.string().trim().min(1).max(64).optional(),
          pricePaise: PositivePaiseSchema,
          stock: StockSchema.default(0),
          imageUrls: z.array(z.string().url()).default([]),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const listing = await db.query.productListings.findFirst({
        where: eq(productListings.id, req.params.listingId),
      });
      if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
      if (listing.storeId !== store.id) {
        throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
      }

      // Variant images must be drawn from the listing's media library — the dashboard
      // shows the gallery as a picker rather than a second upload zone, but the API is
      // also a public surface, so re-validate.
      assertSubsetOfGallery(req.body.imageUrls, listing.galleryUrls);

      const id = newId(IdPrefix.Variant);
      try {
        const [created] = await db
          .insert(variants)
          .values({
            id,
            listingId: listing.id,
            attributes: req.body.attributes,
            attributesLabel: req.body.attributesLabel,
            ...(req.body.sku !== undefined && { sku: req.body.sku }),
            pricePaise: req.body.pricePaise,
            stock: req.body.stock,
            imageUrls: req.body.imageUrls,
            reserved: 0,
          })
          .returning();
        return ok(created);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') {
          throw new AppError(
            409,
            ErrorCode.SkuTaken,
            `SKU '${req.body.sku ?? '?'}' already exists on this listing`,
          );
        }
        throw err;
      }
    },
  );

  // ===== GET /listings/:listingId/variants — list variants for a listing =====
  app.get(
    '/listings/:listingId/variants',
    {
      schema: {
params: z.object({ listingId: z.string() }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const listing = await db.query.productListings.findFirst({
        where: eq(productListings.id, req.params.listingId),
      });
      if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
      if (listing.storeId !== store.id) {
        throw new AppError(403, ErrorCode.NotOwner, 'You do not own this listing');
      }

      const rows = await db.query.variants.findMany({
        where: eq(variants.listingId, listing.id),
      });
      return ok(rows);
    },
  );

  // ===== PATCH /variants/:id — update price / stock / sku / attributes =====
  app.patch(
    '/variants/:id',
    {
      schema: {
params: z.object({ id: z.string() }),
        body: z
          .object({
            attributes: z.record(z.string(), z.string()).optional(),
            attributesLabel: z.string().trim().min(1).max(120).optional(),
            sku: z.string().trim().min(1).max(64).nullable().optional(),
            pricePaise: PositivePaiseSchema.optional(),
            stock: StockSchema.optional(),
            imageUrls: z.array(z.string().url()).optional(),
          })
          .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const retailer = await loadRetailer(auth.sub);
      const store = await loadOwnedStore(retailer.storeId);

      const existing = await db.query.variants.findFirst({
        where: eq(variants.id, req.params.id),
        with: { listing: true },
      });
      if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');
      if (existing.listing.storeId !== store.id) {
        throw new AppError(403, ErrorCode.NotOwner, 'You do not own this variant');
      }

      // CHECK constraint guards: stock >= reserved. We cannot lower stock below current reserved.
      if (req.body.stock !== undefined && req.body.stock < existing.reserved) {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `Cannot set stock below currently reserved (${existing.reserved})`,
        );
      }
      if (req.body.imageUrls !== undefined) {
        assertSubsetOfGallery(req.body.imageUrls, existing.listing.galleryUrls);
      }

      try {
        const [updated] = await db
          .update(variants)
          .set(compact(req.body))
          .where(eq(variants.id, existing.id))
          .returning();
        return ok(updated);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') {
          throw new AppError(
            409,
            ErrorCode.SkuTaken,
            `SKU '${req.body.sku ?? '?'}' already exists on this listing`,
          );
        }
        throw err;
      }
    },
  );

  // ===== POST /brands — retailers can register their own brand =====
  app.post(
    '/brands',
    {
      schema: {
body: z.object({
          slug: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase, hyphen-separated'),
          name: z.string().trim().min(1).max(120),
          tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          logoUrl: z.string().url().optional(),
          domain: z.string().url().optional(),
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
          })
          .returning();
        return ok(created);
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505') {
          if (e.constraint === 'brands_name_lower_idx') {
            throw new AppError(
              409,
              ErrorCode.InvalidState,
              `A brand named '${req.body.name}' already exists (matched case-insensitively).`,
            );
          }
          throw new AppError(409, ErrorCode.InvalidState, `Brand slug '${req.body.slug}' already exists`);
        }
        throw err;
      }
    },
  );
};

export default retailerRoutes;
