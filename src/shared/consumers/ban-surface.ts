/**
 * §20 per-surface consumer bans. One active row per (consumer, surface). Lifting closes
 * the row without deleting it (audit trail). Throws 409 on duplicate active ban.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { consumerBans, consumers } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';

export type BanSurface = 'posts' | 'reviews' | 'rewards' | 'reels';

export interface BanRow {
  id: string;
  consumerId: string;
  surface: BanSurface;
  reason: string;
  createdByAdminId: string;
  createdAt: string;
  liftedByAdminId: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

function shapeBan(r: typeof consumerBans.$inferSelect): BanRow {
  return {
    id: r.id,
    consumerId: r.consumerId,
    surface: r.surface,
    reason: r.reason,
    createdByAdminId: r.createdByAdminId,
    createdAt: r.createdAt.toISOString(),
    liftedByAdminId: r.liftedByAdminId,
    liftedAt: r.liftedAt ? r.liftedAt.toISOString() : null,
    liftReason: r.liftReason,
  };
}

export async function banConsumerFromSurface(input: {
  consumerId: string;
  surface: BanSurface;
  reason: string;
  adminId: string;
}): Promise<BanRow> {
  const c = await db.query.consumers.findFirst({ where: eq(consumers.id, input.consumerId) });
  if (!c) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

  const existing = await db.query.consumerBans.findFirst({
    where: and(
      eq(consumerBans.consumerId, input.consumerId),
      eq(consumerBans.surface, input.surface),
      isNull(consumerBans.liftedAt),
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `Consumer already has active ban on '${input.surface}'`,
    );
  }

  const id = newId(IdPrefix.ConsumerBan);
  const [created] = await db
    .insert(consumerBans)
    .values({
      id,
      consumerId: input.consumerId,
      surface: input.surface,
      reason: input.reason,
      createdByAdminId: input.adminId,
    })
    .returning();

  await notifyConsumer({
    consumerId: input.consumerId,
    kind: 'system',
    title: `You have been banned from ${input.surface}`,
    body: input.reason,
    payload: { banId: id, surface: input.surface },
  });

  return shapeBan(created!);
}

export async function liftBan(input: {
  banId: string;
  reason: string;
  adminId: string;
}): Promise<BanRow> {
  const ban = await db.query.consumerBans.findFirst({
    where: eq(consumerBans.id, input.banId),
  });
  if (!ban) throw new AppError(404, ErrorCode.NotFound, 'Ban not found');
  if (ban.liftedAt) throw new AppError(409, ErrorCode.InvalidState, 'Ban already lifted');

  const [updated] = await db
    .update(consumerBans)
    .set({
      liftedAt: new Date(),
      liftedByAdminId: input.adminId,
      liftReason: input.reason,
    })
    .where(eq(consumerBans.id, input.banId))
    .returning();

  await notifyConsumer({
    consumerId: ban.consumerId,
    kind: 'system',
    title: `Your ${ban.surface} ban has been lifted`,
    body: input.reason,
    payload: { banId: ban.id, surface: ban.surface },
  });

  return shapeBan(updated!);
}

export async function listBans(input: {
  consumerId: string;
  includeLifted: boolean;
}): Promise<BanRow[]> {
  const conds = [eq(consumerBans.consumerId, input.consumerId)];
  if (!input.includeLifted) conds.push(isNull(consumerBans.liftedAt));
  const rows = await db
    .select()
    .from(consumerBans)
    .where(and(...conds))
    .orderBy(desc(consumerBans.createdAt));
  return rows.map(shapeBan);
}

export async function isConsumerBannedFrom(
  consumerId: string,
  surface: BanSurface,
): Promise<boolean> {
  const row = await db.query.consumerBans.findFirst({
    where: and(
      eq(consumerBans.consumerId, consumerId),
      eq(consumerBans.surface, surface),
      isNull(consumerBans.liftedAt),
    ),
    columns: { id: true },
  });
  return !!row;
}

export async function getActiveBanSurfaces(consumerId: string): Promise<BanSurface[]> {
  const rows = await db
    .select({ surface: consumerBans.surface })
    .from(consumerBans)
    .where(and(eq(consumerBans.consumerId, consumerId), isNull(consumerBans.liftedAt)));
  return rows.map((r) => r.surface);
}
