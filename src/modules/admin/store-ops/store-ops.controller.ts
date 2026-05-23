import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { notificationPreferences, notifications } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { InboxQuery } from './store-ops.validators.js';

type Auth = AccessTokenPayload;

export async function listInbox(input: { auth: Auth; query: z.infer<typeof InboxQuery> }) {
  const { auth, query } = input;
  const { unreadOnly, limit } = query;
  const conditions = [
    eq(notifications.recipientKind, 'admin'),
    eq(notifications.recipientId, auth.sub),
    isNull(notifications.deletedAt),
  ];
  if (unreadOnly) conditions.push(isNull(notifications.readAt));
  const rows = await db.query.notifications.findMany({
    where: and(...conditions),
    orderBy: desc(notifications.createdAt),
    limit,
  });
  return ok(rows);
}

export async function markInboxRead(input: { id: string; auth: Auth }) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, input.id), eq(notifications.recipientId, input.auth.sub)),
    );
  return ok({ id: input.id, readAt: new Date() });
}

export async function markAllRead(input: { auth: Auth }) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.recipientKind, 'admin'),
        eq(notifications.recipientId, input.auth.sub),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );
  return ok({ marked: true });
}

export async function getNotificationPrefs(input: { auth: Auth }) {
  const prefs = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.accountKind, 'admin'),
      eq(notificationPreferences.accountId, input.auth.sub),
    ),
  });
  return ok(
    prefs ?? {
      accountKind: 'admin',
      accountId: input.auth.sub,
      pushEnabled: true,
      emailEnabled: true,
      dailyDigestEnabled: false,
      smsEnabled: false,
      language: 'en-IN',
      dashboardTiles: null,
    },
  );
}
