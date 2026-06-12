/**
 * Consumer gift cards. Scoped to the authenticated consumer (auth.sub).
 *   GET  /          → the consumer's own gift cards + total remaining balance
 *   POST /redeem    → redeem a code into the wallet (redeem-to-wallet model)
 */
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { giftCards } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { redeemGiftCard } from '@/shared/wallet/redeem-gift-card.js';
import type { RedeemBody } from './gift-cards.validators.js';

type Auth = AccessTokenPayload;

export async function listGiftCards(input: { auth: Auth }) {
  const cards = await db.query.giftCards.findMany({
    where: eq(giftCards.consumerId, input.auth.sub),
    orderBy: desc(giftCards.createdAt),
  });
  const totalPaise = cards.reduce((sum, c) => sum + c.balancePaise, 0);
  return ok({
    totalPaise,
    cards: cards.map((c) => ({
      id: c.id,
      code: c.code,
      balancePaise: c.balancePaise,
      expiresOn: c.expiresOn,
    })),
  });
}

export async function redeem(input: { auth: Auth; body: z.infer<typeof RedeemBody> }) {
  const result = await redeemGiftCard(db, {
    consumerId: input.auth.sub,
    code: input.body.code,
  });
  return ok(result);
}
