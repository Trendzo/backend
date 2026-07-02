import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  communityPosts,
  consumers,
  moderationReports,
  orders,
  postComments,
  postLikes,
  postSaves,
  productListings,
  productReviews,
  reelComments,
  reels,
} from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { isConsumerBannedFrom } from '@/shared/consumers/ban-surface.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type {
  CommentsQuery,
  CreateCommentBody,
  CreatePostBody,
  CreateReportBody,
  CreateReviewBody,
  FeedQuery,
  ListMineQuery,
} from './community.validators.js';

type Auth = AccessTokenPayload;

export async function createPost(input: { auth: Auth; body: z.infer<typeof CreatePostBody> }) {
  const banned = await isConsumerBannedFrom(input.auth.sub, 'posts');
  if (banned) {
    throw new AppError(403, ErrorCode.ConsumerBanned, 'You are banned from creating posts');
  }
  const id = newId(IdPrefix.CommunityPost);
  const [row] = await db
    .insert(communityPosts)
    .values({
      id,
      consumerId: input.auth.sub,
      body: input.body.body,
      media: input.body.media,
    })
    .returning();
  return ok({
    id: row!.id,
    body: row!.body,
    media: row!.media,
    status: row!.status,
    createdAt: row!.createdAt.toISOString(),
  });
}

export async function createReview(input: { auth: Auth; body: z.infer<typeof CreateReviewBody> }) {
  const banned = await isConsumerBannedFrom(input.auth.sub, 'reviews');
  if (banned) {
    throw new AppError(403, ErrorCode.ConsumerBanned, 'You are banned from writing reviews');
  }
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, input.body.listingId),
    columns: { id: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (input.body.orderId) {
    const ord = await db.query.orders.findFirst({
      where: eq(orders.id, input.body.orderId),
      columns: { id: true, consumerId: true },
    });
    if (!ord || ord.consumerId !== input.auth.sub) {
      throw new AppError(404, ErrorCode.OrderNotFound, 'Order not found');
    }
  }
  const id = newId(IdPrefix.ProductReview);
  const [row] = await db
    .insert(productReviews)
    .values({
      id,
      consumerId: input.auth.sub,
      listingId: input.body.listingId,
      orderId: input.body.orderId ?? null,
      rating: input.body.rating,
      body: input.body.body ?? null,
      media: input.body.media,
    })
    .returning();
  return ok({
    id: row!.id,
    listingId: row!.listingId,
    rating: row!.rating,
    body: row!.body,
    media: row!.media,
    status: row!.status,
    createdAt: row!.createdAt.toISOString(),
  });
}

export async function createReport(input: { auth: Auth; body: z.infer<typeof CreateReportBody> }) {
  // Validate the reported target exists (polymorphic via targetType + targetId).
  if (!(await targetExists(input.body.targetType, input.body.targetId))) {
    throw new AppError(404, ErrorCode.NotFound, 'Reported content not found');
  }
  const id = newId(IdPrefix.ModerationReport);
  const [row] = await db
    .insert(moderationReports)
    .values({
      id,
      targetType: input.body.targetType,
      targetId: input.body.targetId,
      reporterConsumerId: input.auth.sub,
      source: 'user',
      reason: input.body.reason,
    })
    .returning();
  return ok({
    id: row!.id,
    targetType: row!.targetType,
    targetId: row!.targetId,
    status: row!.status,
    createdAt: row!.createdAt.toISOString(),
  });
}

export async function listMyPosts(input: { auth: Auth; query: z.infer<typeof ListMineQuery> }) {
  const rows = await db.query.communityPosts.findMany({
    where: eq(communityPosts.consumerId, input.auth.sub),
    orderBy: desc(communityPosts.createdAt),
    limit: input.query.limit,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      body: r.body,
      media: r.media,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      takedownReason: r.takedownReason,
    })),
  );
}

export async function listMyReviews(input: { auth: Auth; query: z.infer<typeof ListMineQuery> }) {
  const rows = await db.query.productReviews.findMany({
    where: eq(productReviews.consumerId, input.auth.sub),
    orderBy: desc(productReviews.createdAt),
    limit: input.query.limit,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      listingId: r.listingId,
      rating: r.rating,
      body: r.body,
      media: r.media,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      takedownReason: r.takedownReason,
    })),
  );
}

// ── posts feed + interactions ──
// Per-feature tables (postLikes/postSaves/postComments), mirroring the reels social layer.

