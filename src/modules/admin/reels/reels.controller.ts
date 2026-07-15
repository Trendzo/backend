/**
 * Admin moderation of reels + reel comments. Mirrors the moodboard takedown/restore model
 * (status flips with the guard-required takedown trio) and additionally writes an
 * append-only `moderation_actions` audit row for each decision.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { moderationActions, reelComments, reels } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ListQuery, TakedownBody } from './reels.validators.js';

async function recordAction(input: {
  targetType: 'reel' | 'reel_comment';
  targetId: string;
  action: 'takedown' | 'approve';
  adminId: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}) {
  await db.insert(moderationActions).values({
    id: newId(IdPrefix.ModerationAction),
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    adminId: input.adminId,
    reason: input.reason,
    beforeJson: input.before,
    afterJson: input.after,
  });
}

export async function listReels(input: { query: z.infer<typeof ListQuery> }) {
  const { status, consumerId, limit, offset } = input.query;
  const conds = [];
  if (status) conds.push(eq(reels.status, status));
  if (consumerId) conds.push(eq(reels.consumerId, consumerId));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.reels.findMany({
    where,
    orderBy: [desc(reels.createdAt)],
    limit,
    offset,
    with: { consumer: { columns: { id: true, name: true } } },
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      consumerId: r.consumerId,
      authorName: r.consumer?.name ?? null,
      caption: r.caption,
      thumbnailUrl: r.thumbnailUrl,
      videoUrl: r.videoUrl,
      status: r.status,
      likeCount: r.likeCount,
      commentCount: r.commentCount,
      saveCount: r.saveCount,
      viewCount: r.viewCount,
      takedownReason: r.takedownReason,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

// Cap on comments returned in one moderation view. High enough to cover any realistic reel;
// bounds the payload so a pathological comment count can't blow up the request.
const REEL_DETAIL_COMMENT_LIMIT = 200;

/**
 * Full reel view for the moderation surface: the reel plus its comments (all statuses,
 * most-recent first, capped) with author names, so an admin can moderate individual
 * comments. Unlike the consumer comment list this includes taken-down comments.
 */
export async function getReelDetail(input: { id: string }) {
  const reel = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    with: {
      consumer: { columns: { id: true, name: true } },
      product: { columns: { id: true, name: true } },
    },
  });
  if (!reel) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');

  const comments = await db.query.reelComments.findMany({
    where: eq(reelComments.reelId, input.id),
    orderBy: [desc(reelComments.createdAt)],
    limit: REEL_DETAIL_COMMENT_LIMIT,
    with: { consumer: { columns: { id: true, name: true } } },
  });

  return ok({
    id: reel.id,
    consumerId: reel.consumerId,
    authorName: reel.consumer?.name ?? null,
    caption: reel.caption,
    videoUrl: reel.videoUrl,
    thumbnailUrl: reel.thumbnailUrl,
    durationSec: reel.durationSec,
    status: reel.status,
    likeCount: reel.likeCount,
    commentCount: reel.commentCount,
    saveCount: reel.saveCount,
    viewCount: reel.viewCount,
    takedownReason: reel.takedownReason,
    product: reel.product ? { id: reel.product.id, name: reel.product.name } : null,
    createdAt: reel.createdAt.toISOString(),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      status: c.status,
      authorName: c.consumer?.name ?? null,
      consumerId: c.consumerId,
      takedownReason: c.takedownReason,
      createdAt: c.createdAt.toISOString(),
    })),
  });
}

export async function takedownReel(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const existing = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');

  const [updated] = await db
    .update(reels)
    .set({
      status: 'taken_down',
      takedownReason: input.body.reason,
      takedownByAdminId: input.adminId,
      takedownAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(reels.id, input.id))
    .returning({ id: reels.id, status: reels.status });
  await recordAction({
    targetType: 'reel',
    targetId: input.id,
    action: 'takedown',
    adminId: input.adminId,
    reason: input.body.reason,
    before: { status: existing.status },
    after: { status: 'taken_down' },
  });
  return ok(updated);
}

export async function restoreReel(input: { id: string; adminId: string }) {
  const existing = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');

  const [updated] = await db
    .update(reels)
    .set({
      status: 'active',
      takedownReason: null,
      takedownByAdminId: null,
      takedownAt: null,
      updatedAt: new Date(),
    })
    .where(eq(reels.id, input.id))
    .returning({ id: reels.id, status: reels.status });
  await recordAction({
    targetType: 'reel',
    targetId: input.id,
    action: 'approve',
    adminId: input.adminId,
    reason: 'restored',
    before: { status: existing.status },
    after: { status: 'active' },
  });
  return ok(updated);
}

export async function takedownComment(input: {
  commentId: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const existing = await db.query.reelComments.findFirst({
    where: eq(reelComments.id, input.commentId),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');

  const [updated] = await db
    .update(reelComments)
    .set({
      status: 'taken_down',
      takedownReason: input.body.reason,
      takedownByAdminId: input.adminId,
      takedownAt: new Date(),
    })
    .where(eq(reelComments.id, input.commentId))
    .returning({ id: reelComments.id, status: reelComments.status });
  await recordAction({
    targetType: 'reel_comment',
    targetId: input.commentId,
    action: 'takedown',
    adminId: input.adminId,
    reason: input.body.reason,
    before: { status: existing.status },
    after: { status: 'taken_down' },
  });
  return ok(updated);
}

export async function restoreComment(input: { commentId: string; adminId: string }) {
  const existing = await db.query.reelComments.findFirst({
    where: eq(reelComments.id, input.commentId),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');

  const [updated] = await db
    .update(reelComments)
    .set({
      status: 'active',
      takedownReason: null,
      takedownByAdminId: null,
      takedownAt: null,
    })
    .where(eq(reelComments.id, input.commentId))
    .returning({ id: reelComments.id, status: reelComments.status });
  await recordAction({
    targetType: 'reel_comment',
    targetId: input.commentId,
    action: 'approve',
    adminId: input.adminId,
    reason: 'restored',
    before: { status: existing.status },
    after: { status: 'active' },
  });
  return ok(updated);
}
