/**
 * Consumer reels — short fashion videos with a social layer. Two-step create: the client
 * first uploads the video to /media (backend → object storage), then POSTs the returned URLs
 * here. Counters on `reels` are denormalised and updated inside the like/save/comment
 * transactions. Mirrors the moodboards/community controller style (Drizzle inline, no
 * service layer, ok()/AppError envelope).
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  consumers,
  orderItems,
  orders,
  productListings,
  reelComments,
  reelLikes,
  reelSaves,
  reels,
} from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { deleteObject, uploadObject } from '@/shared/storage/index.js';
import { isConsumerBannedFrom } from '@/shared/consumers/ban-surface.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type {
  CommentsQuery,
  CreateCommentBody,
  CreateReelBody,
  FeedQuery,
} from './reels.validators.js';

type Auth = AccessTokenPayload;

const REEL_MAX_BYTES = 100 * 1024 * 1024; // per-request override of the 25 MB global cap
const REEL_VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
// Reels are "short" by product rule — hard-capped at 30s against the server-measured
// duration (the client-reported durationSec is only advisory and can't be trusted).
const REEL_MAX_DURATION_SEC = 30;

// Order-item outcomes where the consumer ends up keeping the product — the "purchased"
// signal that gates who may post a reel about a given listing. Excludes returned/refused/
// refunded outcomes and the pre-delivery 'pending_delivery' state.
const KEPT_OUTCOMES = [
  'delivered_kept',
  'at_door_kept',
  'at_door_return_rejected',
  'held_collected_at_counter',
  'held_redelivered',
  'dispute_resolved_no_refund',
  'dispute_resolved_fresh_delivery',
] as const;

/** True if the consumer has an order line for this listing that they received and kept. */
async function hasPurchasedProduct(consumerId: string, productId: string): Promise<boolean> {
  const rows = await db
    .select({ id: orderItems.id })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.consumerId, consumerId),
        eq(orderItems.listingId, productId),
        inArray(orderItems.outcome, [...KEPT_OUTCOMES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ── shaping ──

type AuthorCols = Pick<typeof consumers.$inferSelect, 'id' | 'name' | 'avatarUrl'>;

type ReelRow = typeof reels.$inferSelect & {
  consumer: AuthorCols;
  product: Pick<typeof productListings.$inferSelect, 'id' | 'name' | 'galleryUrls' | 'status'> | null;
};

type CommentRow = typeof reelComments.$inferSelect & { consumer: AuthorCols };

const reelWith = {
  consumer: { columns: { id: true, name: true, avatarUrl: true } },
  product: { columns: { id: true, name: true, galleryUrls: true, status: true } },
} as const;

const authorWith = {
  consumer: { columns: { id: true, name: true, avatarUrl: true } },
} as const;

function shapeAuthor(c: AuthorCols) {
  return { id: c.id, name: c.name, avatarUrl: c.avatarUrl };
}

function shapeReel(r: ReelRow, viewerHasLiked: boolean, viewerHasSaved: boolean) {
  return {
    id: r.id,
    caption: r.caption,
    videoUrl: r.videoUrl,
    thumbnailUrl: r.thumbnailUrl,
    durationSec: r.durationSec,
    width: r.width,
    height: r.height,
    status: r.status,
    likeCount: r.likeCount,
    commentCount: r.commentCount,
    saveCount: r.saveCount,
    viewCount: r.viewCount,
    createdAt: r.createdAt.toISOString(),
    author: shapeAuthor(r.consumer),
    product: r.product
      ? {
          id: r.product.id,
          name: r.product.name,
          image: r.product.galleryUrls[0] ?? null,
          status: r.product.status,
        }
      : null,
    viewerHasLiked,
    viewerHasSaved,
  };
}

function shapeComment(c: CommentRow) {
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    author: shapeAuthor(c.consumer),
  };
}

// ── helpers ──

function cursorDate(cursor?: string): Date | null {
  if (!cursor) return null;
  const d = new Date(cursor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

async function loadReel(id: string): Promise<ReelRow> {
  const row = await db.query.reels.findFirst({ where: eq(reels.id, id), with: reelWith });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');
  return row as ReelRow;
}

async function ensureActiveReel(id: string): Promise<void> {
  const r = await db.query.reels.findFirst({
    where: eq(reels.id, id),
    columns: { id: true, status: true },
  });
  if (!r || r.status !== 'active') throw new AppError(404, ErrorCode.NotFound, 'Reel not found');
}

/** Batch the current viewer's liked/saved sets for a page of reel ids. */
async function viewerFlags(consumerId: string, reelIds: string[]) {
  if (!reelIds.length) return { liked: new Set<string>(), saved: new Set<string>() };
  const [likedRows, savedRows] = await Promise.all([
    db
      .select({ reelId: reelLikes.reelId })
      .from(reelLikes)
      .where(and(eq(reelLikes.consumerId, consumerId), inArray(reelLikes.reelId, reelIds))),
    db
      .select({ reelId: reelSaves.reelId })
      .from(reelSaves)
      .where(and(eq(reelSaves.consumerId, consumerId), inArray(reelSaves.reelId, reelIds))),
  ]);
  return {
    liked: new Set(likedRows.map((r) => r.reelId)),
    saved: new Set(savedRows.map((r) => r.reelId)),
  };
}

// ── media upload (step 1) ──

/**
 * Upload one reel video and return its URLs + metadata. Takes `req` directly because
 * multipart access is Fastify-specific. Overrides the global 25 MB multipart cap to
 * 100 MB for this route only.
 */
export async function uploadReelMedia(req: FastifyRequest) {
  const file = await req.file({ limits: { fileSize: REEL_MAX_BYTES } });
  if (!file) {
    throw AppError.validation(
      'No file in request — expected multipart/form-data with a `file` field',
    );
  }
  if (!REEL_VIDEO_MIMES.has(file.mimetype)) {
    throw AppError.validation(
      `Unsupported format '${file.mimetype}' — reels must be MP4, MOV, or WebM`,
    );
  }
  const buffer = await file.toBuffer();
  if (file.file.truncated) {
    throw AppError.validation('File too large — reels are capped at 100 MB');
  }

  const result = await uploadObject(buffer, {
    folder: 'closetx/reels',
    resourceType: 'video',
    contentType: file.mimetype,
    filename: file.filename,
    videoThumbnail: true,
  });

  // Enforce the 30s cap against the server-measured duration (authoritative — the client
  // value is not trusted). Reject and clean up the just-uploaded asset so a rejected clip
  // never leaves an orphan behind.
  //
  // An UNMEASURABLE duration is also fatal. Cloudinary always reported one, so the old
  // `duration != null &&` guard never fired; with ffprobe a failed probe is a realistic
  // outcome, and treating it as "fine" would let a clip of any length through.
  const measured = result.duration != null ? Math.round(result.duration) : null;
  if (measured === null || measured > REEL_MAX_DURATION_SEC) {
    try {
      await deleteObject(result.publicId, 'video');
    } catch {
      /* swallow — orphaned asset is acceptable, the validation error is what matters */
    }
    throw AppError.validation(
      measured === null
        ? "Couldn't read this video — re-export it and try again."
        : `Reel too long — max ${REEL_MAX_DURATION_SEC}s, got ${measured}s. Trim it and try again.`,
    );
  }

  return ok({
    videoUrl: result.url,
    videoPublicId: result.publicId,
    thumbnailUrl: result.thumbnailUrl ?? null,
    // Non-null past the guard above.
    durationSec: measured,
    width: result.width ?? null,
    height: result.height ?? null,
    bytes: result.bytes,
  });
}

// ── reel CRUD ──

export async function createReel(input: { auth: Auth; body: z.infer<typeof CreateReelBody> }) {
  const { auth, body } = input;
  if (await isConsumerBannedFrom(auth.sub, 'reels')) {
    throw new AppError(403, ErrorCode.ConsumerBanned, 'You are banned from posting reels');
  }
  // A reel is always tied to a product the consumer actually purchased — verify the listing
  // exists and that this consumer has a kept order line for it.
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, body.productId),
    columns: { id: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Tagged product not found');
  if (!(await hasPurchasedProduct(auth.sub, body.productId))) {
    throw new AppError(
      403,
      ErrorCode.Forbidden,
      'You can only post a reel for a product you have purchased',
    );
  }
  const id = newId(IdPrefix.Reel);
  await db.insert(reels).values({
    id,
    consumerId: auth.sub,
    caption: body.caption ?? null,
    videoUrl: body.videoUrl,
    videoPublicId: body.videoPublicId,
    thumbnailUrl: body.thumbnailUrl,
    durationSec: body.durationSec ?? null,
    width: body.width ?? null,
    height: body.height ?? null,
    bytes: body.bytes ?? null,
    productId: body.productId ?? null,
  });
  return ok(shapeReel(await loadReel(id), false, false));
}

export async function getFeed(input: { auth: Auth; query: z.infer<typeof FeedQuery> }) {
  const { auth, query } = input;
  const conds = [eq(reels.status, 'active')];
  const c = cursorDate(query.cursor);
  if (c) conds.push(lt(reels.createdAt, c));

  const rows = await db.query.reels.findMany({
    where: and(...conds),
    orderBy: desc(reels.createdAt),
    limit: query.limit + 1,
    with: reelWith,
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows) as ReelRow[];
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;
  const { liked, saved } = await viewerFlags(auth.sub, items.map((r) => r.id));

  return ok({
    items: items.map((r) => shapeReel(r, liked.has(r.id), saved.has(r.id))),
    nextCursor,
  });
}

export async function listMine(input: { auth: Auth; query: z.infer<typeof FeedQuery> }) {
  const { auth, query } = input;
  const conds = [eq(reels.consumerId, auth.sub)];
  const c = cursorDate(query.cursor);
  if (c) conds.push(lt(reels.createdAt, c));

  const rows = await db.query.reels.findMany({
    where: and(...conds),
    orderBy: desc(reels.createdAt),
    limit: query.limit + 1,
    with: reelWith,
  });

  const hasMore = rows.length > query.limit;
  const items = (hasMore ? rows.slice(0, query.limit) : rows) as ReelRow[];
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;
  const { liked, saved } = await viewerFlags(auth.sub, items.map((r) => r.id));

  return ok({
    items: items.map((r) => shapeReel(r, liked.has(r.id), saved.has(r.id))),
    nextCursor,
  });
}

export async function listSaved(input: { auth: Auth; query: z.infer<typeof FeedQuery> }) {
  const { auth, query } = input;
  const conds = [eq(reelSaves.consumerId, auth.sub)];
  const c = cursorDate(query.cursor);
  if (c) conds.push(lt(reelSaves.createdAt, c));

  const saveRows = await db.query.reelSaves.findMany({
    where: and(...conds),
    orderBy: desc(reelSaves.createdAt),
    limit: query.limit + 1,
    with: { reel: { with: reelWith } },
  });

  const hasMore = saveRows.length > query.limit;
  const slice = hasMore ? saveRows.slice(0, query.limit) : saveRows;
  const nextCursor = hasMore ? slice[slice.length - 1]!.createdAt.toISOString() : null;
  const reelsList = slice.map((s) => s.reel as ReelRow);
  const { liked } = await viewerFlags(auth.sub, reelsList.map((r) => r.id));

  // Every item in this list is, by definition, saved by the viewer.
  return ok({
    items: reelsList.map((r) => shapeReel(r, liked.has(r.id), true)),
    nextCursor,
  });
}

export async function getReel(input: { auth: Auth; id: string }) {
  const row = await loadReel(input.id);
  // Hide taken-down/hidden reels from everyone but their author.
  if (row.status !== 'active' && row.consumerId !== input.auth.sub) {
    throw new AppError(404, ErrorCode.NotFound, 'Reel not found');
  }
  const { liked, saved } = await viewerFlags(input.auth.sub, [row.id]);
  return ok(shapeReel(row, liked.has(row.id), saved.has(row.id)));
}

export async function deleteReel(input: { auth: Auth; id: string }) {
  const row = await db.query.reels.findFirst({
    where: and(eq(reels.id, input.id), eq(reels.consumerId, input.auth.sub)),
    columns: { id: true, videoPublicId: true },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');
  // FK cascade clears likes/saves/comments.
  await db.delete(reels).where(eq(reels.id, input.id));
  // Best-effort storage cleanup — DB is the source of truth, don't fail the request.
  try {
    await deleteObject(row.videoPublicId, 'video');
  } catch {
    /* swallow — orphaned asset is acceptable */
  }
  return ok({ deleted: true });
}

// ── interactions ──

export async function likeReel(input: { auth: Auth; id: string }) {
  await ensureActiveReel(input.id);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(reelLikes)
        .values({ id: newId(IdPrefix.ReelLike), reelId: input.id, consumerId: input.auth.sub });
      await tx.update(reels).set({ likeCount: sql`${reels.likeCount} + 1` }).where(eq(reels.id, input.id));
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // already liked → idempotent no-op
  }
  const fresh = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { likeCount: true },
  });
  return ok({ liked: true, likeCount: fresh?.likeCount ?? 0 });
}

export async function unlikeReel(input: { auth: Auth; id: string }) {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(reelLikes)
      .where(and(eq(reelLikes.reelId, input.id), eq(reelLikes.consumerId, input.auth.sub)))
      .returning({ id: reelLikes.id });
    if (removed) {
      await tx.update(reels).set({ likeCount: sql`${reels.likeCount} - 1` }).where(eq(reels.id, input.id));
    }
  });
  const fresh = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { likeCount: true },
  });
  return ok({ liked: false, likeCount: fresh?.likeCount ?? 0 });
}

