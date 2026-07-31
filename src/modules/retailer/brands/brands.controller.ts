/**
 * Retailer brand registration.
 */
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { brands } from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { CreateBody, PatchLogoBody } from './brands.validators.js';

type Actor = Pick<AccessTokenPayload, 'sub'>;

function shapeRetailerBrand(row: typeof brands.$inferSelect, actor: Actor) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tintColor: row.tintColor,
    logoUrl: row.logoUrl,
    domain: row.domain,
    isActive: row.isActive,
    canEditLogo: row.createdByRetailerAccountId === actor.sub,
  };
}

export async function listBrands(input: { actor: Actor }) {
  const rows = await db.query.brands.findMany({
    where: eq(brands.isActive, true),
    orderBy: asc(brands.name),
  });
  return ok(rows.map((b) => shapeRetailerBrand(b, input.actor)));
}

export async function createBrand(input: { body: z.infer<typeof CreateBody>; actor: Actor }) {
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
        createdByRetailerAccountId: input.actor.sub ?? null,
      })
      .returning();
    if (!created) {
      throw new AppError(500, ErrorCode.InternalError, 'Brand creation did not return a row');
    }
    return ok(shapeRetailerBrand(created, input.actor));
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') {
      if (e.constraint === 'brands_name_lower_idx') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          `A brand named '${input.body.name}' already exists (matched case-insensitively).`,
        );
      }
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Brand slug '${input.body.slug}' already exists`,
      );
    }
    throw err;
  }
}

export async function patchBrandLogo(input: {
  id: string;
  body: z.infer<typeof PatchLogoBody>;
  actor: Actor;
}) {
  const existing = await db.query.brands.findFirst({ where: eq(brands.id, input.id) });
  if (!existing || !existing.isActive) {
    throw new AppError(404, ErrorCode.NotFound, 'Brand not found');
  }
  if (existing.createdByRetailerAccountId !== input.actor.sub) {
    throw AppError.forbidden('Only the retailer account that created this brand can update its logo');
  }

  const [updated] = await db
    .update(brands)
    .set({ logoUrl: input.body.logoUrl })
    .where(eq(brands.id, existing.id))
    .returning();
  if (!updated) {
    throw new AppError(500, ErrorCode.InternalError, 'Brand logo update did not return a row');
  }

  return ok(shapeRetailerBrand(updated, input.actor));
}
