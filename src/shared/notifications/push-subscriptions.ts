/**
 * §22 push subscription management. Recipients (retailer/admin/consumer) register a web-push
 * endpoint; system uses it later to dispatch push notifications.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { pushSubscriptions } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export type RecipientKind = 'admin' | 'retailer' | 'consumer';
export type PushPlatform = 'web' | 'ios' | 'android';

export interface RegisterPushInput {
  recipientKind: RecipientKind;
  recipientId: string;
  platform: PushPlatform;
  endpoint: string;
  p256dh?: string | undefined;
  auth?: string | undefined;
  userAgent?: string | undefined;
}

export async function registerPushSubscription(input: RegisterPushInput): Promise<string> {
  // Reactivate if same endpoint was previously revoked.
  const existing = await db.query.pushSubscriptions.findFirst({
    where: eq(pushSubscriptions.endpoint, input.endpoint),
  });
  const now = new Date();
  if (existing) {
    await db
      .update(pushSubscriptions)
      .set({
        recipientKind: input.recipientKind,
        recipientId: input.recipientId,
        platform: input.platform,
        p256dh: input.p256dh ?? null,
        auth: input.auth ?? null,
        userAgent: input.userAgent ?? null,
        revokedAt: null,
        lastSeenAt: now,
      })
      .where(eq(pushSubscriptions.id, existing.id));
    return existing.id;
  }
  const id = newId(IdPrefix.PushSubscription);
  await db.insert(pushSubscriptions).values({
    id,
    recipientKind: input.recipientKind,
    recipientId: input.recipientId,
    platform: input.platform,
    endpoint: input.endpoint,
    p256dh: input.p256dh ?? null,
    auth: input.auth ?? null,
    userAgent: input.userAgent ?? null,
    lastSeenAt: now,
  });
  return id;
}

export async function revokePushSubscription(input: {
  id: string;
  recipientKind: RecipientKind;
  recipientId: string;
}): Promise<boolean> {
  const row = await db.query.pushSubscriptions.findFirst({
    where: and(
      eq(pushSubscriptions.id, input.id),
      eq(pushSubscriptions.recipientKind, input.recipientKind),
      eq(pushSubscriptions.recipientId, input.recipientId),
    ),
  });
  if (!row) return false;
  await db
    .update(pushSubscriptions)
    .set({ revokedAt: new Date() })
    .where(eq(pushSubscriptions.id, input.id));
  return true;
}

export async function listPushSubscriptions(input: {
  recipientKind: RecipientKind;
  recipientId: string;
}) {
  return db
    .select({
      id: pushSubscriptions.id,
      platform: pushSubscriptions.platform,
      endpoint: pushSubscriptions.endpoint,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
      lastSeenAt: pushSubscriptions.lastSeenAt,
    })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.recipientKind, input.recipientKind),
        eq(pushSubscriptions.recipientId, input.recipientId),
        isNull(pushSubscriptions.revokedAt),
      ),
    );
}
