/**
 * Record a failed delivery attempt and advance the order: log the attempt, move to
 * `undelivered`, then either retry (→ out_for_delivery, within the configured retry
 * budget) or give up (→ returning_to_store). Shared by the retailer order controller
 * and the delivery-agent controller so the retry-budget logic never drifts.
 */
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { deliveryAttempts, platformConfig } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { transitionOrder } from './transition.js';
import type { ActorType } from './state-machine.js';

export async function recordUndelivered(
  database: typeof Db,
  input: {
    orderId: string;
    actor: { type: ActorType; id: string };
    reason: string;
    proofPhotos?: string[];
    /** Delivery-agent account id to stamp on the attempt, when known. */
    deliveryAgentId?: string | null;
    /** Extra metadata to merge onto the undelivered transition (e.g. impersonation). */
    metadata?: Record<string, unknown>;
  },
): Promise<{ orderId: string; toStatus: string; retryWithinBudget: boolean }> {
  const cfg = await database.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'undelivered_retry_budget'),
  });
  const retryBudget = cfg && typeof cfg.value === 'number' ? (cfg.value as number) : 1;

  const existingAttempts = await database
    .select({ attemptNumber: deliveryAttempts.attemptNumber })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.orderId, input.orderId));
  const attemptsSoFar = existingAttempts.length;
  const nextAttempt = existingAttempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;

  await database.insert(deliveryAttempts).values({
    id: newId(IdPrefix.DeliveryAttempt),
    orderId: input.orderId,
    deliveryAgentId: input.deliveryAgentId ?? null,
    attemptNumber: nextAttempt,
    outcome: 'undelivered',
    notes: input.reason,
    proofPhotos: input.proofPhotos ?? [],
  });

  await transitionOrder(database, {
    orderId: input.orderId,
    toStatus: 'undelivered',
    actorType: input.actor.type,
    actorId: input.actor.id,
    reason: input.reason,
    metadata: { attemptNumber: nextAttempt, ...(input.metadata ?? {}) },
  });

  const totalAttemptsAfterThis = attemptsSoFar + 1;
  if (totalAttemptsAfterThis < 1 + retryBudget) {
    const retry = await transitionOrder(database, {
      orderId: input.orderId,
      toStatus: 'out_for_delivery',
      actorType: 'system',
      actorId: 'system',
      reason: 'retry_within_budget',
      metadata: { retryNumber: totalAttemptsAfterThis + 1 },
    });
    return { ...retry, retryWithinBudget: true };
  }
  const final = await transitionOrder(database, {
    orderId: input.orderId,
    toStatus: 'returning_to_store',
    actorType: 'system',
    actorId: 'system',
    reason: 'retry_budget_exhausted',
    metadata: { totalAttempts: totalAttemptsAfterThis },
  });
  return { ...final, retryWithinBudget: false };
}
