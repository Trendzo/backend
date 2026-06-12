/**
 * Consumer loyalty read surface. The earn/redeem/clawback engine lives in shared/loyalty +
 * checkout + referrals; this module only exposes the authenticated consumer's own points
 * balance and ledger.
 *
 * Balance source: the authoritative consumer_loyalty projection (kept in lock-step with the
 * ledger by applyLoyaltyDelta's CAS). The ledger below is history only.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { consumerLoyalty, loyaltyTransactions } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { TxnListQuery } from './loyalty.validators.js';

type Auth = AccessTokenPayload;

function txnOut(t: typeof loyaltyTransactions.$inferSelect) {
  return {
    id: t.id,
    kind: t.kind,
    points: t.points,
    balanceAfterPoints: t.balanceAfterPoints,
    refOrderId: t.refOrderId,
    note: t.note,
    expiresAt: t.expiresAt,
    at: t.at,
  };
}

export async function getLoyalty(input: { auth: Auth; query: z.infer<typeof TxnListQuery> }) {
  const { auth, query } = input;

  const acct = await db.query.consumerLoyalty.findFirst({
    where: eq(consumerLoyalty.consumerId, auth.sub),
  });
  const balancePoints = acct?.balancePoints ?? 0;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.consumerId, auth.sub));

  const txns = await db.query.loyaltyTransactions.findMany({
    where: eq(loyaltyTransactions.consumerId, auth.sub),
    orderBy: desc(loyaltyTransactions.at),
    limit: query.limit,
    offset: query.offset,
  });

  return ok({
    balancePoints,
    total: countRow?.count ?? 0,
    transactions: txns.map(txnOut),
  });
}
