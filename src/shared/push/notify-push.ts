/**
 * Targeted OS push to a single recipient (the one consumer whose try-on window opened, or
 * the one assigned driver a return was requested from). Loads the recipient's live device
 * tokens, sends via FCM, and revokes any token Firebase reports as permanently invalid.
 *
 * Fire-and-forget from callers (wrap in `void … .catch()`): push must never block or fail a
 * mutation. A no-op when FCM is unconfigured. This is the DIRECTED layer; the broadcast
 * "new offer" wake still rides the `driver-offers` topic in fcm.ts.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { notificationPreferences } from '@/db/schema/index.js';
import { sendToTokens, type PushMessage } from '@/shared/fcm/fcm.js';
import {
  listActiveTokens,
  listActiveTokensForRecipients,
  revokeTokens,
} from '@/shared/notifications/device-tokens.js';

async function pushToRecipient(
  kind: 'consumer' | 'delivery_agent' | 'retailer',
  recipientId: string,
  msg: PushMessage,
): Promise<void> {
  const tokens = await listActiveTokens(kind, recipientId);
  if (tokens.length === 0) return;
  const { prune } = await sendToTokens(tokens, msg);
  if (prune.length > 0) await revokeTokens(prune);
}

export function pushConsumer(consumerId: string, msg: PushMessage): Promise<void> {
  return pushToRecipient('consumer', consumerId, msg);
}

export function pushDriver(driverId: string, msg: PushMessage): Promise<void> {
  return pushToRecipient('delivery_agent', driverId, msg);
}

/** FCM multicast accepts at most 500 tokens per call. */
const FCM_MULTICAST_LIMIT = 500;

/**
 * Targeted push to a set of retailer ACCOUNTS (a store's owner / managers / staff). Honours
 * each account's `notification_preferences.push_enabled` (no row = on, same default the
 * GET/PUT /retailer/notification-prefs endpoints report), then sends one multicast to the
 * union of the remaining accounts' live device tokens and revokes tokens FCM reports dead.
 *
 * Returns how many accounts were pushed to (after the preference gate). Never throws on FCM
 * trouble (sendToTokens swallows send errors); callers still wrap in `void ... .catch()` so a
 * DB hiccup here cannot fail the mutation that raised the notification.
 */
export async function pushRetailerAccounts(
  accountIds: string[],
  msg: PushMessage,
): Promise<number> {
  if (accountIds.length === 0) return 0;
  const prefs = await db
    .select({ accountId: notificationPreferences.accountId, pushEnabled: notificationPreferences.pushEnabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.accountKind, 'retailer'),
        inArray(notificationPreferences.accountId, accountIds),
      ),
    );
  const muted = new Set(prefs.filter((p) => !p.pushEnabled).map((p) => p.accountId));
  const targets = accountIds.filter((id) => !muted.has(id));
  if (targets.length === 0) return 0;

  const tokens = await listActiveTokensForRecipients('retailer', targets);
  if (tokens.length === 0) return 0;
  for (let i = 0; i < tokens.length; i += FCM_MULTICAST_LIMIT) {
    const { prune } = await sendToTokens(tokens.slice(i, i + FCM_MULTICAST_LIMIT), msg);
    if (prune.length > 0) await revokeTokens(prune);
  }
  return targets.length;
}
