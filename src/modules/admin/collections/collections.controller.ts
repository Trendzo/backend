/**
 * Admin collections (curated listings) + admin-side listing search.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { brands, collectionListings, collections, productListings } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import type {
  CreateBody,
  ListingsBody,
  ListingsSearchQuery,
  ListQuery,
  PatchBody,
} from './collections.validators.js';

export async function listCollections(input: { query: z.infer<typeof ListQuery> }) {
  const filters = [];
  if (input.query.kind) filters.push(eq(collections.kind, input.query.kind));
  if (input.query.gender) filters.push(eq(collections.gender, input.query.gender));
  if (input.query.status) filters.push(eq(collections.status, input.query.status));
  if (input.query.featured !== undefined) {
    filters.push(eq(collections.isFeatured, input.query.featured));
  }
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.collections.findMany({
    ...(where && { where }),
    orderBy: [asc(collections.sortOrder), desc(collections.createdAt)],
  });
  const counts =
    rows.length === 0
      ? []
      : await db
          .select({
            collectionId: collectionListings.collectionId,
            count: sql<number>`cast(count(*) as int)`,
          })
          .from(collectionListings)
          .where(
            inArray(
              collectionListings.collectionId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(collectionListings.collectionId);
  const countMap = new Map(counts.map((c) => [c.collectionId, c.count]));
  return ok(rows.map((c) => ({ ...c, listingCount: countMap.get(c.id) ?? 0 })));
}

export async function createCollection(input: { body: z.infer<typeof CreateBody> }) {
  if (input.body.brandId) {
    const b = await db.query.brands.findFirst({ where: eq(brands.id, input.body.brandId) });
    if (!b) throw new AppError(404, ErrorCode.NotFound, `Brand ${input.body.brandId} not found`);
  }
  const id = newId(IdPrefix.Collection);
  try {
    const [created] = await db
      .insert(collections)
      .values({
        id,
        slug: input.body.slug,
        name: input.body.name,
        kind: input.body.kind,
        gender: input.body.gender,
        ...(input.body.description !== undefined && { description: input.body.description }),
        ...(input.body.heroImageUrl !== undefined && { heroImageUrl: input.body.heroImageUrl }),
        accentColors: input.body.accentColors,
        sortOrder: input.body.sortOrder,
        isFeatured: input.body.isFeatured,
        status: input.body.status,
        ...(input.body.startsAt && { startsAt: new Date(input.body.startsAt) }),
        ...(input.body.endsAt && { endsAt: new Date(input.body.endsAt) }),
        ...(input.body.brandId !== undefined && { brandId: input.body.brandId }),
        ...(input.body.occasionTag !== undefined && { occasionTag: input.body.occasionTag }),
      })
      .returning();
    return ok(created);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, ErrorCode.InvalidState, `Slug '${input.body.slug}' is already taken`);
    }
    throw err;
  }
}

export async function getCollection(input: { id: string }) {
  const c = await db.query.collections.findFirst({ where: eq(collections.id, input.id) });
  if (!c) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

  let listings: Array<typeof productListings.$inferSelect & { sortOrder: number }>;
  if (c.kind === 'brand' && c.brandId) {
    const rows = await db.query.productListings.findMany({
      where: eq(productListings.brandId, c.brandId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    listings = rows.map((r, i) => ({ ...r, sortOrder: i }));
  } else if (c.kind === 'occasion' && c.occasionTag) {
    const rows = await db.query.productListings.findMany({
      where: sql`${productListings.occasion} @> ${JSON.stringify([c.occasionTag])}::jsonb`,
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    listings = rows.map((r, i) => ({ ...r, sortOrder: i }));
  } else {
    const memberships = await db
      .select({ sortOrder: collectionListings.sortOrder, listing: productListings })
      .from(collectionListings)
      .innerJoin(productListings, eq(productListings.id, collectionListings.listingId))
      .where(eq(collectionListings.collectionId, c.id))
      .orderBy(asc(collectionListings.sortOrder));
    listings = memberships.map((m) => ({ ...m.listing, sortOrder: m.sortOrder }));
  }

  return ok({ ...c, listings });
}

export async function patchCollection(input: { id: string; body: z.infer<typeof PatchBody> }) {
  const existing = await db.query.collections.findFirst({ where: eq(collections.id, input.id) });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

  const effectiveStart =
    input.body.startsAt === undefined
      ? existing.startsAt
      : input.body.startsAt === null
        ? null
        : new Date(input.body.startsAt);
  const effectiveEnd =
    input.body.endsAt === undefined
      ? existing.endsAt
      : input.body.endsAt === null
        ? null
        : new Date(input.body.endsAt);
  if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) {
    throw new AppError(422, ErrorCode.ValidationError, 'endsAt must be after startsAt');
  }

  const effectiveKind = input.body.kind ?? existing.kind;
  const effectiveBrandId =
    input.body.brandId === undefined ? existing.brandId : input.body.brandId;
  if (effectiveKind === 'brand' && !effectiveBrandId) {
    throw new AppError(422, ErrorCode.ValidationError, 'brandId is required when kind=brand');
  }
  if (input.body.brandId) {
    const b = await db.query.brands.findFirst({ where: eq(brands.id, input.body.brandId) });
    if (!b) throw new AppError(404, ErrorCode.NotFound, `Brand ${input.body.brandId} not found`);
  }

  const { startsAt: _sa, endsAt: _ea, ...rest } = input.body;
  const patch = compact({
    ...rest,
    ...(input.body.startsAt !== undefined && {
      startsAt: input.body.startsAt === null ? null : new Date(input.body.startsAt),
    }),
    ...(input.body.endsAt !== undefined && {
      endsAt: input.body.endsAt === null ? null : new Date(input.body.endsAt),
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
      throw new AppError(409, ErrorCode.InvalidState, `Slug '${input.body.slug}' is already taken`);
    }
    throw err;
  }
}

export async function deleteCollection(input: { id: string }) {
  const existing = await db.query.collections.findFirst({ where: eq(collections.id, input.id) });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');
  await db.delete(collections).where(eq(collections.id, existing.id));
  return ok({ id: existing.id, deleted: true });
}

export async function setCollectionListings(input: {
  id: string;
  body: z.infer<typeof ListingsBody>;
}) {
  const c = await db.query.collections.findFirst({ where: eq(collections.id, input.id) });
  if (!c) throw new AppError(404, ErrorCode.NotFound, 'Collection not found');

  const ids = input.body.listingIds;
  if (new Set(ids).size !== ids.length) {
    throw new AppError(422, ErrorCode.ValidationError, 'Duplicate listing IDs in payload');
  }
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
      await tx
        .insert(collectionListings)
        .values(ids.map((listingId, i) => ({ collectionId: c.id, listingId, sortOrder: i })));
    }
  });
  return ok({ collectionId: c.id, listingCount: ids.length });
}

export async function searchListings(input: { query: z.infer<typeof ListingsSearchQuery> }) {
  const filters = [];
  if (input.query.q) {
    const needle = `%${input.query.q}%`;
    filters.push(
      or(ilike(productListings.name, needle), ilike(productListings.description, needle))!,
    );
  }
  if (input.query.brandId) filters.push(eq(productListings.brandId, input.query.brandId));
  if (input.query.categoryId) filters.push(eq(productListings.categoryId, input.query.categoryId));
  if (input.query.gender) filters.push(eq(productListings.gender, input.query.gender));
  if (input.query.status) filters.push(eq(productListings.status, input.query.status));
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.productListings.findMany({
    ...(where && { where }),
    orderBy: desc(productListings.createdAt),
    limit: input.query.limit,
  });
  return ok(rows);
}