type AuthorCols = Pick<typeof consumers.$inferSelect, 'id' | 'name' | 'avatarUrl'>;
type PostRow = typeof communityPosts.$inferSelect & { consumer: AuthorCols };
type PostCommentRow = typeof postComments.$inferSelect & { consumer: AuthorCols };

const authorWith = { consumer: { columns: { id: true, name: true, avatarUrl: true } } } as const;

function cursorDate(cursor?: string): Date | null {
  if (!cursor) return null;
  const d = new Date(cursor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function targetExists(targetType: string, targetId: string): Promise<boolean> {
  switch (targetType) {
    case 'community_post':
      return !!(await db.query.communityPosts.findFirst({
        where: eq(communityPosts.id, targetId),
        columns: { id: true },
      }));
    case 'product_review':
      return !!(await db.query.productReviews.findFirst({
        where: eq(productReviews.id, targetId),
        columns: { id: true },
      }));
    case 'reel':
      return !!(await db.query.reels.findFirst({
        where: eq(reels.id, targetId),
        columns: { id: true },
      }));
    case 'reel_comment':
      return !!(await db.query.reelComments.findFirst({
        where: eq(reelComments.id, targetId),
        columns: { id: true },
      }));
    case 'post_comment':
      return !!(await db.query.postComments.findFirst({
        where: eq(postComments.id, targetId),
        columns: { id: true },
      }));
    default:
      return false;
  }
}

function shapeAuthor(c: AuthorCols) {
  return { id: c.id, name: c.name, avatarUrl: c.avatarUrl };
}

function shapePost(p: PostRow, viewerHasLiked: boolean, viewerHasSaved: boolean) {
  return {
    id: p.id,
    body: p.body,
    media: p.media,
    status: p.status,
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    saveCount: p.saveCount,
    createdAt: p.createdAt.toISOString(),
    author: shapeAuthor(p.consumer),
    viewerHasLiked,
    viewerHasSaved,
  };
}

function shapePostComment(c: PostCommentRow) {
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    author: shapeAuthor(c.consumer),
  };
}

async function postViewerFlags(consumerId: string, postIds: string[]) {
  if (!postIds.length) return { liked: new Set<string>(), saved: new Set<string>() };
  const [likedRows, savedRows] = await Promise.all([
    db
      .select({ postId: postLikes.postId })
      .from(postLikes)
      .where(and(eq(postLikes.consumerId, consumerId), inArray(postLikes.postId, postIds))),
    db
      .select({ postId: postSaves.postId })
      .from(postSaves)
      .where(and(eq(postSaves.consumerId, consumerId), inArray(postSaves.postId, postIds))),
  ]);
  return {
    liked: new Set(likedRows.map((r) => r.postId)),
    saved: new Set(savedRows.map((r) => r.postId)),
  };
}

async function ensureActivePost(id: string): Promise<void> {
  const p = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, id),
    columns: { id: true, status: true },
  });
  if (!p || p.status !== 'active') throw new AppError(404, ErrorCode.NotFound, 'Post not found');
}

export async function getPostsFeed(input: { auth: Auth; query: z.infer<typeof FeedQuery> }) {
  const { auth, query } = input;
  const conds = [eq(communityPosts.status, 'active')];
  const c = cursorDate(query.cursor);
  if (c) conds.push(lt(communityPosts.createdAt, c));

  const rows = await db.query.communityPosts.findMany({
    where: and(...conds),
    orderBy: desc(communityPosts.createdAt),
    limit: query.limit + 1,
    with: authorWith,
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows) as PostRow[];
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;
  const { liked, saved } = await postViewerFlags(auth.sub, items.map((p) => p.id));

  return ok({
    items: items.map((p) => shapePost(p, liked.has(p.id), saved.has(p.id))),
    nextCursor,
  });
}

export async function getPost(input: { auth: Auth; id: string }) {
  const row = (await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    with: authorWith,
  })) as PostRow | undefined;
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Post not found');
  if (row.status !== 'active' && row.consumerId !== input.auth.sub) {
    throw new AppError(404, ErrorCode.NotFound, 'Post not found');
  }
  const { liked, saved } = await postViewerFlags(input.auth.sub, [row.id]);
  return ok(shapePost(row, liked.has(row.id), saved.has(row.id)));
}

export async function deletePost(input: { auth: Auth; id: string }) {
  const [removed] = await db
    .delete(communityPosts)
    .where(and(eq(communityPosts.id, input.id), eq(communityPosts.consumerId, input.auth.sub)))
    .returning({ id: communityPosts.id });
  if (!removed) throw new AppError(404, ErrorCode.NotFound, 'Post not found');
  return ok({ deleted: true });
}

