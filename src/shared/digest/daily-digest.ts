/**
 * §22 daily summary digest. Builds a per-account summary of yesterday's activity
 * (unread notifications, new orders, open issues, pending payouts) and writes one
 * row to email_outbox for the worker to send. SMTP integration deferred.
 */
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  adminAccounts,
  customerIssues,
  emailOutbox,
  notificationPreferences,
  notifications,
  orders,
  payouts,
  retailerAccounts,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export interface RetailerDigest {
  retailerId: string;
  storeId: string | null;
  email: string;
  windowStart: string;
  windowEnd: string;
  ordersNew: number;
  ordersDelivered: number;
  openIssues: number;
  pendingPayouts: number;
  pendingPayoutPaise: number;
  unreadNotifications: number;
}

export interface AdminDigest {
  adminId: string;
  email: string;
  windowStart: string;
  windowEnd: string;
  newApplications: number;
  newDisputes: number;
  failedPayouts: number;
  openConsumerFlags: number;
  unreadNotifications: number;
}

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function buildRetailerDigest(retailerId: string): Promise<RetailerDigest | null> {
  const ret = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!ret?.storeId) return null;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - DIGEST_WINDOW_MS);

  const [ordNew, ordDelivered, openIssues, pendingPay, unreadNotifs] = await Promise.all([
    db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.storeId, ret.storeId), gte(orders.placedAt, windowStart)))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.storeId, ret.storeId), gte(orders.deliveredAt, windowStart)))
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(customerIssues)
      .where(
        and(
          eq(customerIssues.storeId, ret.storeId),
          sql`${customerIssues.status} <> 'decided'`,
        ),
      )
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({
        n: count(),
        sumPaise: sql<string>`COALESCE(SUM(${payouts.netPaise}), 0)::bigint`,
      })
      .from(payouts)
      .where(and(eq(payouts.storeId, ret.storeId), eq(payouts.status, 'pending')))
      .then((r) => ({
        n: Number(r[0]?.n ?? 0),
        sumPaise: Number(r[0]?.sumPaise ?? 0),
      })),
    db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientKind, 'retailer'),
          eq(notifications.recipientId, retailerId),
          isNull(notifications.readAt),
        ),
      )
      .then((r) => Number(r[0]?.n ?? 0)),
  ]);

  return {
    retailerId,
    storeId: ret.storeId,
    email: ret.email,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    ordersNew: ordNew,
    ordersDelivered: ordDelivered,
    openIssues,
    pendingPayouts: pendingPay.n,
    pendingPayoutPaise: pendingPay.sumPaise,
    unreadNotifications: unreadNotifs,
  };
}

export async function buildAdminDigest(adminId: string): Promise<AdminDigest | null> {
  const ad = await db.query.adminAccounts.findFirst({
    where: eq(adminAccounts.id, adminId),
  });
  if (!ad) return null;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - DIGEST_WINDOW_MS);

  const [unreadNotifs, openIssues, failedPay] = await Promise.all([
    db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientKind, 'admin'),
          eq(notifications.recipientId, adminId),
          isNull(notifications.readAt),
        ),
      )
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(customerIssues)
      .where(sql`${customerIssues.status} <> 'decided'`)
      .then((r) => Number(r[0]?.n ?? 0)),
    db
      .select({ n: count() })
      .from(payouts)
      .where(eq(payouts.status, 'failed'))
      .then((r) => Number(r[0]?.n ?? 0)),
  ]);

  return {
    adminId,
    email: ad.email,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    newApplications: 0,
    newDisputes: openIssues,
    failedPayouts: failedPay,
    openConsumerFlags: 0,
    unreadNotifications: unreadNotifs,
  };
}

function renderText(d: RetailerDigest | AdminDigest): string {
  if ('storeId' in d) {
    return [
      `Daily summary — ${d.windowStart.slice(0, 10)}`,
      `New orders: ${d.ordersNew}`,
      `Delivered: ${d.ordersDelivered}`,
      `Open issues: ${d.openIssues}`,
      `Pending payouts: ${d.pendingPayouts} (₹${(d.pendingPayoutPaise / 100).toLocaleString('en-IN')})`,
      `Unread notifications: ${d.unreadNotifications}`,
    ].join('\n');
  }
  return [
    `Daily admin summary — ${d.windowStart.slice(0, 10)}`,
    `New applications: ${d.newApplications}`,
    `Open disputes: ${d.newDisputes}`,
    `Failed payouts: ${d.failedPayouts}`,
    `Open consumer flags: ${d.openConsumerFlags}`,
    `Unread notifications: ${d.unreadNotifications}`,
  ].join('\n');
}

export async function queueRetailerDigest(retailerId: string): Promise<string | null> {
  const digest = await buildRetailerDigest(retailerId);
  if (!digest) return null;
  const pref = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.accountKind, 'retailer'),
      eq(notificationPreferences.accountId, retailerId),
    ),
    columns: { dailyDigestEnabled: true, emailEnabled: true },
  });
  if (!pref || !pref.dailyDigestEnabled || !pref.emailEnabled) return null;
  const id = newId(IdPrefix.EmailOutbox);
  await db.insert(emailOutbox).values({
    id,
    recipientKind: 'retailer',
    recipientId: retailerId,
    toEmail: digest.email,
    subject: `ClosetX daily summary — ${digest.windowStart.slice(0, 10)}`,
    bodyText: renderText(digest),
    kind: 'system',
    payload: digest as unknown as Record<string, unknown>,
  });
  return id;
}

export async function queueAdminDigest(adminId: string): Promise<string | null> {
  const digest = await buildAdminDigest(adminId);
  if (!digest) return null;
  const pref = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.accountKind, 'admin'),
      eq(notificationPreferences.accountId, adminId),
    ),
    columns: { dailyDigestEnabled: true, emailEnabled: true },
  });
  if (!pref || !pref.dailyDigestEnabled || !pref.emailEnabled) return null;
  const id = newId(IdPrefix.EmailOutbox);
  await db.insert(emailOutbox).values({
    id,
    recipientKind: 'admin',
    recipientId: adminId,
    toEmail: digest.email,
    subject: `ClosetX admin daily summary — ${digest.windowStart.slice(0, 10)}`,
    bodyText: renderText(digest),
    kind: 'system',
    payload: digest as unknown as Record<string, unknown>,
  });
  return id;
}

export async function queueAllDigests(): Promise<{ retailer: number; admin: number }> {
  const [rets, adms] = await Promise.all([
    db.select({ id: retailerAccounts.id }).from(retailerAccounts).where(eq(retailerAccounts.status, 'active')),
    db.select({ id: adminAccounts.id }).from(adminAccounts).where(eq(adminAccounts.status, 'active')),
  ]);
  let r = 0;
  let a = 0;
  for (const x of rets) {
    if (await queueRetailerDigest(x.id)) r++;
  }
  for (const x of adms) {
    if (await queueAdminDigest(x.id)) a++;
  }
  return { retailer: r, admin: a };
}
