import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  communityPosts,
  listingAuditEntries,
  listingModerationAppeals,
  listingModerationFlags,
  moderationActions,
  moderationReports,
  postComments,
  productListings,
  productReviews,
  reelComments,
  reels,
  retailerAccounts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';
import { notify } from '@/shared/notify.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ActionsListQuery,
  AssignFlagBody,
  CreateFlagBody,
  DecideAppealBody,
  DecideReportBody,
  ListFlagsQuery,
  QueueQuery,
  RecordAuditBody,
  ResolveFlagBody,
  RetireListingBody,
  TakedownBody,
} from './moderation.validators.js';

type Auth = AccessTokenPayload;

/**
 * Fan out a single notification to every retailer account that owns the given store.
 * Used after takedown/restore/retire so the retailer learns about the action without
 * polling the dashboard.
 */
async function notifyStoreOwners(
  storeId: string,
  msg: {
    title: string;
    body: string;
    deepLink: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const owners = await db
    .select({ id: retailerAccounts.id })
    .from(retailerAccounts)
    .where(eq(retailerAccounts.storeId, storeId));
  for (const o of owners) {
    await notify({
      recipientKind: 'retailer',
      recipientId: o.id,
      kind: 'compliance',
      title: msg.title,
      body: msg.body,
      deepLink: msg.deepLink,
      payload: msg.payload ?? {},
    });
  }
}

export async function listFlags(input: { query: z.infer<typeof ListFlagsQuery> }) {
  const { status, source, listingId, limit } = input.query;
  const conditions = [];
  if (status) conditions.push(eq(listingModerationFlags.status, status));
  if (source) conditions.push(eq(listingModerationFlags.source, source));
  if (listingId) conditions.push(eq(listingModerationFlags.listingId, listingId));

  const rows = await db.query.listingModerationFlags.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(listingModerationFlags.openedAt),
    limit,
    with: { listing: { columns: { name: true, status: true, storeId: true } } },
  });
  return ok(
    rows.map((r) => ({
      ...r,
      listingName: r.listing?.name ?? null,
      listingStatus: r.listing?.status ?? null,
    })),
  );
}

export async function createFlag(input: { body: z.infer<typeof CreateFlagBody> }) {
  const { body } = input;
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, body.listingId),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');

  const id = newId('flag');
  await db.insert(listingModerationFlags).values({
    id,
    listingId: listing.id,
    source: body.source,
    reasonCode: body.reasonCode,
    details: body.details ?? null,
    reportedByConsumerId: body.reportedByConsumerId ?? null,
    ruleKey: body.ruleKey ?? null,
    status: 'open',
  });
  return ok({ id });
}