export async function saveReel(input: { auth: Auth; id: string }) {
  await ensureActiveReel(input.id);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(reelSaves)
        .values({ id: newId(IdPrefix.ReelSave), reelId: input.id, consumerId: input.auth.sub });
      await tx.update(reels).set({ saveCount: sql`${reels.saveCount} + 1` }).where(eq(reels.id, input.id));
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const fresh = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { saveCount: true },
  });
  return ok({ saved: true, saveCount: fresh?.saveCount ?? 0 });
}

export async function unsaveReel(input: { auth: Auth; id: string }) {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(reelSaves)
      .where(and(eq(reelSaves.reelId, input.id), eq(reelSaves.consumerId, input.auth.sub)))
      .returning({ id: reelSaves.id });
    if (removed) {
      await tx.update(reels).set({ saveCount: sql`${reels.saveCount} - 1` }).where(eq(reels.id, input.id));
    }
  });
  const fresh = await db.query.reels.findFirst({
    where: eq(reels.id, input.id),
    columns: { saveCount: true },
  });
  return ok({ saved: false, saveCount: fresh?.saveCount ?? 0 });
}

export async function recordView(input: { id: string }) {
  const [updated] = await db
    .update(reels)
    .set({ viewCount: sql`${reels.viewCount} + 1` })
    .where(and(eq(reels.id, input.id), eq(reels.status, 'active')))
    .returning({ viewCount: reels.viewCount });
  if (!updated) throw new AppError(404, ErrorCode.NotFound, 'Reel not found');
  return ok({ viewCount: updated.viewCount });
}

