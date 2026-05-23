import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const FlagIdParam = z.object({ flagId: z.string(), id: z.string() });

export const ListFlagsQuery = z.object({
  status: z
    .enum([
      'open',
      'under_appeal',
      'resolved_taken_down',
      'resolved_restored',
      'resolved_dismissed',
    ])
    .optional(),
  source: z.enum(['automation', 'user_report', 'admin_review']).optional(),
  listingId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const CreateFlagBody = z.object({
  listingId: z.string(),
  source: z.enum(['automation', 'user_report', 'admin_review']),
  reasonCode: z.string().trim().min(1).max(100),
  details: z.string().trim().max(2000).optional(),
  reportedByConsumerId: z.string().optional(),
  ruleKey: z.string().optional(),
});

export const ResolveFlagBody = z.object({
  outcome: z.enum(['resolved_taken_down', 'resolved_dismissed', 'resolved_restored']),
  note: z.string().trim().max(500).optional(),
});

export const DecideAppealBody = z.object({
  outcome: z.enum(['upheld', 'denied']),
  note: z.string().trim().max(500).optional(),
});

export const RetireListingBody = z.object({
  note: z.string().trim().max(500).optional(),
});

export const RecordAuditBody = z.object({
  action: z.enum(['edit', 'publish', 'unpublish', 'takedown', 'restore', 'retire']),
  before: z.record(z.unknown()).optional(),
  after: z.record(z.unknown()).optional(),
  note: z.string().trim().max(500).optional(),
});

export const AssignFlagBody = z.object({
  adminId: z.string().nullable(),
});

// ===== §20 Community + Review moderation =====
export const PostIdParam = z.object({ postId: z.string() });
export const ReviewIdParam = z.object({ reviewId: z.string() });

const TargetTypeEnum = z.enum(['community_post', 'product_review']);
const ReportStatusEnum = z.enum(['pending', 'actioned', 'dismissed']);

export const QueueQuery = z.object({
  targetType: TargetTypeEnum.optional(),
  status: ReportStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const DecideReportBody = z.object({
  action: z.enum(['approve', 'edit', 'takedown']),
  editedBody: z.string().trim().min(1).max(5000).optional(),
  reason: z.string().trim().min(3).max(1000),
});

export const TakedownBody = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const ActionsListQuery = z.object({
  targetType: TargetTypeEnum.optional(),
  targetId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
