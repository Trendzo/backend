/**
 * Admin brand CRUD.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { brands, productListings } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import type { CreateBody, ListQuery, PatchBody } from './brands.validators.js';

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

export async function listBrands(input: { query: z.infer<typeof ListQuery> }) {
  const where =
    input.query.activeOnly !== undefined ? eq(brands.isActive, input.query.activeOnly) : undefined;
  const rows = await db.query.brands.findMany({
    ...(where && { where }),
    orderBy: asc(brands.name),
  });
  const counts =
    rows.length === 0
      ? []
      : await db
          .select({
            brandId: productListings.brandId,
            count: sql<number>`cast(count(*) as int)`,
          })
          .from(productListings)
          .where(
            inArray(
              productListings.brandId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(productListings.brandId);
  const countMap = new Map(counts.map((c) => [c.brandId, c.count]));
  return ok(rows.map((b) => ({ ...b, listingCount: countMap.get(b.id) ?? 0 })));
}

export async function createBrand(input: { body: z.infer<typeof CreateBody> }) {
  const id = newId(IdPrefix.Brand);
  try {
    const [created] = await db
      .insert(brands)
      .values({
        id,
        slug: input.body.slug,
        name: input.body.name,
        ...(input.body.tintColor !== undefined && { tintColor: input.body.tintColor }),
        ...(input.body.logoUrl !== undefined && { logoUrl: input.body.logoUrl }),
        ...(input.body.domain !== undefined && { domain: input.body.domain }),
        isActive: input.body.isActive,
      })
      .returning();
    return ok(created);
  } catch (err) {
    translateBrandUniqueViolation(err, input.body.slug, input.body.name);
    throw err;
  }
}

export async function patchBrand(input: { id: string; body: z.infer<typeof PatchBody> }) {
  const existing = await db.query.brands.findFirst({ where: eq(brands.id, input.id) });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Brand not found');
  try {
    const [updated] = await db
      .update(brands)
      .set(compact(input.body))
      .where(eq(brands.id, existing.id))
      .returning();
    return ok(updated);
  } catch (err) {
    translateBrandUniqueViolation(err, input.body.slug, input.body.name);
    throw err;
  }
}

export async function deleteBrand(input: { id: string }) {
  const existing = await db.query.brands.findFirst({ where: eq(brands.id, input.id) });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Brand not found');
  const orphanCount = await db.$count(productListings, eq(productListings.brandId, existing.id));
  await db.delete(brands).where(eq(brands.id, existing.id));
  return ok({ id: existing.id, deleted: true, listingsUnbranded: orphanCount });
}
