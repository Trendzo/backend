/**
 * §20 enriched consumer profile bundle. Consolidates orders, returns, refunds, issues,
 * loyalty, wallet, gift cards, posts, reviews, active bans, and open flags for one consumer.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  accountDeletionRequests,
  addresses,
  communityPosts,
  consumerBans,
  consumerFlags,
  consumerWallets,
  consumers,
  customerIssues,
  giftCards,
  loyaltyTransactions,
  orderItems,
  orders,
  productReviews,
  refunds,
  returns as returnsTable,
  walletPayouts,
  walletTransactions,
} from '@/db/schema/index.js';

export interface ConsumerProfile {
  consumer: {
    id: string;
    email: string;
    phone: string;
    name: string;
    status: string;
    signupAt: string;
    genderPreference: string | null;
  };
  addresses: Array<typeof addresses.$inferSelect>;
  orders: { total: number; lastPlacedAt: string | null; recent: Array<{ id: string; status: string; placedAt: string; grandTotalPaise: number | null }> };
  returns: { total: number };
  refunds: { totalPaise: number; succeededCount: number };
  issues: { openCount: number; recent: Array<{ id: string; kind: string; status: string; subject: string; lastMessageAt: string }> };
  loyalty: { balancePoints: number; recentCount: number };
  wallet: { balancePaise: number; version: number; recentTxnCount: number };
  giftCards: { totalBalancePaise: number; cards: Array<{ id: string; code: string; balancePaise: number; expiresOn: string }> };
  posts: { count: number; recent: Array<{ id: string; status: string; createdAt: string; bodyExcerpt: string }> };
  reviews: { count: number; avgRating: number | null };
  bans: { active: Array<{ id: string; surface: string; reason: string; createdAt: string }> };
  flags: { open: Array<{ id: string; kind: string; reason: string; createdAt: string }> };
  retention: { deletionScheduledFor: string | null; deletionStatus: string | null; walletPayoutPending: boolean };
}

export async function buildConsumerProfile(consumerId: string): Promise<ConsumerProfile | null> {
  const consumer = await db.query.consumers.findFirst({ where: eq(consumers.id, consumerId) });
  if (!consumer) return null;

  const [
    consumerAddresses,
    ordersTotalRow,
    recentOrdersRows,
    refundsAggRow,
    issuesOpenRow,
    issuesRecentRows,
    loyaltyBalanceRow,
    loyaltyCountRow,
    wallet,
    walletTxnCountRow,
    giftCardRows,
    activeBansRows,
    openFlagsRows,
    recentPostsRows,
    postCountRow,
    reviewAggRow,
    deletionRow,
    pendingPayoutRow,
  ] = await Promise.all([
    db.query.addresses.findMany({
      where: eq(addresses.consumerId, consumerId),
      orderBy: desc(addresses.isDefault),
    }),
    db
      .select({ count: sql<number>`count(*)::int`, last: sql<Date | null>`max(${orders.placedAt})` })
      .from(orders)
      .where(eq(orders.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db.query.orders.findMany({
      where: eq(orders.consumerId, consumerId),
      orderBy: desc(orders.placedAt),
      limit: 5,
      columns: { id: true, status: true, placedAt: true, grandTotalPaise: true },
    }),
    db
      .select({
        totalPaise: sql<number>`coalesce(sum(${refunds.totalRefundPaise})::bigint, 0)`,
        succeededCount: sql<number>`count(*) filter (where ${refunds.status} = 'succeeded')::int`,
      })
      .from(refunds)
      .innerJoin(orders, eq(refunds.orderId, orders.id))
      .where(eq(orders.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db
      .select({ openCount: sql<number>`count(*)::int` })
      .from(customerIssues)
      .where(
        and(
          eq(customerIssues.openedByActorType, 'consumer'),
          eq(customerIssues.openedByActorId, consumerId),
          sql`${customerIssues.status} <> 'decided'`,
        ),
      )
      .then((rows) => rows[0]!),
    db.query.customerIssues.findMany({
      where: and(
        eq(customerIssues.openedByActorType, 'consumer'),
        eq(customerIssues.openedByActorId, consumerId),
      ),
      orderBy: desc(customerIssues.lastMessageAt),
      limit: 5,
      columns: { id: true, kind: true, status: true, subject: true, lastMessageAt: true },
    }),
    db
      .select({ balance: sql<number>`coalesce(sum(${loyaltyTransactions.points})::int, 0)` })
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(loyaltyTransactions)
      .where(eq(loyaltyTransactions.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db.query.consumerWallets.findFirst({ where: eq(consumerWallets.consumerId, consumerId) }),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(walletTransactions)
      .innerJoin(consumerWallets, eq(walletTransactions.walletId, consumerWallets.id))
      .where(eq(consumerWallets.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db.query.giftCards.findMany({
      where: eq(giftCards.consumerId, consumerId),
      orderBy: desc(giftCards.createdAt),
    }),
    db
      .select()
      .from(consumerBans)
      .where(and(eq(consumerBans.consumerId, consumerId), isNull(consumerBans.liftedAt))),
    db
      .select()
      .from(consumerFlags)
      .where(and(eq(consumerFlags.consumerId, consumerId), isNull(consumerFlags.resolvedAt))),
    db.query.communityPosts.findMany({
      where: eq(communityPosts.consumerId, consumerId),
      orderBy: desc(communityPosts.createdAt),
      limit: 5,
    }),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(communityPosts)
      .where(eq(communityPosts.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db
      .select({
        count: sql<number>`count(*)::int`,
        avg: sql<number | null>`avg(${productReviews.rating})::numeric(3,2)`,
      })
      .from(productReviews)
      .where(eq(productReviews.consumerId, consumerId))
      .then((rows) => rows[0]!),
    db.query.accountDeletionRequests.findFirst({
      where: eq(accountDeletionRequests.consumerId, consumerId),
      orderBy: desc(accountDeletionRequests.requestedAt),
    }),
    db.query.walletPayouts.findFirst({
      where: and(
        eq(walletPayouts.consumerId, consumerId),
        inArray(walletPayouts.status, ['pending_claim', 'awaiting_bank']),
      ),
    }),
  ]);

  const returnsTotalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(returnsTable)
    .innerJoin(orderItems, eq(returnsTable.orderItemId, orderItems.id))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(eq(orders.consumerId, consumerId))
    .then((rows) => rows[0]!);

  return {
    consumer: {
      id: consumer.id,
      email: consumer.email,
      phone: consumer.phone,
      name: consumer.name,
      status: consumer.status,
      signupAt: consumer.signupAt.toISOString(),
      genderPreference: consumer.genderPreference,
    },
    addresses: consumerAddresses,
    orders: {
      total: Number(ordersTotalRow.count) || 0,
      lastPlacedAt: ordersTotalRow.last ? new Date(ordersTotalRow.last).toISOString() : null,
      recent: recentOrdersRows.map((o) => ({
        id: o.id,
        status: o.status,
        placedAt: o.placedAt.toISOString(),
        grandTotalPaise: o.grandTotalPaise,
      })),
    },
    returns: { total: Number(returnsTotalRow.count) || 0 },
    refunds: {
      totalPaise: Number(refundsAggRow.totalPaise) || 0,
      succeededCount: Number(refundsAggRow.succeededCount) || 0,
    },
    issues: {
      openCount: Number(issuesOpenRow.openCount) || 0,
      recent: issuesRecentRows.map((i) => ({
        id: i.id,
        kind: i.kind,
        status: i.status,
        subject: i.subject,
        lastMessageAt: i.lastMessageAt.toISOString(),
      })),
    },
    loyalty: {
      balancePoints: Number(loyaltyBalanceRow.balance) || 0,
      recentCount: Number(loyaltyCountRow.count) || 0,
    },
    wallet: {
      balancePaise: wallet?.balancePaise ?? 0,
      version: wallet?.version ?? 0,
      recentTxnCount: Number(walletTxnCountRow.count) || 0,
    },
    giftCards: {
      totalBalancePaise: giftCardRows.reduce((s, c) => s + c.balancePaise, 0),
      cards: giftCardRows.map((c) => ({
        id: c.id,
        code: c.code,
        balancePaise: c.balancePaise,
        expiresOn: typeof c.expiresOn === 'string' ? c.expiresOn : new Date(c.expiresOn).toISOString().slice(0, 10),
      })),
    },
    posts: {
      count: Number(postCountRow.count) || 0,
      recent: recentPostsRows.map((p) => ({
        id: p.id,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        bodyExcerpt: p.body.length > 140 ? `${p.body.slice(0, 140)}…` : p.body,
      })),
    },
    reviews: {
      count: Number(reviewAggRow.count) || 0,
      avgRating: reviewAggRow.avg == null ? null : Number(reviewAggRow.avg),
    },
    bans: {
      active: activeBansRows.map((b) => ({
        id: b.id,
        surface: b.surface,
        reason: b.reason,
        createdAt: b.createdAt.toISOString(),
      })),
    },
    flags: {
      open: openFlagsRows.map((f) => ({
        id: f.id,
        kind: f.kind,
        reason: f.reason,
        createdAt: f.createdAt.toISOString(),
      })),
    },
    retention: {
      deletionScheduledFor: deletionRow?.scheduledFor ? deletionRow.scheduledFor.toISOString() : null,
      deletionStatus: deletionRow?.status ?? null,
      walletPayoutPending: !!pendingPayoutRow,
    },
  };
}