export async function resolveFlag(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof ResolveFlagBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const flag = await db.query.listingModerationFlags.findFirst({
    where: eq(listingModerationFlags.id, id),
  });
  if (!flag) throw new AppError(404, ErrorCode.NotFound, 'Moderation flag not found');
  if (flag.status !== 'open' && flag.status !== 'under_appeal') {
    throw new AppError(409, ErrorCode.InvalidState, 'Flag already resolved');
  }
  const [updated] = await db
    .update(listingModerationFlags)
    .set({
      status: body.outcome,
      resolvedAt: new Date(),
      resolvedByAccountId: auth.sub,
      resolutionNote: body.note ?? null,
    })
    .where(eq(listingModerationFlags.id, flag.id))
    .returning();

  if (body.outcome === 'resolved_taken_down') {
    // Capture the pre-takedown status so a future restore reverts to the
    // right state (active vs draft). Guard against double-takedown clobber.
    const current = await db.query.productListings.findFirst({
      where: eq(productListings.id, flag.listingId),
      columns: { status: true, storeId: true, name: true },
    });
    const prevStatus = current?.status !== 'taken_down' ? current?.status ?? null : null;
    await db.insert(listingAuditEntries).values({
      id: newId('lae'),
      listingId: flag.listingId,
      action: 'takedown',
      actorKind: 'admin',
      actorId: auth.sub,
      note: body.note ?? null,
    });
    await db
      .update(productListings)
      .set({ status: 'taken_down', statusBeforeTakedown: prevStatus })
      .where(eq(productListings.id, flag.listingId));
    if (current) {
      await notifyStoreOwners(current.storeId, {
        title: `Listing taken down: ${current.name}`,
        body: body.note ?? `Reason: ${flag.reasonCode}. Open the listing to file an appeal.`,
        deepLink: `/retailer/listings/${flag.listingId}`,
        payload: {
          listingId: flag.listingId,
          flagId: flag.id,
          reasonCode: flag.reasonCode,
        },
      });
    }
  } else if (body.outcome === 'resolved_restored') {
    const current = await db.query.productListings.findFirst({
      where: eq(productListings.id, flag.listingId),
      columns: {
        status: true,
        storeId: true,
        name: true,
        statusBeforeTakedown: true,
      },
    });
    // Default to 'draft' if no prior state was captured — never auto-publish
    // something that wasn't active before takedown.
    const revertTo = current?.statusBeforeTakedown ?? 'draft';
    await db.insert(listingAuditEntries).values({
      id: newId('lae'),
      listingId: flag.listingId,
      action: 'restore',
      actorKind: 'admin',
      actorId: auth.sub,
      note: body.note ?? null,
    });
    await db
      .update(productListings)
      .set({ status: revertTo, statusBeforeTakedown: null })
      .where(eq(productListings.id, flag.listingId));
    if (current) {
      await notifyStoreOwners(current.storeId, {
        title: `Listing restored: ${current.name}`,
        body: body.note ?? `Restored to ${revertTo}. The flag has been resolved.`,
        deepLink: `/retailer/listings/${flag.listingId}`,
        payload: { listingId: flag.listingId, flagId: flag.id, revertedTo: revertTo },
      });
    }
  }

  await recordAudit({
    actor: auth,
    action: `moderation.${body.outcome}`,
    resourceKind: 'listing_moderation_flag',
    resourceId: flag.id,
    requestId,
  });
  return ok(updated);
}

export async function listAppeals(flagId: string) {
  const rows = await db.query.listingModerationAppeals.findMany({
    where: eq(listingModerationAppeals.flagId, flagId),
    orderBy: (t, { desc }) => [desc(t.filedAt)],
  });
  return ok(rows);
}

export async function decideAppeal(input: {
  flagId: string;
  appealId: string;
  auth: Auth;
  body: z.infer<typeof DecideAppealBody>;
}) {
  const { flagId, appealId, auth, body } = input;
  const appeal = await db.query.listingModerationAppeals.findFirst({
    where: and(
      eq(listingModerationAppeals.id, appealId),
      eq(listingModerationAppeals.flagId, flagId),
    ),
  });
  if (!appeal) throw new AppError(404, ErrorCode.NotFound, 'Appeal not found');
  if (appeal.decidedAt)
    throw new AppError(409, ErrorCode.InvalidState, 'Appeal already decided');

  const [updated] = await db
    .update(listingModerationAppeals)
    .set({
      outcome: body.outcome,
      decidedAt: new Date(),
      decidedByAccountId: auth.sub,
      decisionNote: body.note ?? null,
    })
    .where(eq(listingModerationAppeals.id, appeal.id))
    .returning();

  // Update flag status
  const flagStatus =
    body.outcome === 'upheld' ? 'resolved_taken_down' : 'resolved_dismissed';
  await db
    .update(listingModerationFlags)
    .set({
      status: flagStatus,
      resolvedAt: new Date(),
      resolvedByAccountId: auth.sub,
    })
    .where(eq(listingModerationFlags.id, flagId));

  return ok(updated);
}

export async function getListingAudit(id: string) {
  const rows = await db.query.listingAuditEntries.findMany({
    where: eq(listingAuditEntries.listingId, id),
    orderBy: (t, { desc }) => [desc(t.at)],
  });
  return ok(rows);
}

