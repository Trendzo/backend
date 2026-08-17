/**
 * Native push device-token registry. One active row per FCM/APNs token; re-registering an
 * existing token reactivates it (mirrors registerPushSubscription for web-push). Used to
 * resolve a recipient (consumer / delivery_agent) → their live tokens for targeted push.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '@/db/client.js';
import type { db as Db } from '@/db/client.js';
import { deviceTokens } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type RecipientKind = 'consumer' | 'delivery_agent';
type Platform = 'ios' | 'android';

export async function registerDeviceToken(
  input: {
    recipientKind: RecipientKind;
    recipientId: string;
    token: string;
    platform: Platform;
    appVersion?: string;
  },
  database: typeof Db = defaultDb,
): Promise<{ id: string }> {
  const now = new Date();
  // Reactivate an existing active row for this token (possibly re-pointing it to the
  // current recipient if the device was handed to another account).
  const existing = await database.query.deviceTokens.findFirst({
    where: and(eq(deviceTokens.token, input.token), isNull(deviceTokens.revokedAt)),
  });
  if (existing) {
    await database
      .update(deviceTokens)
      .set({
        recipientKind: input.recipientKind,
        recipientId: input.recipientId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        revokedAt: null,
      })
      .where(eq(deviceTokens.id, existing.id));
    return { id: existing.id };
  }
  const id = newId(IdPrefix.DeviceToken);
  await database.insert(deviceTokens).values({
    id,
    recipientKind: input.recipientKind,
    recipientId: input.recipientId,
    token: input.token,
    platform: input.platform,
    appVersion: input.appVersion ?? null,
    lastSeenAt: now,
  });
  return { id };
}

export async function revokeDeviceToken(
  input: { recipientKind: RecipientKind; recipientId: string; token: string },
  database: typeof Db = defaultDb,
): Promise<void> {
  await database
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(deviceTokens.recipientKind, input.recipientKind),
        eq(deviceTokens.recipientId, input.recipientId),
        eq(deviceTokens.token, input.token),
      ),
    );
}

/** Mark a set of tokens invalid (called after FCM reports them unregistered). */
export async function revokeTokens(tokens: string[], database: typeof Db = defaultDb): Promise<void> {
  if (tokens.length === 0) return;
  const now = new Date();
  for (const t of tokens) {
    await database
      .update(deviceTokens)
      .set({ revokedAt: now })
      .where(and(eq(deviceTokens.token, t), isNull(deviceTokens.revokedAt)));
  }
}

export async function listActiveTokens(
  recipientKind: RecipientKind,
  recipientId: string,
  database: typeof Db = defaultDb,
): Promise<string[]> {
  const rows = await database.query.deviceTokens.findMany({
    where: and(
      eq(deviceTokens.recipientKind, recipientKind),
      eq(deviceTokens.recipientId, recipientId),
      isNull(deviceTokens.revokedAt),
    ),
    columns: { token: true },
  });
  return rows.map((r) => r.token);
}
