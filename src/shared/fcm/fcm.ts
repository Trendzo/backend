/**
 * Firebase Cloud Messaging sender for driver push. Data-only messages to the
 * `driver-offers` topic wake driver apps to refetch their offers feed — near-instant,
 * without a held long-poll connection. Drivers whose apps can't do FCM (no Play services,
 * denied permission) fall back to the long-poll endpoint, so this is purely additive.
 *
 * Requires a Firebase SERVICE ACCOUNT (not the client google-services.json). Configure via
 * `FIREBASE_SERVICE_ACCOUNT` (the JSON key as a string) or `GOOGLE_APPLICATION_CREDENTIALS`
 * (path to the key file). If neither is set, every send is a no-op and push stays disabled.
 */
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { env } from '@/config/env.js';

const OFFERS_TOPIC = 'driver-offers';

let initTried = false;
let enabled = false;

function init(): void {
  if (initTried) return;
  initTried = true;
  try {
    let credential: Credential;
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      credential = cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT));
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      credential = applicationDefault();
    } else {
      // eslint-disable-next-line no-console
      console.warn('[fcm] no service account configured — driver push disabled (long-poll fallback)');
      return;
    }
    initializeApp({ credential });
    enabled = true;
    // eslint-disable-next-line no-console
    console.log('[fcm] initialized — driver push enabled');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[fcm] init failed — driver push disabled:', (e as Error).message);
  }
}

export function fcmEnabled(): boolean {
  init();
  return enabled;
}

/** Wake all subscribed driver apps to re-query their offers feed. No-op if FCM is off. */
export async function pushOffersChanged(): Promise<void> {
  init();
  if (!enabled) return;
  try {
    await getMessaging().send({
      topic: OFFERS_TOPIC,
      data: { type: 'offers_changed' },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { contentAvailable: true } } },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[fcm] push failed:', (e as Error).message);
  }
}

export type PushMessage = {
  title?: string;
  body?: string;
  data?: Record<string, string>;
};

/**
 * Send a TARGETED notification to specific device tokens (one consumer / one driver).
 * Returns which tokens Firebase reported as permanently invalid so the caller can revoke
 * them. No-op returning empty results when FCM is disabled. All string data values (FCM
 * requires string-valued data).
 */
export async function sendToTokens(
  tokens: string[],
  msg: PushMessage,
): Promise<{ successCount: number; prune: string[] }> {
  init();
  if (!enabled || tokens.length === 0) return { successCount: 0, prune: [] };
  try {
    // Build conditionally — exactOptionalPropertyTypes forbids passing `undefined` fields.
    const notification: { title?: string; body?: string } = {};
    if (msg.title) notification.title = msg.title;
    if (msg.body) notification.body = msg.body;
    const message: MulticastMessage = {
      tokens,
      ...(msg.title || msg.body ? { notification } : {}),
      ...(msg.data ? { data: msg.data } : {}),
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    };
    const res = await getMessaging().sendEachForMulticast(message);
    const prune: string[] = [];
    res.responses.forEach((r, i) => {
      if (
        !r.success &&
        (r.error?.code === 'messaging/registration-token-not-registered' ||
          r.error?.code === 'messaging/invalid-registration-token')
      ) {
        prune.push(tokens[i]!);
      }
    });
    return { successCount: res.successCount, prune };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[fcm] multicast push failed:', (e as Error).message);
    return { successCount: 0, prune: [] };
  }
}