// ── comments ──

export async function listComments(input: { id: string; query: z.infer<typeof CommentsQuery> }) {
  await ensureActiveReel(input.id);
  const conds = [eq(reelComments.reelId, input.id), eq(reelComments.status, 'active')];
  const c = cursorDate(input.query.cursor);
  if (c) conds.push(lt(reelComments.createdAt, c));

  const rows = await db.query.reelComments.findMany({
    where: and(...conds),
    orderBy: desc(reelComments.createdAt),
    limit: input.query.limit + 1,
    with: authorWith,
  });

  const hasMore = rows.length > input.query.limit;
  const items = (hasMore ? rows.slice(0, input.query.limit) : rows) as CommentRow[];
  const nextCursor = hasMore ? items[items.length - 1]!.createdAt.toISOString() : null;
  return ok({ items: items.map(shapeComment), nextCursor });
}

export async function addComment(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CreateCommentBody>;
}) {
  if (await isConsumerBannedFrom(input.auth.sub, 'reels')) {
    throw new AppError(403, ErrorCode.ConsumerBanned, 'You are banned from commenting on reels');
  }
  await ensureActiveReel(input.id);
  const commentId = newId(IdPrefix.ReelComment);
  await db.transaction(async (tx) => {
    await tx
      .insert(reelComments)
      .values({ id: commentId, reelId: input.id, consumerId: input.auth.sub, body: input.body.body });
    await tx
      .update(reels)
      .set({ commentCount: sql`${reels.commentCount} + 1` })
      .where(eq(reels.id, input.id));
  });
  const created = (await db.query.reelComments.findFirst({
    where: eq(reelComments.id, commentId),
    with: authorWith,
  })) as CommentRow;
  return ok(shapeComment(created));
}

export async function deleteComment(input: { auth: Auth; id: string; commentId: string }) {
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(reelComments)
      .where(
        and(
          eq(reelComments.id, input.commentId),
          eq(reelComments.reelId, input.id),
          eq(reelComments.consumerId, input.auth.sub),
        ),
      )
      .returning({ id: reelComments.id });
    if (row) {
      await tx
        .update(reels)
        .set({ commentCount: sql`${reels.commentCount} - 1` })
        .where(eq(reels.id, input.id));
    }
    return row;
  });
  if (!removed) throw new AppError(404, ErrorCode.NotFound, 'Comment not found');
  return ok({ deleted: true });
}
