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
  // Required — a reel is always about a specific product the consumer purchased.
  productId: z.string().min(1),
});

export const CreateCommentBody = z.object({
  body: z.string().trim().min(1).max(1000),
});
