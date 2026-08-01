/**
 * The single choke-point for every consumer-wallet balance mutation.
 *
 * Before this module the same read → compute → conditional-UPDATE → retry block was
 * hand-copied into seven call sites, each with its own subtly different failure
 * handling, and one of them shipped a private `ensureWallet` that lacked the shared
 * one's `onConflictDoNothing` race guard.
 *
 * Locking, not CAS: `SELECT … FOR UPDATE` on the wallet row serialises concurrent
 * writers for one consumer, so there is no lost update and no retry-exhaustion
 * failure mode. This mirrors `shared/loyalty/apply-delta.ts`, which is the same
 * pattern for points. The `wallet_transactions (wallet_id, wallet_version_after)`
 * unique index stays as a belt-and-suspenders integrity guard.
 *
 * Every wallet writer MUST route through here — never UPDATE consumer_wallets or
 * INSERT wallet_transactions directly.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { consumerWallets, walletTransactions } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { ensureWallet } from '@/shared/wallet/ensure-wallet.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type WalletKind = 'top_up' | 'debit' | 'refund_credit' | 'gift_card_credit' | 'adjustment';

/**
 * Signed movement. A function form lets a caller size the delta against the balance
 * it has just locked (checkout's "apply as much wallet as this cart can absorb").
 */
export type WalletDelta = number | ((balancePaise: number) => number);

export type WalletMovement = {
  walletId: string;
  appliedPaise: number;
  balanceAfterPaise: number;
  versionAfter: number;
  /** The ledger row for this movement. Already inserted unless `deferLedger` was set. */
  ledger: typeof walletTransactions.$inferInsert;
};

type ApplyArgs = {
  consumerId: string;
  deltaPaise: WalletDelta;
  kind: WalletKind;
  refOrderId?: string | null;
  refRefundId?: string | null;
  refGiftCardId?: string | null;
  note?: string | null;
  /**
   * Message for the 409 when the movement would drive the balance negative.
   * Call sites keep their own wording so existing API contracts do not shift.
   */
  insufficientMessage?: string;
  /**
   * Skip the `wallet_transactions` insert and hand the row back to the caller.
   * Only for order placement, whose ledger row carries `refOrderId` and therefore
   * cannot be written until the `orders` row it references exists.
   */
  deferLedger?: boolean;
};

/**
 * Apply a signed paise delta to a consumer's wallet inside an open transaction.
 *
 * Returns `null` when the computed delta is zero — nothing moved, and a zero-amount
 * ledger row would violate `wallet_transactions_sign_by_kind` anyway.
 * Throws 409 `ExceedsBalance` if the movement would drive the balance negative.
 */
export async function applyWalletDelta(tx: Tx, args: ApplyArgs): Promise<WalletMovement | null> {
  const walletId = await ensureWallet(tx, args.consumerId);

  // Lock the balance row: concurrent wallet writers for this consumer queue behind us
  // and see our committed balance, so the running total cannot be corrupted.
  const [wallet] = await tx
    .select()
    .from(consumerWallets)
    .where(eq(consumerWallets.id, walletId))
    .for('update');
  if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');

  const delta =
    typeof args.deltaPaise === 'function' ? args.deltaPaise(wallet.balancePaise) : args.deltaPaise;
  if (delta === 0) return null;

  const balanceAfterPaise = wallet.balancePaise + delta;
  if (balanceAfterPaise < 0) {
    throw new AppError(
      409,
      ErrorCode.ExceedsBalance,
      args.insufficientMessage ?? 'Wallet balance is insufficient for this movement',
    );
  }
  const versionAfter = wallet.version + 1;

  await tx
    .update(consumerWallets)
    .set({ balancePaise: balanceAfterPaise, version: versionAfter, updatedAt: new Date() })
    .where(eq(consumerWallets.id, walletId));

  const ledger: typeof walletTransactions.$inferInsert = {
    id: newId(IdPrefix.WalletTx),
    walletId,
    kind: args.kind,
    amountPaise: delta,
    balanceAfterPaise,
    walletVersionAfter: versionAfter,
    refOrderId: args.refOrderId ?? null,
    refRefundId: args.refRefundId ?? null,
    refGiftCardId: args.refGiftCardId ?? null,
    note: args.note ?? null,
  };
  if (!args.deferLedger) await tx.insert(walletTransactions).values(ledger);

  return { walletId, appliedPaise: delta, balanceAfterPaise, versionAfter, ledger };
}
