/**
 * Admin category CRUD, taxonomy tree with cycle guard on reparent.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { categories, productListings } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import type { CreateBody, ListQuery, PatchBody } from './categories.validators.js';

export async function listCategories(input: { query: z.infer<typeof ListQuery> }) {
  const filters = [];
  if (input.query.gender) filters.push(eq(categories.gender, input.query.gender));
  if (input.query.activeOnly !== undefined) {
    filters.push(eq(categories.isActive, input.query.activeOnly));
  }
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.categories.findMany({
    ...(where && { where }),
    orderBy: [asc(categories.sortOrder), asc(categories.label)],
  });
  const counts =
    rows.length === 0
      ? []
      : await db
          .select({
            categoryId: productListings.categoryId,
            count: sql<number>`cast(count(*) as int)`,
          })
          .from(productListings)
          .where(
            inArray(
              productListings.categoryId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(productListings.categoryId);
  const countMap = new Map(counts.map((c) => [c.categoryId, c.count]));
  return ok(rows.map((c) => ({ ...c, listingCount: countMap.get(c.id) ?? 0 })));
}

export async function createCategory(input: { body: z.infer<typeof CreateBody> }) {
  if (input.body.parentId) {
    const parent = await db.query.categories.findFirst({
      where: eq(categories.id, input.body.parentId),
    });
    if (!parent) throw new AppError(404, ErrorCode.NotFound, 'Parent category not found');
  }
  const id = newId(IdPrefix.Category);
  try {
    const [created] = await db
      .insert(categories)
      .values({
        id,
        slug: input.body.slug,
        label: input.body.label,
        parentId: input.body.parentId ?? null,
        gender: input.body.gender,
        ...(input.body.iconName !== undefined && { iconName: input.body.iconName }),
        ...(input.body.tintColor !== undefined && { tintColor: input.body.tintColor }),
        ...(input.body.imageUrl !== undefined && { imageUrl: input.body.imageUrl }),
        sortOrder: input.body.sortOrder,
        isActive: input.body.isActive,
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

export async function patchCategory(input: { id: string; body: z.infer<typeof PatchBody> }) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, input.id) });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Category not found');

  if (input.body.parentId !== undefined && input.body.parentId !== existing.parentId) {
    if (input.body.parentId === existing.id) {
      throw new AppError(422, ErrorCode.ValidationError, 'A category cannot be its own parent.');
    }
    if (input.body.parentId !== null) {
      const targetParent = await db.query.categories.findFirst({
        where: eq(categories.id, input.body.parentId),
      });
      if (!targetParent) {
        throw new AppError(404, ErrorCode.NotFound, 'New parent category not found');
      }
      let cursor: typeof targetParent | undefined = targetParent;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor.id === existing.id) {
          throw new AppError(422, ErrorCode.ValidationError, 'Re-parenting would create a cycle.');
        }
        if (visited.has(cursor.id)) break;
        visited.add(cursor.id);
        if (!cursor.parentId) break;
        cursor = await db.query.categories.findFirst({
          where: eq(categories.id, cursor.parentId),
        });
      }
    }
  }

  try {
    const [updated] = await db
      .update(categories)
      .set(compact(input.body))
      .where(eq(categories.id, existing.id))
      .returning();
    return ok(updated);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, ErrorCode.InvalidState, `Slug '${input.body.slug}' is already taken`);
    }
    throw err;
  }
}

export async function deleteCategory(input: { id: string }) {
  const existing = await db.query.categories.findFirst({ where: eq(categories.id, input.id) });
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
}
