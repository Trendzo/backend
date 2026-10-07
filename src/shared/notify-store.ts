import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { notifications, retailerAccounts } from '@/db/schema/index.js';
import { notify } from '@/shared/notify.js';
import { isAllowed, type RetailerAction } from '@/shared/permissions.js';
import { pushRetailerAccounts } from '@/shared/push/notify-push.js';

type NotificationKind =
  | 'order'
  | 'refund'
  | 'payout'
  | 'kyc'
  | 'system'
  | 'issue'
  | 'compliance'
  | 'promotion';

export interface NotifyStoreAccountsParams {
  storeId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
  /**
   * Fine-grained event key (e.g. `order.new`). Delivered to clients as the push `data.kind`
   * and stored as `payload.kind` on the inbox row. Falls back to `payload.kind` when that is
   * a string, else to the coarse inbox `kind`.
   */
  eventKind?: string;
  /**
   * Only fan out to accounts whose sub-role is granted this permission (default: every
   * account on the store, which is what every pre-existing caller relies on).
   */
  requirePermission?: RetailerAction;
  /**
   * Idempotency key. Stored on the inbox row (`payload.dedupeKey`); an account that already
   * holds a notification with this key is skipped for BOTH the inbox row and the push, so
   * retries / re-polls never double-notify. Check-then-write: callers that can race should
   * also claim the underlying event atomically (see dispatchOrder).
   */
  dedupeKey?: string;
}

type AccountRow = typeof retailerAccounts.$inferSelect;

/**
 * Native push goes only to accounts that can still use the app: a terminated (revoked) staff
 * member or a deleted account must not keep receiving customer / order details on a phone.
 * The inbox row is still written for every account (unchanged behaviour).
 */
function isPushEligible(a: AccountRow): boolean {
  return (
    a.status !== 'terminated' &&
    a.status !== 'pending_approval' &&
    a.suspendReason !== 'account_deleted_by_user'
  );
}

async function filterByPermission(
  accounts: AccountRow[],
  action: RetailerAction,
): Promise<AccountRow[]> {
  const allowedBySubRole = new Map<string, boolean>();
  for (const subRole of new Set(accounts.map((a) => a.subRole))) {
    allowedBySubRole.set(subRole, await isAllowed('retailer', subRole, action));
  }
  return accounts.filter((a) => allowedBySubRole.get(a.subRole) === true);
}

async function alreadyNotified(accountIds: string[], dedupeKey: string): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .select({ recipientId: notifications.recipientId })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientKind, 'retailer'),
        inArray(notifications.recipientId, accountIds),
        sql`${notifications.payload} ->> 'dedupeKey' = ${dedupeKey}`,
      ),
    );
  return new Set(rows.map((r) => r.recipientId));
}

/**
 * Fan one notification out to every retailer account attached to a store (owner + managers +
 * staff): an inbox row per account, plus a native FCM push to each push-eligible account's
 * registered devices (honouring that account's `push_enabled` preference). Push is
 * fire-and-forget: FCM being unconfigured, down or rejecting a token never fails (or slows)
 * the caller. Returns the number of recipients the inbox row was written for.
 *
 * Push payload convention: notification {title, body}; data {kind, deepLink?, orderId?}
 * (all strings); Android channel `orders` for order events, `general` otherwise.
 */
export async function notifyStoreAccounts(p: NotifyStoreAccountsParams): Promise<number> {
  let accounts = await db.query.retailerAccounts.findMany({
    where: eq(retailerAccounts.storeId, p.storeId),
  });
  if (p.requirePermission) accounts = await filterByPermission(accounts, p.requirePermission);
  if (p.dedupeKey) {
    const done = await alreadyNotified(
      accounts.map((a) => a.id),
      p.dedupeKey,
    );
    accounts = accounts.filter((a) => !done.has(a.id));
  }
  if (accounts.length === 0) return 0;

  const payload: Record<string, unknown> | null =
    p.payload || p.eventKind || p.dedupeKey
      ? {
          ...(p.payload ?? {}),
          ...(p.eventKind ? { kind: p.eventKind } : {}),
          ...(p.dedupeKey ? { dedupeKey: p.dedupeKey } : {}),
        }
      : null;

  await Promise.all(
    accounts.map((a) =>
      notify({
        recipientKind: 'retailer',
        recipientId: a.id,
        kind: p.kind,
        title: p.title,
        body: p.body ?? null,
        deepLink: p.deepLink ?? null,
        payload,
      }),
    ),
  );

  const pushTargets = accounts.filter(isPushEligible).map((a) => a.id);
  if (pushTargets.length > 0) {
    const payloadKind = typeof payload?.kind === 'string' ? payload.kind : undefined;
    const orderId = typeof payload?.orderId === 'string' ? payload.orderId : undefined;
    const data: Record<string, string> = { kind: p.eventKind ?? payloadKind ?? p.kind };
    if (p.deepLink) data.deepLink = p.deepLink;
    if (orderId) data.orderId = orderId;
    void pushRetailerAccounts(pushTargets, {
      title: p.title,
      ...(p.body ? { body: p.body } : {}),
      data,
      androidChannelId: p.kind === 'order' ? 'orders' : 'general',
    }).catch((e: unknown) => {
      console.error('[notify-store] push failed:', (e as Error).message);
    });
  }
  return accounts.length;
}