export async function retireListing(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof RetireListingBody>;
  requestId: string;
}) {
  const { id, auth, body, requestId } = input;
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, id),
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Listing not found');
  if (listing.status === 'retired') {
    throw new AppError(409, ErrorCode.InvalidState, 'Listing is already retired');
  }

  await db
    .update(productListings)
    .set({ status: 'retired' })
    .where(eq(productListings.id, listing.id));

  await db.insert(listingAuditEntries).values({
    id: newId('lae'),
    listingId: listing.id,
    action: 'retire',
    actorKind: 'admin',
    actorId: auth.sub,
    note: body.note ?? null,
  });

  await recordAudit({
    actor: auth,
    action: 'catalog.listing.retire',
    resourceKind: 'listing',
    resourceId: listing.id,
    requestId,
  });

  await notifyStoreOwners(listing.storeId, {
    title: `Listing retired: ${listing.name}`,
    body:
      body.note ??
      'Retired platform-wide by ClosetX moderation. This cannot be undone.',
    deepLink: `/retailer/listings/${listing.id}`,
    payload: { listingId: listing.id },
  });

  return ok({ id: listing.id, status: 'retired' });
}

export async function getListingReports(id: string) {
  const rows = await db
    .select({
      reasonCode: listingModerationFlags.reasonCode,
      count: sql<number>`count(*)::int`,
    })
    .from(listingModerationFlags)
    .where(
      and(
        eq(listingModerationFlags.listingId, id),
        eq(listingModerationFlags.source, 'user_report'),
      ),
    )
    .groupBy(listingModerationFlags.reasonCode)
    .orderBy(desc(sql`count(*)`));
  const total = rows.reduce((s, r) => s + r.count, 0);
  return ok({ total, breakdown: rows });
}

export async function recordListingAudit(input: {
  id: string;
  auth: Auth;
  body: z.infer<typeof RecordAuditBody>;
}) {
  const { id, auth, body } = input;
  const entryId = newId('lae');
  await db.insert(listingAuditEntries).values({
    id: entryId,
    listingId: id,
    action: body.action,
    actorKind: 'admin',
    actorId: auth.sub,
    before: body.before ?? null,
    after: body.after ?? null,
    note: body.note ?? null,
  });
  return ok({ id: entryId });
}

// ===== §20 Community + Review moderation queue =====

type ModReportTarget =
  | 'community_post'
  | 'product_review'
  | 'reel'
  | 'reel_comment'
  | 'post_comment';

async function loadTarget(targetType: ModReportTarget, targetId: string) {
  switch (targetType) {
    case 'community_post': {
      const row = await db.query.communityPosts.findFirst({
        where: eq(communityPosts.id, targetId),
      });
      return row
        ? {
            kind: 'community_post' as const,
            id: row.id,
            consumerId: row.consumerId,
            body: row.body,
            media: row.media,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            takedownReason: row.takedownReason,
          }
        : null;
    }
    case 'product_review': {
      const row = await db.query.productReviews.findFirst({
        where: eq(productReviews.id, targetId),
      });
      return row
        ? {
            kind: 'product_review' as const,
            id: row.id,
            consumerId: row.consumerId,
            listingId: row.listingId,
            rating: row.rating,
            body: row.body,
            media: row.media,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            takedownReason: row.takedownReason,
          }
        : null;
    }
    case 'reel': {
      const row = await db.query.reels.findFirst({ where: eq(reels.id, targetId) });
      return row
        ? {
            kind: 'reel' as const,
            id: row.id,
            consumerId: row.consumerId,
            body: row.caption,
            media: [row.videoUrl],
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            takedownReason: row.takedownReason,
          }
        : null;
    }
    case 'reel_comment': {
      const row = await db.query.reelComments.findFirst({ where: eq(reelComments.id, targetId) });
      return row
        ? {
            kind: 'reel_comment' as const,
            id: row.id,
            consumerId: row.consumerId,
            body: row.body,
            media: [] as string[],
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            takedownReason: row.takedownReason,
          }
        : null;
    }
    case 'post_comment': {
      const row = await db.query.postComments.findFirst({ where: eq(postComments.id, targetId) });
      return row
        ? {
            kind: 'post_comment' as const,
            id: row.id,
            consumerId: row.consumerId,
            body: row.body,
            media: [] as string[],
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            takedownReason: row.takedownReason,
          }
        : null;
    }
  }
}

