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
  durationSec: z.coerce.number().int().positive().max(180).optional(),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  bytes: z.coerce.number().int().positive().optional(),
  caption: z.string().trim().max(2200).optional(),
  productId: z.string().optional(),
});

export const CreateCommentBody = z.object({
  body: z.string().trim().min(1).max(1000),
});
