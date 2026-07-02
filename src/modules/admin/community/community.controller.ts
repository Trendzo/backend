/**
 * Admin moderation of community posts, post comments, and product reviews — list +
 * takedown/restore. Replaces the earlier stub (the community/reviews tables now exist).
 * Status flips use the guard-required takedown trio and write an append-only
 * `moderation_actions` audit row, mirroring the reels admin module.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  communityPosts,
  moderationActions,
  postComments,
  productReviews,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { ListQuery, TakedownBody } from './community.validators.js';

type ModTarget = 'community_post' | 'post_comment' | 'product_review';

async function recordAction(input: {
  targetType: ModTarget;
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

// ── posts ──

export async function listCommunityModeration(input: { query: z.infer<typeof ListQuery> }) {
  const { status, consumerId, limit, offset } = input.query;
  const conds = [];
  if (status) conds.push(eq(communityPosts.status, status));
  if (consumerId) conds.push(eq(communityPosts.consumerId, consumerId));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.communityPosts.findMany({
    where,
    orderBy: [desc(communityPosts.createdAt)],
    limit,
    offset,
    with: { consumer: { columns: { id: true, name: true } } },
  });
  return ok(
    rows.map((p) => ({
      id: p.id,
      consumerId: p.consumerId,
      authorName: p.consumer?.name ?? null,
      body: p.body,
      media: p.media,
      status: p.status,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      takedownReason: p.takedownReason,
      createdAt: p.createdAt.toISOString(),
    })),
  );
}

export async function takedownPost(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const existing = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Post not found');

  const [updated] = await db
    .update(communityPosts)
    .set({
      status: 'taken_down',
      takedownReason: input.body.reason,
      takedownByAdminId: input.adminId,
      takedownAt: new Date(),
    })
    .where(eq(communityPosts.id, input.id))
    .returning({ id: communityPosts.id, status: communityPosts.status });
  await recordAction({
    targetType: 'community_post',
    targetId: input.id,
    action: 'takedown',
    adminId: input.adminId,
    reason: input.body.reason,
    before: { status: existing.status },
    after: { status: 'taken_down' },
  });
  return ok(updated);
}

export async function restorePost(input: { id: string; adminId: string }) {
  const existing = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Post not found');

  const [updated] = await db
    .update(communityPosts)
    .set({ status: 'active', takedownReason: null, takedownByAdminId: null, takedownAt: null })
    .where(eq(communityPosts.id, input.id))
    .returning({ id: communityPosts.id, status: communityPosts.status });
  await recordAction({
    targetType: 'community_post',
    targetId: input.id,
    action: 'approve',
    adminId: input.adminId,
    reason: 'restored',
    before: { status: existing.status },
    after: { status: 'active' },
  });
  return ok(updated);
}

// ── post comments ──

export async function takedownPostComment(input: {
  commentId: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const existing = await db.query.postComments.findFirst({
    where: eq(postComments.id, input.commentId),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');

  const [updated] = await db
    .update(postComments)
    .set({
      status: 'taken_down',
      takedownReason: input.body.reason,
      takedownByAdminId: input.adminId,
      takedownAt: new Date(),
    })
    .where(eq(postComments.id, input.commentId))
    .returning({ id: postComments.id, status: postComments.status });
  await recordAction({
    targetType: 'post_comment',
    targetId: input.commentId,
    action: 'takedown',
    adminId: input.adminId,
    reason: input.body.reason,
    before: { status: existing.status },
    after: { status: 'taken_down' },
  });
  return ok(updated);
}

export async function restorePostComment(input: { commentId: string; adminId: string }) {
  const existing = await db.query.postComments.findFirst({
    where: eq(postComments.id, input.commentId),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');

  const [updated] = await db
    .update(postComments)
    .set({ status: 'active', takedownReason: null, takedownByAdminId: null, takedownAt: null })
    .where(eq(postComments.id, input.commentId))
    .returning({ id: postComments.id, status: postComments.status });
  await recordAction({
    targetType: 'post_comment',
    targetId: input.commentId,
    action: 'approve',
    adminId: input.adminId,
    reason: 'restored',
    before: { status: existing.status },
    after: { status: 'active' },
  });
  return ok(updated);
}

// ── product reviews ──

export async function listReviewsModeration(input: { query: z.infer<typeof ListQuery> }) {
  const { status, consumerId, limit, offset } = input.query;
  const conds = [];
  if (status) conds.push(eq(productReviews.status, status));
  if (consumerId) conds.push(eq(productReviews.consumerId, consumerId));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.query.productReviews.findMany({
    where,
    orderBy: [desc(productReviews.createdAt)],
    limit,
    offset,
    with: {
      consumer: { columns: { id: true, name: true } },
      listing: { columns: { id: true, name: true } },
    },
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      consumerId: r.consumerId,
      authorName: r.consumer?.name ?? null,
      listingId: r.listingId,
      listingName: r.listing?.name ?? null,
      rating: r.rating,
      body: r.body,
      media: r.media,
      status: r.status,
      takedownReason: r.takedownReason,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

export async function takedownReview(input: {
  id: string;
  adminId: string;
  body: z.infer<typeof TakedownBody>;
}) {
  const existing = await db.query.productReviews.findFirst({
    where: eq(productReviews.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Review not found');

  const [updated] = await db
    .update(productReviews)
    .set({
      status: 'taken_down',
      takedownReason: input.body.reason,
      takedownByAdminId: input.adminId,
      takedownAt: new Date(),
    })
    .where(eq(productReviews.id, input.id))
    .returning({ id: productReviews.id, status: productReviews.status });
  await recordAction({
    targetType: 'product_review',
    targetId: input.id,
    action: 'takedown',
    adminId: input.adminId,
    reason: input.body.reason,
    before: { status: existing.status },
    after: { status: 'taken_down' },
  });
  return ok(updated);
}

export async function restoreReview(input: { id: string; adminId: string }) {
  const existing = await db.query.productReviews.findFirst({
    where: eq(productReviews.id, input.id),
    columns: { id: true, status: true },
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Review not found');

  const [updated] = await db
    .update(productReviews)
    .set({ status: 'active', takedownReason: null, takedownByAdminId: null, takedownAt: null })
    .where(eq(productReviews.id, input.id))
    .returning({ id: productReviews.id, status: productReviews.status });
  await recordAction({
    targetType: 'product_review',
    targetId: input.id,
    action: 'approve',
    adminId: input.adminId,
    reason: 'restored',
    before: { status: existing.status },
    after: { status: 'active' },
  });
  return ok(updated);
}
