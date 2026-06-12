/**
 * The single choke-point for every loyalty-points mutation. Locks the authoritative
 * `consumer_loyalty` balance row with `SELECT … FOR UPDATE`, computes the new balance, bumps
 * the row's `version`, and appends the matching `loyalty_transactions` ledger row stamped with
 * `balanceVersionAfter`. The row lock serializes concurrent writes for one consumer (no lost
 * updates, no retry-exhaustion failure mode); the unique (consumer_id, balance_version_after)
 * index is a belt-and-suspenders integrity guard against any duplicate-version bug.
 *
 * Every loyalty writer (earn, redeem, refund credit/clawback, referral bonus, admin
 * adjustment) MUST route through here — never insert into loyalty_transactions directly.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { consumerLoyalty, loyaltyTransactions } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type LoyaltyKind = 'earn' | 'redeem' | 'refund_credit' | 'adjustment' | 'bonus';

/** Find-or-create the consumer's balance row, race-tolerant (mirrors ensureWallet). */
async function ensureLoyaltyAccount(tx: Tx, consumerId: string): Promise<void> {
  await tx
    .insert(consumerLoyalty)
    .values({ id: newId(IdPrefix.LoyaltyAccount), consumerId, balancePoints: 0, version: 0 })
    .onConflictDoNothing({ target: consumerLoyalty.consumerId });
}

/** Authoritative current points balance for a consumer (0 if no account row yet). */
export async function loyaltyBalance(tx: Tx, consumerId: string): Promise<number> {
  const row = await tx.query.consumerLoyalty.findFirst({
    where: eq(consumerLoyalty.consumerId, consumerId),
  });
  return row?.balancePoints ?? 0;
}

/**
 * Apply a signed points delta atomically inside an open transaction. Throws
 * `InsufficientPoints` (409) if the delta would drive the balance negative. Returns the
 * resulting balance and the version stamped on the ledger row.
 */
export async function applyLoyaltyDelta(
  tx: Tx,
  args: {
    consumerId: string;
    points: number; // signed: + credit, - debit
    kind: LoyaltyKind;
    refOrderId?: string | null;
    note?: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ balanceAfter: number; balanceVersionAfter: number }> {
  await ensureLoyaltyAccount(tx, args.consumerId);

  // Lock the balance row: concurrent loyalty writers for this consumer queue behind us and
  // see our committed balance, so the running total can never be corrupted by a lost update.
  const [acct] = await tx
    .select()
    .from(consumerLoyalty)
    .where(eq(consumerLoyalty.consumerId, args.consumerId))
    .for('update');
  if (!acct) throw new AppError(500, ErrorCode.InternalError, 'Loyalty account vanished');

  const newBalance = acct.balancePoints + args.points;
  if (newBalance < 0) {
    throw new AppError(409, ErrorCode.InsufficientPoints, 'Insufficient points balance');
  }
  const newVersion = acct.version + 1;

  await tx
    .update(consumerLoyalty)
    .set({ balancePoints: newBalance, version: newVersion, updatedAt: new Date() })
    .where(eq(consumerLoyalty.consumerId, args.consumerId));

  await tx.insert(loyaltyTransactions).values({
    id: newId(IdPrefix.LoyaltyTx),
    consumerId: args.consumerId,
    kind: args.kind,
    points: args.points,
    balanceAfterPoints: newBalance,
    balanceVersionAfter: newVersion,
    refOrderId: args.refOrderId ?? null,
    note: args.note ?? null,
    expiresAt: args.expiresAt ?? null,
  });
  return { balanceAfter: newBalance, balanceVersionAfter: newVersion };
}