export async function likePost(input: { auth: Auth; id: string }) {
  await ensureActivePost(input.id);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(postLikes)
        .values({ id: newId(IdPrefix.PostLike), postId: input.id, consumerId: input.auth.sub });
      await tx
        .update(communityPosts)
        .set({ likeCount: sql`${communityPosts.likeCount} + 1` })
        .where(eq(communityPosts.id, input.id));
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const fresh = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { likeCount: true },
  });
  return ok({ liked: true, likeCount: fresh?.likeCount ?? 0 });
}

export async function unlikePost(input: { auth: Auth; id: string }) {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(postLikes)
      .where(and(eq(postLikes.postId, input.id), eq(postLikes.consumerId, input.auth.sub)))
      .returning({ id: postLikes.id });
    if (removed) {
      await tx
        .update(communityPosts)
        .set({ likeCount: sql`${communityPosts.likeCount} - 1` })
        .where(eq(communityPosts.id, input.id));
    }
  });
  const fresh = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { likeCount: true },
  });
  return ok({ liked: false, likeCount: fresh?.likeCount ?? 0 });
}

export async function savePost(input: { auth: Auth; id: string }) {
  await ensureActivePost(input.id);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(postSaves)
        .values({ id: newId(IdPrefix.PostSave), postId: input.id, consumerId: input.auth.sub });
      await tx
        .update(communityPosts)
        .set({ saveCount: sql`${communityPosts.saveCount} + 1` })
        .where(eq(communityPosts.id, input.id));
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const fresh = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { saveCount: true },
  });
  return ok({ saved: true, saveCount: fresh?.saveCount ?? 0 });
}

export async function unsavePost(input: { auth: Auth; id: string }) {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(postSaves)
      .where(and(eq(postSaves.postId, input.id), eq(postSaves.consumerId, input.auth.sub)))
      .returning({ id: postSaves.id });
    if (removed) {
      await tx
        .update(communityPosts)
        .set({ saveCount: sql`${communityPosts.saveCount} - 1` })
        .where(eq(communityPosts.id, input.id));
    }
  });
  const fresh = await db.query.communityPosts.findFirst({
    where: eq(communityPosts.id, input.id),
    columns: { saveCount: true },
  });
  return ok({ saved: false, saveCount: fresh?.saveCount ?? 0 });
}

export async function listPostComments(input: { id: string; query: z.infer<typeof CommentsQuery> }) {
  await ensureActivePost(input.id);
  const conds = [eq(postComments.postId, input.id), eq(postComments.status, 'active')];
  const c = cursorDate(input.query.cursor);
  if (c) conds.push(lt(postComments.createdAt, c));

  const rows = await db.query.postComments.findMany({
    where: and(...conds),
    orderBy: desc(postComments.createdAt),
    limit: input.query.limit + 1,
    with: authorWith,
  });

  const hasMore = rows.length > input.query.limit;
  const items = (hasMore ? rows.slice(0, input.query.limit) : rows) as PostCommentRow[];
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;
  return ok({ items: items.map(shapePostComment), nextCursor });
}

export async function addPostComment(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CreateCommentBody>;
}) {
  if (await isConsumerBannedFrom(input.auth.sub, 'posts')) {
    throw new AppError(403, ErrorCode.ConsumerBanned, 'You are banned from commenting on posts');
  }
  await ensureActivePost(input.id);
  const commentId = newId(IdPrefix.PostComment);
  await db.transaction(async (tx) => {
    await tx
      .insert(postComments)
      .values({ id: commentId, postId: input.id, consumerId: input.auth.sub, body: input.body.body });
    await tx
      .update(communityPosts)
      .set({ commentCount: sql`${communityPosts.commentCount} + 1` })
      .where(eq(communityPosts.id, input.id));
  });
  const created = (await db.query.postComments.findFirst({
    where: eq(postComments.id, commentId),
    with: authorWith,
  })) as PostCommentRow;
  return ok(shapePostComment(created));
}

export async function deletePostComment(input: { auth: Auth; id: string; commentId: string }) {
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(postComments)
      .where(
        and(
          eq(postComments.id, input.commentId),
          eq(postComments.postId, input.id),
          eq(postComments.consumerId, input.auth.sub),
        ),
      )
      .returning({ id: postComments.id });
    if (row) {
      await tx
        .update(communityPosts)
        .set({ commentCount: sql`${communityPosts.commentCount} - 1` })
        .where(eq(communityPosts.id, input.id));
    }
    return row;
  });
  if (!removed) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');
  return ok({ deleted: true });
}
