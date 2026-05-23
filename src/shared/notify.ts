import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  notificationPreferences,
  notifications,
  pushAttempts,
  pushSubscriptions,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type NotificationKind =
  | 'order'
  | 'refund'
  | 'payout'
  | 'kyc'
  | 'system'
  | 'issue'
  | 'compliance'
  | 'promotion';

export interface NotifyParams {
  recipientKind: 'admin' | 'retailer' | 'consumer';
  recipientId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function notify(params: NotifyParams): Promise<void> {
  const notificationId = newId('ntf');
  await db.insert(notifications).values({
    id: notificationId,
    recipientKind: params.recipientKind,
    recipientId: params.recipientId,
    kind: params.kind,
    channel: 'inbox',
    title: params.title,
    body: params.body ?? null,
    deepLink: params.deepLink ?? null,
    payload: params.payload ?? null,
  });
  await dispatchPush(notificationId, params).catch(() => {
    // Push dispatch never blocks the primary inbox write.
  });
}

/**
 * Fan-out a notification to every active push_subscription for the recipient.
 * Currently records dispatch attempts (web-push wire integration deferred).
 * Honors notificationPreferences.pushEnabled (consumer prefs not yet stored — defaults on).
 */
export async function dispatchPush(
  notificationId: string,
  params: NotifyParams,
): Promise<void> {
  // Preference gate (skip if user disabled push).
  if (params.recipientKind === 'admin' || params.recipientKind === 'retailer') {
    const pref = await db.query.notificationPreferences.findFirst({
      where: and(
        eq(notificationPreferences.accountKind, params.recipientKind),
        eq(notificationPreferences.accountId, params.recipientId),
      ),
      columns: { pushEnabled: true },
    });
    if (pref && !pref.pushEnabled) {
      const subs = await db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.recipientKind, params.recipientKind),
            eq(pushSubscriptions.recipientId, params.recipientId),
            isNull(pushSubscriptions.revokedAt),
          ),
        );
      for (const s of subs) {
        await db.insert(pushAttempts).values({
          id: newId(IdPrefix.PushAttempt),
          notificationId,
          subscriptionId: s.id,
          status: 'skipped_disabled',
        });
      }
      return;
    }
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.recipientKind, params.recipientKind),
        eq(pushSubscriptions.recipientId, params.recipientId),
        isNull(pushSubscriptions.revokedAt),
      ),
    );
  for (const s of subs) {
    // TODO: actual web-push send via VAPID. Until then, mark sent so end-to-end
    // wiring is verifiable via push_attempts table.
    await db.insert(pushAttempts).values({
      id: newId(IdPrefix.PushAttempt),
      notificationId,
      subscriptionId: s.id,
      status: 'sent',
    });
  }
}

/**
 * Write one summary notification to every owner-row on a store. Used after an
 * admin bulk action so the retailer inbox gets a single row like
 * "Admin retired 23 listings" instead of N rows.
 */
import { db as _db } from '@/db/client.js';
import { retailerAccounts } from '@/db/schema/index.js';

export interface NotifySummaryParams {
  storeId: string;
  action: string;
  count: number;
  deepLink?: string | null;
  sampleIds?: string[];
}

export async function notifySummaryToStoreOwners(p: NotifySummaryParams): Promise<void> {
  const owners = await _db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, p.storeId),
  });
  await Promise.all(
    owners.map((o) =>
      notify({
        recipientKind: 'retailer',
        recipientId: o.id,
        kind: 'system',
        title: `Admin ${p.action} ${p.count} item${p.count === 1 ? '' : 's'}`,
        body: p.sampleIds && p.sampleIds.length > 0
          ? `Sample: ${p.sampleIds.slice(0, 3).join(', ')}`
          : null,
        deepLink: p.deepLink ?? null,
        payload: { action: p.action, count: p.count, sample: p.sampleIds ?? [] },
      }),
    ),
  );
}
