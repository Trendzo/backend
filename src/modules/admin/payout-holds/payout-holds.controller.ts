import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { payoutHolds } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { createHold, releaseHold } from '@/shared/settlement/holds.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateHoldBody,
  ListHoldsQuery,
  ReleaseHoldBody,
} from './payout-holds.validators.js';

export async function listHolds(input: { query: z.infer<typeof ListHoldsQuery> }) {
  const conds = [];
  if (input.query.storeId) conds.push(eq(payoutHolds.storeId, input.query.storeId));
  if (input.query.status) conds.push(eq(payoutHolds.status, input.query.status));
  const rows = await db.query.payoutHolds.findMany({
    where: conds.length > 0 ? and(...conds) : undefined,
    orderBy: desc(payoutHolds.createdAt),
    limit: input.query.limit,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      storeId: r.storeId,
      disputeId: r.disputeId,
      payoutId: r.payoutId,
      amountPaise: Number(r.amountPaise),
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
      releasedReason: r.releasedReason,
    })),
  );
}

export async function postHold(input: { body: z.infer<typeof CreateHoldBody>; auth: AccessTokenPayload }) {
  const r = await createHold({
    storeId: input.body.storeId,
    disputeId: input.body.disputeId,
    amountPaise: input.body.amountPaise,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(r);
}

export async function postRelease(input: {
  id: string;
  body: z.infer<typeof ReleaseHoldBody>;
  auth: AccessTokenPayload;
}) {
  const r = await releaseHold({
    holdId: input.id,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(r);
}
