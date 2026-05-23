/**
 * Retailer brand registration.
 */
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { brands } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { CreateBody } from './brands.validators.js';

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