export async function listQueue(input: { query: z.infer<typeof QueueQuery> }) {
  const conds = [];
  if (input.query.targetType) conds.push(eq(moderationReports.targetType, input.query.targetType));
  if (input.query.status) conds.push(eq(moderationReports.status, input.query.status));
  const rows = await db
    .select()
    .from(moderationReports)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(moderationReports.createdAt))
    .limit(input.query.limit);
  return ok(
    rows.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      reporterConsumerId: r.reporterConsumerId,
      source: r.source,
      reason: r.reason,
      status: r.status,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionReason: r.decisionReason,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

export async function getReport(input: { id: string }) {
  const report = await db.query.moderationReports.findFirst({
    where: eq(moderationReports.id, input.id),
  });
  if (!report) throw new AppError(404, ErrorCode.NotFound, 'Report not found');
  const target = await loadTarget(report.targetType, report.targetId);
  return ok({
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    reporterConsumerId: report.reporterConsumerId,
    source: report.source,
    reason: report.reason,
    status: report.status,
    decidedByAdminId: report.decidedByAdminId,
    decidedAt: report.decidedAt ? report.decidedAt.toISOString() : null,
    decisionReason: report.decisionReason,
    createdAt: report.createdAt.toISOString(),
    target,
  });
}

export async function decideReport(input: {
  id: string;
  body: z.infer<typeof DecideReportBody>;
  auth: Auth;
}) {
  const report = await db.query.moderationReports.findFirst({
    where: eq(moderationReports.id, input.id),
  });
  if (!report) throw new AppError(404, ErrorCode.NotFound, 'Report not found');
  if (report.status !== 'pending') {
    throw new AppError(409, ErrorCode.InvalidState, 'Report already decided');
  }
  if (input.body.action === 'edit' && !input.body.editedBody) {
    throw new AppError(422, ErrorCode.ValidationError, 'editedBody required for edit action');
  }

  const now = new Date();
  const action = input.body.action;
  let beforeJson: Record<string, unknown> | null = null;
  let afterJson: Record<string, unknown> | null = null;
  let consumerId: string | null = null;

  await db.transaction(async (tx) => {
    if (action === 'takedown') {
      const takedownSet = {
        status: 'taken_down' as const,
        takedownReason: input.body.reason,
        takedownByAdminId: input.auth.sub,
        takedownAt: now,
      };
      switch (report.targetType) {
        case 'community_post': {
          const r = await tx.query.communityPosts.findFirst({
            where: eq(communityPosts.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target post not found');
          consumerId = r.consumerId;
          beforeJson = { status: r.status, body: r.body };
          await tx.update(communityPosts).set(takedownSet).where(eq(communityPosts.id, report.targetId));
          break;
        }
        case 'product_review': {
          const r = await tx.query.productReviews.findFirst({
            where: eq(productReviews.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target review not found');
          consumerId = r.consumerId;
          beforeJson = { status: r.status, body: r.body };
          await tx.update(productReviews).set(takedownSet).where(eq(productReviews.id, report.targetId));
          break;
        }
        case 'reel': {
          const r = await tx.query.reels.findFirst({ where: eq(reels.id, report.targetId) });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target reel not found');
          consumerId = r.consumerId;
          beforeJson = { status: r.status };
          await tx
            .update(reels)
            .set({ ...takedownSet, updatedAt: now })
            .where(eq(reels.id, report.targetId));
          break;
        }
        case 'reel_comment': {
          const r = await tx.query.reelComments.findFirst({
            where: eq(reelComments.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target comment not found');
          consumerId = r.consumerId;
          beforeJson = { status: r.status, body: r.body };
          await tx.update(reelComments).set(takedownSet).where(eq(reelComments.id, report.targetId));
          break;
        }
        case 'post_comment': {
          const r = await tx.query.postComments.findFirst({
            where: eq(postComments.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target comment not found');
          consumerId = r.consumerId;
          beforeJson = { status: r.status, body: r.body };
          await tx.update(postComments).set(takedownSet).where(eq(postComments.id, report.targetId));
          break;
        }
      }
      afterJson = { status: 'taken_down' };
      await tx
        .update(moderationReports)
        .set({
          status: 'actioned',
          decidedByAdminId: input.auth.sub,
          decidedAt: now,
          decisionReason: input.body.reason,
        })
        .where(eq(moderationReports.id, report.id));
    } else if (action === 'edit') {
      switch (report.targetType) {
        case 'community_post': {
          const r = await tx.query.communityPosts.findFirst({
            where: eq(communityPosts.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target post not found');
          consumerId = r.consumerId;
          beforeJson = { body: r.body };
          await tx
            .update(communityPosts)
            .set({ body: input.body.editedBody! })
            .where(eq(communityPosts.id, report.targetId));
          break;
        }
        case 'product_review': {
          const r = await tx.query.productReviews.findFirst({
            where: eq(productReviews.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target review not found');
          consumerId = r.consumerId;
          beforeJson = { body: r.body };
          await tx
            .update(productReviews)
            .set({ body: input.body.editedBody! })
            .where(eq(productReviews.id, report.targetId));
          break;
        }
        case 'reel': {
          const r = await tx.query.reels.findFirst({ where: eq(reels.id, report.targetId) });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target reel not found');
          consumerId = r.consumerId;
          beforeJson = { caption: r.caption };
          await tx
            .update(reels)
            .set({ caption: input.body.editedBody!, updatedAt: now })
            .where(eq(reels.id, report.targetId));
          break;
        }
        case 'reel_comment': {
          const r = await tx.query.reelComments.findFirst({
            where: eq(reelComments.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target comment not found');
          consumerId = r.consumerId;
          beforeJson = { body: r.body };
          await tx
            .update(reelComments)
            .set({ body: input.body.editedBody! })
            .where(eq(reelComments.id, report.targetId));
          break;
        }
        case 'post_comment': {
          const r = await tx.query.postComments.findFirst({
            where: eq(postComments.id, report.targetId),
          });
          if (!r) throw new AppError(404, ErrorCode.NotFound, 'Target comment not found');
          consumerId = r.consumerId;
          beforeJson = { body: r.body };
          await tx
            .update(postComments)
            .set({ body: input.body.editedBody! })
            .where(eq(postComments.id, report.targetId));
          break;
        }
      }
      afterJson = { body: input.body.editedBody };
      await tx
        .update(moderationReports)
        .set({
          status: 'actioned',
          decidedByAdminId: input.auth.sub,
          decidedAt: now,
          decisionReason: input.body.reason,
        })
        .where(eq(moderationReports.id, report.id));
    } else {
      const tgt = await loadTarget(report.targetType, report.targetId);
      consumerId = tgt && 'consumerId' in tgt ? tgt.consumerId : null;
      await tx
        .update(moderationReports)
        .set({
          status: 'dismissed',
          decidedByAdminId: input.auth.sub,
          decidedAt: now,
          decisionReason: input.body.reason,
        })
        .where(eq(moderationReports.id, report.id));
    }

    await tx.insert(moderationActions).values({
      id: newId(IdPrefix.ModerationAction),
      targetType: report.targetType,
      targetId: report.targetId,
      action,
      adminId: input.auth.sub,
      reason: input.body.reason,
      beforeJson,
      afterJson,
      reportId: report.id,
    });
  });

  if (consumerId) {
    await notifyConsumer({
      consumerId,
      kind: 'system',
      title:
        action === 'takedown'
          ? `Your ${report.targetType.replace('_', ' ')} was taken down`
          : action === 'edit'
            ? `Your ${report.targetType.replace('_', ' ')} was edited by moderation`
            : `Report on your ${report.targetType.replace('_', ' ')} was dismissed`,
      body: input.body.reason,
      payload: { reportId: report.id, action },
    });
  }

  return ok({ id: report.id, action, status: action === 'approve' ? 'dismissed' : 'actioned' });
}

async function directTakedownTarget(input: {
  targetType: 'community_post' | 'product_review';
  targetId: string;
  reason: string;
  auth: Auth;
}) {
  const now = new Date();
  let consumerId: string | null = null;
  let beforeJson: Record<string, unknown> | null = null;

  await db.transaction(async (tx) => {
    if (input.targetType === 'community_post') {
      const r = await tx.query.communityPosts.findFirst({
        where: eq(communityPosts.id, input.targetId),
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Post not found');
      if (r.status === 'taken_down') {
        throw new AppError(409, ErrorCode.InvalidState, 'Post is already taken down');
      }
      consumerId = r.consumerId;
      beforeJson = { status: r.status, body: r.body };
      await tx
        .update(communityPosts)
        .set({
          status: 'taken_down',
          takedownReason: input.reason,
          takedownByAdminId: input.auth.sub,
          takedownAt: now,
        })
        .where(eq(communityPosts.id, input.targetId));
    } else {
      const r = await tx.query.productReviews.findFirst({
        where: eq(productReviews.id, input.targetId),
      });
      if (!r) throw new AppError(404, ErrorCode.NotFound, 'Review not found');
      if (r.status === 'taken_down') {
        throw new AppError(409, ErrorCode.InvalidState, 'Review is already taken down');
      }
      consumerId = r.consumerId;
      beforeJson = { status: r.status, body: r.body };
      await tx
        .update(productReviews)
        .set({
          status: 'taken_down',
          takedownReason: input.reason,
          takedownByAdminId: input.auth.sub,
          takedownAt: now,
        })
        .where(eq(productReviews.id, input.targetId));
    }

    await tx.insert(moderationActions).values({
      id: newId(IdPrefix.ModerationAction),
      targetType: input.targetType,
      targetId: input.targetId,
      action: 'takedown',
      adminId: input.auth.sub,
      reason: input.reason,
      beforeJson,
      afterJson: { status: 'taken_down' },
      reportId: null,
    });
  });

  if (consumerId) {
    await notifyConsumer({
      consumerId,
      kind: 'system',
      title: `Your ${input.targetType.replace('_', ' ')} was taken down`,
      body: input.reason,
      payload: { targetId: input.targetId, direct: true },
    });
  }

  return { id: input.targetId, status: 'taken_down' };
}

export async function takedownPost(input: {
  postId: string;
  body: z.infer<typeof TakedownBody>;
  auth: Auth;
}) {
  const r = await directTakedownTarget({
    targetType: 'community_post',
    targetId: input.postId,
    reason: input.body.reason,
    auth: input.auth,
  });
  return ok(r);
}

export async function takedownReview(input: {
  reviewId: string;
  body: z.infer<typeof TakedownBody>;
  auth: Auth;
}) {
  const r = await directTakedownTarget({
    targetType: 'product_review',
    targetId: input.reviewId,
    reason: input.body.reason,
    auth: input.auth,
  });
  return ok(r);
}

export async function listActions(input: { query: z.infer<typeof ActionsListQuery> }) {
  const conds = [];
  if (input.query.targetType) conds.push(eq(moderationActions.targetType, input.query.targetType));
  if (input.query.targetId) conds.push(eq(moderationActions.targetId, input.query.targetId));
  const rows = await db
    .select()
    .from(moderationActions)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(moderationActions.at))
    .limit(input.query.limit);
  return ok(
    rows.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      action: r.action,
      adminId: r.adminId,
      reason: r.reason,
      beforeJson: r.beforeJson,
      afterJson: r.afterJson,
      reportId: r.reportId,
      at: r.at.toISOString(),
    })),
  );
}

export async function assignFlag(input: {
  id: string;
  body: z.infer<typeof AssignFlagBody>;
}) {
  const flag = await db.query.listingModerationFlags.findFirst({
    where: eq(listingModerationFlags.id, input.id),
  });
  if (!flag) throw new AppError(404, ErrorCode.NotFound, 'Moderation flag not found');
  const [updated] = await db
    .update(listingModerationFlags)
    .set({ assignedAdminId: input.body.adminId })
    .where(eq(listingModerationFlags.id, flag.id))
    .returning();
  return ok(updated);
}
