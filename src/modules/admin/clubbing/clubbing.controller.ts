import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { clubbingMatrixEntries } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { UpsertBody } from './clubbing.validators.js';

/**
 * 5×5 clubbing matrix. Only 10 of 25 pairs are seeded; the engine treats missing pairs
 * as 'allowed' (matrix is the exception list, default is permissive).
 *
 * GET returns all 25 pairs with their effective value (seeded value or default 'allowed').
 * PUT upserts a pair (canonicalises the order to match the DB CHECK).
 */
const APPLIED_TO_ORDER = [
  'retailer_promo',
  'platform_promo',
  'coupon',
  'shipping',
  'loyalty',
] as const;
type AppliedToOrdered = (typeof APPLIED_TO_ORDER)[number];

function ord(v: AppliedToOrdered): number {
  return APPLIED_TO_ORDER.indexOf(v);
}

function canonicalise<A extends AppliedToOrdered, B extends AppliedToOrdered>(
  a: A,
  b: B,
): { x: AppliedToOrdered; y: AppliedToOrdered } {
  return ord(a) <= ord(b) ? { x: a, y: b } : { x: b, y: a };
}

export async function listMatrix() {
  const rows = await db.query.clubbingMatrixEntries.findMany();
  const lookup = new Map(rows.map((r) => [`${r.appliedToA}:${r.appliedToB}`, r]));
  const cells: Array<{
    appliedToA: AppliedToOrdered;
    appliedToB: AppliedToOrdered;
    defaultValue: 'allowed' | 'disallowed' | 'always_allowed';
    note: string | null;
    seeded: boolean;
  }> = [];
  for (const a of APPLIED_TO_ORDER) {
    for (const b of APPLIED_TO_ORDER) {
      if (ord(a) > ord(b)) continue; // canonical (upper triangle + diagonal)
      const hit = lookup.get(`${a}:${b}`);
      cells.push({
        appliedToA: a,
        appliedToB: b,
        defaultValue: hit?.defaultValue ?? 'allowed',
        note: hit?.note ?? null,
        seeded: !!hit,
      });
    }
  }
  return ok(cells);
}

export async function upsertMatrix(input: { body: z.infer<typeof UpsertBody> }) {
  const { body } = input;
  const { x, y } = canonicalise(
    body.appliedToA as AppliedToOrdered,
    body.appliedToB as AppliedToOrdered,
  );

  const existing = await db.query.clubbingMatrixEntries.findFirst({
    where: and(
      eq(clubbingMatrixEntries.appliedToA, x),
      eq(clubbingMatrixEntries.appliedToB, y),
    ),
  });

  // Once a pair is `always_allowed`, the spec locks it from being downgraded to
  // 'allowed' / 'disallowed' (line 1194). Admin can still re-affirm 'always_allowed'.
  if (
    existing?.defaultValue === 'always_allowed' &&
    body.defaultValue !== 'always_allowed'
  ) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'always_allowed pairs are locked and cannot be downgraded',
    );
  }

  if (existing) {
    const [updated] = await db
      .update(clubbingMatrixEntries)
      .set({
        defaultValue: body.defaultValue,
        ...(body.note !== undefined && { note: body.note }),
      })
      .where(eq(clubbingMatrixEntries.id, existing.id))
      .returning();
    return ok(updated);
  }

  const [inserted] = await db
    .insert(clubbingMatrixEntries)
    .values({
      id: newId(IdPrefix.ClubbingRule),
      appliedToA: x,
      appliedToB: y,
      defaultValue: body.defaultValue,
      ...(body.note !== undefined && { note: body.note }),
    })
    .returning();
  return ok(inserted);
}
