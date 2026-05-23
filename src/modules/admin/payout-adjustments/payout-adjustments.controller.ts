import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { payoutAdjustments } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAdjustment } from '@/shared/settlement/adjustments.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateAdjustmentBody,
  ListAdjustmentsQuery,
} from './payout-adjustments.validators.js';

export async function listAdjustments(input: { query: z.infer<typeof ListAdjustmentsQuery> }) {
  const conds = [];
  if (input.query.storeId) conds.push(eq(payoutAdjustments.storeId, input.query.storeId));
  if (input.query.payoutId) conds.push(eq(payoutAdjustments.payoutId, input.query.payoutId));
  const rows = await db.query.payoutAdjustments.findMany({
    where: conds.length > 0 ? and(...conds) : undefined,
    orderBy: desc(payoutAdjustments.createdAt),
    limit: input.query.limit,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      storeId: r.storeId,
      payoutId: r.payoutId,
      direction: r.direction,
      amountPaise: Number(r.amountPaise),
      reason: r.reason,
      createdByAdminId: r.createdByAdminId,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

export async function postAdjustment(input: {
  body: z.infer<typeof CreateAdjustmentBody>;
  auth: AccessTokenPayload;
}) {
  const r = await recordAdjustment({
    storeId: input.body.storeId,
    direction: input.body.direction,
    amountPaise: input.body.amountPaise,
    reason: input.body.reason,
    adminId: input.auth.sub,
  });
  return ok(r);
}
