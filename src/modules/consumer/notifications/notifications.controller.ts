/**
 * Consumer notification inbox.
 *
 * The `notifications` table has stored consumer rows all along — written by
 * shared/notify-consumer.ts with kind, title, body, deep link and read state —
 * and admin and retailer both had list/mark-read endpoints. Consumers had
 * neither, so the app shipped a hardcoded list instead of the real one.
 *
 * Every query is scoped to `recipientKind='consumer'` AND the caller's own id;
 * `recipientId` is never taken from the request.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { notifications } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { ListNotificationsQuery } from './notifications.validators.js';

type Auth = AccessTokenPayload;

/** Soft-deleted rows stay for analytics but must never reach the inbox. */
const mine = (consumerId: string) =>
  and(
    eq(notifications.recipientKind, 'consumer'),
    eq(notifications.recipientId, consumerId),
    isNull(notifications.deletedAt),
  )!;

function shape(n: typeof notifications.$inferSelect) {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    // Where tapping it should take the app.
    deepLink: n.deepLink,
    payload: n.payload ?? null,
    read: n.readAt !== null,
    createdAt: n.createdAt,
  };
}

/** Newest first, cursor-paged on createdAt. Also returns the unread badge count. */
export async function listNotifications(input: {
  auth: Auth;
  query: z.infer<typeof ListNotificationsQuery>;
}) {
  const { auth, query } = input;
  const where = query.before
    ? and(mine(auth.sub), lt(notifications.createdAt, new Date(query.before)))!
    : mine(auth.sub);

  const rows = await db.query.notifications.findMany({
    where,
    orderBy: [desc(notifications.createdAt)],
    limit: query.limit,
  });

  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(mine(auth.sub), isNull(notifications.readAt)));

  return ok({
    items: rows.map(shape),
    // null once the page is short — the client stops paging.
    nextCursor: rows.length === query.limit ? (rows[rows.length - 1]?.createdAt.toISOString() ?? null) : null,
    unreadCount: unread?.n ?? 0,
  });
}

/** Mark one as read. Idempotent; 404s if it is not this consumer's. */
export async function markRead(input: { auth: Auth; id: string }) {
  const row = await db.query.notifications.findFirst({
    where: and(mine(input.auth.sub), eq(notifications.id, input.id)),
    columns: { id: true, readAt: true },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Notification not found');

  if (!row.readAt) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, row.id));
  }
  return ok({ id: row.id, read: true });
}

/** Mark every unread one as read — the "clear badge" action. */
export async function markAllRead(input: { auth: Auth }) {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(mine(input.auth.sub), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return ok({ markedRead: updated.length });
}

/** Soft-delete: the row survives for analytics, the inbox loses it. */
export async function deleteNotification(input: { auth: Auth; id: string }) {
  const row = await db.query.notifications.findFirst({
    where: and(mine(input.auth.sub), eq(notifications.id, input.id)),
    columns: { id: true },
  });
  if (!row) throw new AppError(404, ErrorCode.NotFound, 'Notification not found');
  await db
    .update(notifications)
    .set({ deletedAt: new Date() })
    .where(inArray(notifications.id, [row.id]));
  return ok({ id: row.id, deleted: true });
}
