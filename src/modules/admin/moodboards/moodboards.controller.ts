/**
 * Admin moderation of public moodboards — list + takedown/restore. Mirrors the
 * community-post takedown model (status flips with guard-required takedown fields).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { moodboardItems, moodboards } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { ListQuery, TakedownBody } from './moodboards.validators.js';

export async function listBoards(input: { query: z.infer<typeof ListQuery> }) {
  const { status, isPublic, limit, offset } = input.query;
  const conds = [];
  if (status) conds.push(eq(moodboards.status, status));
  if (isPublic !== undefined) conds.push(eq(moodboards.isPublic, isPublic));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.moodboards.findMany({
    where,
    orderBy: [desc(moodboards.updatedAt)],
    limit,
    offset,
  });
  // Item counts per board.
  const counts = new Map<string, number>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const grouped = await db
      .select({ moodboardId: moodboardItems.moodboardId, n: sql<number>`count(*)::int` })
      .from(moodboardItems)
      .where(
        sql`${moodboardItems.moodboardId} IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )
      .groupBy(moodboardItems.moodboardId);
    for (const g of grouped) counts.set(g.moodboardId, g.n);
  }
  return ok(
    rows.map((b) => ({
      id: b.id,
      consumerId: b.consumerId,
      name: b.name,
      isPublic: b.isPublic,
      status: b.status,
      itemCount: counts.get(b.id) ?? 0,
      takedownReason: b.takedownReason,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
  );
}

export async function takedown(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const { id, adminId, body } = input;
  const [updated] = await db
    .update(moodboards)
    .set({
      status: 'taken_down',
      takedownReason: body.reason,
      takedownByAdminId: adminId,
      takedownAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moodboards.id, id))
    .returning({ id: moodboards.id, status: moodboards.status });
  if (!updated) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  return ok(updated);
}

export async function restore(input: { id: string }) {
  const [updated] = await db
    .update(moodboards)
    .set({
      status: 'active',
      takedownReason: null,
      takedownByAdminId: null,
      takedownAt: null,
      updatedAt: new Date(),
    })
    .where(eq(moodboards.id, input.id))
    .returning({ id: moodboards.id, status: moodboards.status });
  if (!updated) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  return ok(updated);
}
