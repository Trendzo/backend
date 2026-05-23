import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { walletPayouts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { ListWalletPayoutsQuery } from './wallet.validators.js';

function shapeWalletPayout(
  p: typeof walletPayouts.$inferSelect & { consumer?: { email: string } | null },
) {
  return {
    id: p.id,
    consumerId: p.consumerId,
    consumerEmail: p.consumer?.email ?? p.consumerId,
    balancePaise: p.balancePaise,
    closedAt: p.createdAt.toISOString(),
    claimWindowEndsAt: p.claimWindowEndsAt.toISOString(),
    status: p.status,
    bankAccountMasked: p.bankAccountRef ? `•••• ${p.bankAccountRef.slice(-4)}` : null,
    paidAt: p.disbursedAt ? p.disbursedAt.toISOString() : null,
  };
}

export async function listWalletPayouts(input: {
  query: z.infer<typeof ListWalletPayoutsQuery>;
}) {
  const rows = await db.query.walletPayouts.findMany({
    where: input.query.status ? eq(walletPayouts.status, input.query.status) : undefined,
    limit: input.query.limit,
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    with: { consumer: true },
  });
  return ok(rows.map(shapeWalletPayout));
}

export async function disburseWalletPayout(id: string) {
  const p = await db.query.walletPayouts.findFirst({
    where: eq(walletPayouts.id, id),
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Wallet payout not found');
  if (p.status !== 'pending_claim' && p.status !== 'failed') {
    throw new AppError(409, ErrorCode.InvalidState, 'Payout is not in a disbursable state');
  }

  await db
    .update(walletPayouts)
    .set({ status: 'awaiting_bank' })
    .where(eq(walletPayouts.id, id));

  return ok({ id, status: 'awaiting_bank' });
}

export async function escheatWalletPayout(id: string) {
  const p = await db.query.walletPayouts.findFirst({
    where: eq(walletPayouts.id, id),
  });
  if (!p) throw new AppError(404, ErrorCode.NotFound, 'Wallet payout not found');
  if (p.status === 'paid' || p.status === 'escheated') {
    throw new AppError(409, ErrorCode.InvalidState, 'Payout is already settled');
  }

  await db
    .update(walletPayouts)
    .set({ status: 'escheated' })
    .where(eq(walletPayouts.id, id));

  return ok({ id, status: 'escheated' });
}
