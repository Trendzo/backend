import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const CommentIdParam = z.object({ id: z.string(), commentId: z.string() });

// Keyset cursor = ISO timestamp of the last row's createdAt.
export const FeedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const CommentsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Reels are created from media already uploaded via POST /consumer/reels/media, so the
// body carries URLs + Cloudinary metadata rather than the raw file.
export const CreateReelBody = z.object({
  videoUrl: z.string().url(),
  videoPublicId: z.string().min(1),
  thumbnailUrl: z.string().url(),
  // 30s hard cap — the media upload already rejects longer clips against Cloudinary's
  // measured duration; this is the matching guard on the client-reported value.
  durationSec: z.coerce.number().int().positive().max(30).optional(),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  bytes: z.coerce.number().int().positive().optional(),
  caption: z.string().trim().max(2200).optional(),
  /**
   * OPTIONAL. A reel is content first; featuring a product is a choice.
   *
   * This was required, and the controller additionally refused unless the author
   * had a delivered-and-kept order line for it — so posting anything at all meant
   * having shopped first. Anyone can post now, with or without a tag.
   */
  productId: z.string().min(1).optional(),
  /**
   * Which variant of that product (colour/size). Only meaningful alongside
   * `productId`; the controller rejects a variant that does not belong to the
   * given listing rather than silently dropping it.
   */
  variantId: z.string().min(1).optional(),
});

export const CreateCommentBody = z.object({
  body: z.string().trim().min(1).max(1000),
});
