/**
 * Targeted OS push to a single recipient (the one consumer whose try-on window opened, or
 * the one assigned driver a return was requested from). Loads the recipient's live device
 * tokens, sends via FCM, and revokes any token Firebase reports as permanently invalid.
 *
 * Fire-and-forget from callers (wrap in `void … .catch()`): push must never block or fail a
 * mutation. A no-op when FCM is unconfigured. This is the DIRECTED layer; the broadcast
 * "new offer" wake still rides the `driver-offers` topic in fcm.ts.
 */
import { sendToTokens, type PushMessage } from '@/shared/fcm/fcm.js';
import { listActiveTokens, revokeTokens } from '@/shared/notifications/device-tokens.js';

async function pushToRecipient(
  kind: 'consumer' | 'delivery_agent',
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
