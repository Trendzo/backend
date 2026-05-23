/**
 * §20 close-consumer workflow. Beyond flipping consumers.status='closed', this:
 *  - enqueues an accountDeletionRequests row honoring the platform retention window
 *    (default 30 days if `account_deletion_grace_days` config key is absent),
 *  - if wallet balance > 0, enqueues a walletPayouts row (status='pending_claim') so
 *    the consumer can claim disbursal during the claim window,
 *  - sends a compliance notification.
 *
 * The actual PII scrub + escheat fire in a downstream worker that reads these tables.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  accountDeletionRequests,
  consumerWallets,
  consumers,
  platformConfig,
  walletPayouts,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';

const DEFAULT_GRACE_DAYS = 30;
const DEFAULT_CLAIM_DAYS = 90;

async function getNumberConfig(key: string, fallback: number): Promise<number> {
  const row = await db.query.platformConfig.findFirst({ where: eq(platformConfig.key, key) });
  if (!row) return fallback;
  const v = row.value as unknown;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'object' && v !== null && 'days' in (v as Record<string, unknown>)) {
    const days = (v as Record<string, unknown>).days;
    if (typeof days === 'number') return days;
  }
  return fallback;
}

export interface CloseResult {
  consumerId: string;
  status: string;
  deletionRequestId: string;
  scheduledFor: string;
  walletPayoutId: string | null;
  walletPayoutPaise: number;
}

export async function closeConsumerWithRetention(input: {
  consumerId: string;
  reason: string;
  adminId: string;
}): Promise<CloseResult> {
  const consumer = await db.query.consumers.findFirst({
    where: eq(consumers.id, input.consumerId),
  });
  if (!consumer) throw new AppError(404, ErrorCode.NotFound, 'Consumer not found');
  if (consumer.status === 'closed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Consumer account is already closed');
  }

  const graceDays = await getNumberConfig('account_deletion_grace_days', DEFAULT_GRACE_DAYS);
  const claimDays = await getNumberConfig('wallet_payout_claim_days', DEFAULT_CLAIM_DAYS);
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
  const claimWindowEndsAt = new Date(now.getTime() + claimDays * 24 * 60 * 60 * 1000);

  const wallet = await db.query.consumerWallets.findFirst({
    where: eq(consumerWallets.consumerId, input.consumerId),
  });
  const walletBalance = wallet?.balancePaise ?? 0;

  const deletionId = newId(IdPrefix.AccountDeletionRequest);
  let walletPayoutId: string | null = null;

  await db.transaction(async (tx) => {
    await tx.update(consumers).set({ status: 'closed' }).where(eq(consumers.id, input.consumerId));

    await tx.insert(accountDeletionRequests).values({
      id: deletionId,
      consumerId: input.consumerId,
      status: 'pending',
      requestedAt: now,
      scheduledFor,
      reason: input.reason,
    });

    if (walletBalance > 0) {
      walletPayoutId = newId(IdPrefix.WalletPayout);
      await tx.insert(walletPayouts).values({
        id: walletPayoutId,
        consumerId: input.consumerId,
        balancePaise: walletBalance,
        status: 'pending_claim',
        claimWindowEndsAt,
      });
    }
  });

  await notifyConsumer({
    consumerId: input.consumerId,
    kind: 'compliance',
    title: 'Your account has been closed',
    body: `Reason: ${input.reason}. Scheduled deletion: ${scheduledFor.toISOString().slice(0, 10)}.`,
    payload: {
      deletionRequestId: deletionId,
      scheduledFor: scheduledFor.toISOString(),
      walletPayoutPaise: walletBalance,
      walletPayoutId,
    },
  });

  return {
    consumerId: input.consumerId,
    status: 'closed',
    deletionRequestId: deletionId,
    scheduledFor: scheduledFor.toISOString(),
    walletPayoutId,
    walletPayoutPaise: walletBalance,
  };
}
