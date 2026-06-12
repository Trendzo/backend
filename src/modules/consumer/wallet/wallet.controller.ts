/**
 * Consumer wallet read surface. The wallet engine (debit/credit, version-CAS, payouts) lives
 * in shared/wallet + checkout + admin; this module only exposes the authenticated consumer's
 * own balance and ledger. Read-only — never creates a wallet row lazily on a GET.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { consumerWallets, walletTransactions } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { TxnListQuery } from './wallet.validators.js';

type Auth = AccessTokenPayload;

function txnOut(t: typeof walletTransactions.$inferSelect) {
  return {
    id: t.id,
    kind: t.kind,
    amountPaise: t.amountPaise,
    balanceAfterPaise: t.balanceAfterPaise,
    refOrderId: t.refOrderId,
    refRefundId: t.refRefundId,
    refGiftCardId: t.refGiftCardId,
    note: t.note,
    at: t.at,
  };
}

export async function getWallet(input: { auth: Auth; query: z.infer<typeof TxnListQuery> }) {
  const { auth, query } = input;

  const wallet = await db.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, auth.sub),
  });

  // No wallet row yet (consumer minted before eager creation, or never funded) ⇒ empty wallet.
  if (!wallet) {
    return ok({ balancePaise: 0, version: 0, total: 0, transactions: [] });
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTransactions)
    .where(eq(walletTransactions.walletId, wallet.id));

  const txns = await db.query.walletTransactions.findMany({
    where: eq(walletTransactions.walletId, wallet.id),
    orderBy: desc(walletTransactions.at),
    limit: query.limit,
    offset: query.offset,
  });

  return ok({
    balancePaise: wallet.balancePaise,
    version: wallet.version,
    total: countRow?.count ?? 0,
    transactions: txns.map(txnOut),
  });
}
