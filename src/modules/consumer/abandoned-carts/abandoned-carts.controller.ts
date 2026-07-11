/**
 * Public (UNAUTHENTICATED) read surface over abandoned carts — carts that still hold
 * items but have gone stale (no updatedAt activity for `staleMinutes`). Used by
 * recovery/marketing jobs and dashboards to fetch the abandoned count plus each cart's
 * item list.
 *
 * Read-only, no auth hook (mounted like /catalog and /promotions). It exposes only
 * {variantId, qty} lines + updatedAt — no consumer PII beyond the opaque consumerId.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { carts } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { ListAbandonedCartsQuery } from './abandoned-carts.validators.js';

type Item = { variantId: string; qty: number };

/** Non-empty cart items array + stale enough to count as abandoned. */
function abandonedWhere(staleBefore: Date, consumerId?: string) {
  const conds = [
    sql`jsonb_array_length(${carts.items}) > 0`,
    lt(carts.updatedAt, staleBefore),
  ];
  if (consumerId) conds.push(eq(carts.consumerId, consumerId));
  return and(...conds);
}

export async function listAbandonedCarts(input: { query: ListAbandonedCartsQuery }) {
  const { staleMinutes, consumerId, limit, offset } = input.query;
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000);
  const where = abandonedWhere(staleBefore, consumerId);

  // Total matching carts, independent of pagination — this is "the number".
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(carts)
    .where(where);
  const count = countRow?.count ?? 0;

  const rows = await db
    .select({
      id: carts.id,
      consumerId: carts.consumerId,
      items: carts.items,
      updatedAt: carts.updatedAt,
    })
    .from(carts)
    .where(where)
    .orderBy(desc(carts.updatedAt))
    .limit(limit)
    .offset(offset);

  return ok({
    count,
    staleMinutes,
    limit,
    offset,
    carts: rows.map((r) => {
      const items = (r.items ?? []) as Item[];
      return {
        id: r.id,
        consumerId: r.consumerId,
        itemCount: items.length,
        totalUnits: items.reduce((s, it) => s + it.qty, 0),
        items,
        updatedAt: r.updatedAt,
      };
    }),
  });
}
