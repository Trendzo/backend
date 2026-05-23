import { desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  consumerWallets,
  consumers,
  loyaltyTransactions,
  platformConfig,
  walletTransactions,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  ConsumerSearchQuery,
  LoyaltyAdjustBody,
  LoyaltyConfigUpdateSchema,
  WalletAdjustBody,
} from './loyalty.validators.js';

type Auth = AccessTokenPayload;

/**
 * Loyalty config keys the admin UI exposes for tuning. Other platform_config rows are
 * managed elsewhere (or not at all). We whitelist to avoid an "edit anything" hole.
 */
const LOYALTY_CONFIG_KEYS = [
  'loyalty_point_value_paise',
  'loyalty_earn_rate_bp',
  'min_redeemable_points',
  'max_redeem_fraction_bp',
  'welcome_points',
  'referrer_points',
  'referred_points',
  'quiz_completion_points',
  'daily_reward_table',
] as const;
type LoyaltyConfigKey = (typeof LOYALTY_CONFIG_KEYS)[number];

export async function getConfig() {
  const rows = await db.query.platformConfig.findMany({
    where: inArray(platformConfig.key, LOYALTY_CONFIG_KEYS as unknown as string[]),
  });
  const out: Record<string, { value: unknown; description: string | null; updatedAt: Date }> = {};
  for (const r of rows) {
    out[r.key] = {
      value: r.value,
      description: r.description,
      updatedAt: r.lastChangedAt,
    };
  }
  return ok(out);
}

export async function patchConfig(input: {
  auth: Auth;
  body: z.infer<typeof LoyaltyConfigUpdateSchema>;
}) {
  const { auth, body: updates } = input;
  const updated: string[] = [];

  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (!(LOYALTY_CONFIG_KEYS as readonly string[]).includes(key)) continue;
      const k = key as LoyaltyConfigKey;
      const existing = await tx.query.platformConfig.findFirst({
        where: eq(platformConfig.key, k),
      });
      if (existing) {
        await tx
          .update(platformConfig)
          .set({
            priorValue: existing.value,
            value,
            lastChangedAdminId: auth.sub,
            lastChangedAt: new Date(),
          })
          .where(eq(platformConfig.key, k));
      } else {
        await tx.insert(platformConfig).values({
          key: k,
          value,
          lastChangedAdminId: auth.sub,
        });
      }
      updated.push(k);
    }
  });

  return ok({ updated });
}

export async function searchConsumers(input: { query: z.infer<typeof ConsumerSearchQuery> }) {
  const { email, phone } = input.query;
  if (!email && !phone) {
    throw new AppError(422, ErrorCode.ValidationError, 'Provide email or phone');
  }
  const where = email ? eq(consumers.email, email) : eq(consumers.phone, phone!);
  const rows = await db.query.consumers.findMany({ where });
  return ok(
    rows.map((c) => ({
      id: c.id,
      email: c.email,
      phone: c.phone,
      name: c.name,
      status: c.status,
      signupAt: c.signupAt,
    })),
  );
}

export async function getWallet(id: string) {
  const wallet = await db.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, id),
  });
  if (!wallet) {
    // No wallet yet — return a synthetic zero balance so the UI can still render.
    return ok({ wallet: null, transactions: [] });
  }
  const txns = await db.query.walletTransactions.findMany({
    where: eq(walletTransactions.walletId, wallet.id),
    orderBy: desc(walletTransactions.at),
    limit: 50,
  });
  return ok({ wallet, transactions: txns });
}

export async function adjustWallet(input: {
  id: string;
  body: z.infer<typeof WalletAdjustBody>;
}) {
  const { id, body } = input;
  const consumer = await db.query.consumers.findFirst({
    where: eq(consumers.id, id),
  });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

  // CAS loop — read wallet, write txn at the read version, retry on conflict.
  // For an admin adjustment with a single writer, retries are highly unlikely.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await db.transaction(async (tx) => {
      let wallet = await tx.query.consumerWallets.findFirst({
        where: eq(consumerWallets.consumerId, consumer.id),
      });
      if (!wallet) {
        const [created] = await tx
          .insert(consumerWallets)
          .values({
            id: newId(IdPrefix.WalletTx).replace(/^wtx_/, 'wlt_'),
            consumerId: consumer.id,
            balancePaise: 0,
            version: 0,
          })
          .returning();
        wallet = created!;
      }
      const newBalance = wallet.balancePaise + body.amountPaise;
      if (newBalance < 0) {
        throw new AppError(
          409,
          ErrorCode.ExceedsBalance,
          `Adjustment would drop balance below zero (current ${wallet.balancePaise})`,
        );
      }
      const newVersion = wallet.version + 1;
      // CAS update — if version changed under us, this returns 0 rows.
      const [updated] = await tx
        .update(consumerWallets)
        .set({ balancePaise: newBalance, version: newVersion, updatedAt: new Date() })
        .where(eq(consumerWallets.id, wallet.id))
        .returning();
      if (!updated) throw new Error('cas_collision');
      // Write the ledger row.
      await tx.insert(walletTransactions).values({
        id: newId(IdPrefix.WalletTx),
        walletId: wallet.id,
        kind: 'adjustment',
        amountPaise: body.amountPaise,
        balanceAfterPaise: newBalance,
        walletVersionAfter: newVersion,
        note: body.note,
      });
      return { walletId: wallet.id, balancePaise: newBalance };
    });
    return ok(result);
  }
  throw new AppError(503, ErrorCode.InternalError, 'wallet adjust failed after retries');
}

export async function getLoyalty(id: string) {
  const txns = await db.query.loyaltyTransactions.findMany({
    where: eq(loyaltyTransactions.consumerId, id),
    orderBy: desc(loyaltyTransactions.at),
    limit: 50,
  });
  // Balance = balanceAfterPoints of the most recent txn (or 0 if none).
  const balancePoints = txns[0]?.balanceAfterPoints ?? 0;
  // Tier — simple thresholds per spec line 242 (tunable later).
  const earned = txns
    .filter((t) => t.kind === 'earn' || t.kind === 'bonus' || t.kind === 'refund_credit')
    .reduce((s, t) => s + Math.max(0, t.points), 0);
  const tier =
    earned >= 5000
      ? 'platinum'
      : earned >= 2000
        ? 'gold'
        : earned >= 500
          ? 'silver'
          : 'bronze';
  return ok({ balancePoints, lifetimeEarned: earned, tier, transactions: txns });
}

export async function adjustLoyalty(input: {
  id: string;
  body: z.infer<typeof LoyaltyAdjustBody>;
}) {
  const { id, body } = input;
  const consumer = await db.query.consumers.findFirst({
    where: eq(consumers.id, id),
  });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');

  const last = await db.query.loyaltyTransactions.findFirst({
    where: eq(loyaltyTransactions.consumerId, consumer.id),
    orderBy: desc(loyaltyTransactions.at),
  });
  const balanceBefore = last?.balanceAfterPoints ?? 0;
  const newBalance = balanceBefore + body.points;
  if (newBalance < 0) {
    throw new AppError(
      409,
      ErrorCode.InsufficientPoints,
      `Adjustment would drop loyalty balance below zero (current ${balanceBefore})`,
    );
  }
  const [created] = await db
    .insert(loyaltyTransactions)
    .values({
      id: newId(IdPrefix.LoyaltyTx),
      consumerId: consumer.id,
      kind: 'adjustment',
      points: body.points,
      balanceAfterPoints: newBalance,
      note: body.note,
    })
    .returning();
  return ok(created);
}
