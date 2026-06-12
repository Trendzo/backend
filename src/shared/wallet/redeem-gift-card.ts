/**
 * Gift-card redemption — redeem-to-wallet model. A gift card carries a balance
 * pre-assigned to one consumer; redeeming credits that balance into the consumer's
 * wallet (a `gift_card_credit` transaction) and zeroes the card. The funds are then
 * spent like any wallet balance at checkout — gift cards are never a direct tender.
 *
 * Single transaction: claim the card (CAS on balance, so a double-redeem can't
 * double-credit) then credit the wallet (CAS on version, mirroring refund credit).
 */
import { and, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { consumerWallets, giftCards, walletTransactions } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { ensureWallet } from './ensure-wallet.js';

export type RedeemGiftCardResult = {
  giftCardId: string;
  creditedPaise: number;
  walletBalancePaise: number;
};

export async function redeemGiftCard(
  database: typeof Db,
  input: { consumerId: string; code: string },
): Promise<RedeemGiftCardResult> {
  // Codes are stored uppercase (see admin issueGiftCard); normalize the input so redemption
  // is case-insensitive and consistent with referral-code handling.
  const code = input.code.trim().toUpperCase();
  return database.transaction(async (tx) => {
    const card = await tx.query.giftCards.findFirst({
      where: eq(giftCards.code, code),
    });
    // Unknown code, or a card belonging to someone else — same opaque error either
    // way so a consumer can't probe which codes exist.
    if (!card || card.consumerId !== input.consumerId) {
      throw new AppError(404, ErrorCode.GiftCardInvalid, 'Gift card not found');
    }

    // expiresOn is a DATE ('YYYY-MM-DD'); ISO date strings compare lexicographically.
    const today = new Date().toISOString().slice(0, 10);
    if (card.expiresOn < today) {
      throw new AppError(409, ErrorCode.GiftCardExpired, 'Gift card has expired');
    }

    if (card.balancePaise <= 0) {
      throw new AppError(409, ErrorCode.GiftCardAlreadyRedeemed, 'Gift card already redeemed');
    }

    const creditedPaise = card.balancePaise;

    // Claim atomically: zero the balance only if it still matches what we read.
    // Zero rows updated ⇒ a concurrent redeem won the race.
    const [claimed] = await tx
      .update(giftCards)
      .set({ balancePaise: 0 })
      .where(and(eq(giftCards.id, card.id), eq(giftCards.balancePaise, creditedPaise)))
      .returning({ id: giftCards.id });
    if (!claimed) {
      throw new AppError(409, ErrorCode.GiftCardAlreadyRedeemed, 'Gift card already redeemed');
    }

    // Credit the wallet (CAS on version; unique (walletId, walletVersionAfter) index
    // serializes concurrent writes). Mirrors the refund-credit pattern.
    const walletId = await ensureWallet(tx, input.consumerId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const wallet = await tx.query.consumerWallets.findFirst({
        where: eq(consumerWallets.id, walletId),
      });
      if (!wallet) throw new AppError(500, ErrorCode.InternalError, 'Wallet vanished');
      const newBalance = wallet.balancePaise + creditedPaise;
      const newVersion = wallet.version + 1;
      const [updated] = await tx
        .update(consumerWallets)
        .set({ balancePaise: newBalance, version: newVersion, updatedAt: new Date() })
        .where(and(eq(consumerWallets.id, walletId), eq(consumerWallets.version, wallet.version)))
        .returning();
      if (updated) {
        await tx.insert(walletTransactions).values({
          id: newId(IdPrefix.WalletTx),
          walletId,
          kind: 'gift_card_credit',
          amountPaise: creditedPaise,
          balanceAfterPaise: newBalance,
          walletVersionAfter: newVersion,
          refGiftCardId: card.id,
          note: `Gift card ${card.code} redeemed`,
        });
        return { giftCardId: card.id, creditedPaise, walletBalancePaise: newBalance };
      }
    }
    throw new AppError(503, ErrorCode.InternalError, 'Wallet CAS retries exhausted');
  });
}
