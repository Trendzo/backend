import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  communityPosts,
  moderationReports,
  orders,
  productListings,
  productReviews,
} from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { isConsumerBannedFrom } from '@/shared/consumers/ban-surface.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type {
  CreatePostBody,
  CreateReportBody,
  CreateReviewBody,
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
  // Validate target exists.
  if (input.body.targetType === 'community_post') {
    const p = await db.query.communityPosts.findFirst({
      where: eq(communityPosts.id, input.body.targetId),
      columns: { id: true },
    });
    if (!p) throw new AppError(404, ErrorCode.NotFound, 'Post not found');
  } else {
    const r = await db.query.productReviews.findFirst({
      where: eq(productReviews.id, input.body.targetId),
      columns: { id: true },
    });
    if (!r) throw new AppError(404, ErrorCode.NotFound, 'Review not found');
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
