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
import { getMessaging } from 'firebase-admin/messaging';
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
