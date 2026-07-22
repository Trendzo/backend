import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  bankAccounts,
  kycDocuments,
  kycReverifications,
  notificationPreferences,
  notifications,
  retailerAccounts,
  retailerApplications,
  retailerStores,
  storeHolidayClosures,
  storePickupSlots,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { recordAudit } from '@/shared/audit.js';
import { assertCycleAcceptsUploads, upsertKycDocument } from '@/shared/kyc/upload.js';
import { storeTransition } from '@/shared/lifecycle/transitions.js';
import { isAcceptingOrders, nextStoreOpenAt } from '@/shared/store/order-acceptance.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  HolidayCreateBody,
  InboxQuery,
  NotificationPrefsBody,
  OrderAcceptanceBody,
  PickupSlotCreateBody,
  PickupSlotPatchBody,
  StoreHoursBody,
  StorePauseBody,
  UploadDocBody,
} from './store-ops.validators.js';

type Auth = AccessTokenPayload;

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

export async function getHours(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const raw = store.openingHours ?? {};
  const days = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ] as const;
  const result: Record<string, { from: string; to: string; closed: boolean }> = {};
  for (const day of days) {
    const slots = raw[day];
    if (slots && slots.length > 0) {
      const first = slots[0]!;
      result[day] = { from: first.open, to: first.close, closed: false };
    } else {
      result[day] = { from: '09:00', to: '18:00', closed: true };
    }
  }
  return ok(result);
}

export async function putHours(input: {
  auth: Auth;
  body: z.infer<typeof StoreHoursBody>;
}) {
  const store = await loadStore(input.auth.sub);
  const days = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ] as const;
  const openingHours: Record<string, Array<{ open: string; close: string }>> = {};
  for (const day of days) {
    const d = input.body[day];
    openingHours[day] = d.closed ? [] : [{ open: d.from, close: d.to }];
  }
  await db
    .update(retailerStores)
    .set({ openingHours })
    .where(eq(retailerStores.id, store.id));
  return ok(input.body);
}

export async function getBank(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const bank = await db.query.bankAccounts.findFirst({
    where: and(eq(bankAccounts.storeId, store.id), eq(bankAccounts.isDefault, true)),
  });
  if (!bank) return ok(null);
  return ok({
    accountHolderName: bank.legalName,
    accountNumber: bank.accountNumber,
    ifsc: bank.ifsc,
    bankName: null as string | null,
    pennyDropStatus: bank.verifiedAt ? 'matched' : 'not_attempted',
    pennyDropAt: bank.verifiedAt ? bank.verifiedAt.toISOString() : null,
  });
}

export async function getDocuments(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rev = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.storeId, store.id),
    orderBy: desc(kycReverifications.dueAt),
    with: { documents: true },
  });
  if (rev) {
    return ok(
      rev.documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        label: d.kind.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        status: d.status,
        uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
        fileUrl: d.url ?? null,
      })),
    );
  }
  // Fall back to original application documents
  const application = await db.query.retailerApplications.findFirst({
    where: eq(retailerApplications.provisionedRetailerAccountId, input.auth.sub),
    with: { documents: true },
  });
  if (!application) return ok([]);
  return ok(
    application.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.kind.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      status: 'verified' as const,
      uploadedAt: d.uploadedAt ? d.uploadedAt.toISOString() : null,
      fileUrl: d.url,
    })),
  );
}

export async function uploadDocument(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof UploadDocBody>;
}) {
  const store = await loadStore(input.auth.sub);
  const rev = await db.query.kycReverifications.findFirst({
    where: eq(kycReverifications.storeId, store.id),
    orderBy: desc(kycReverifications.dueAt),
    with: { documents: { where: eq(kycDocuments.id, input.id) } },
  });
  if (!rev || rev.documents.length === 0) {
    throw new AppError(404, ErrorCode.NotFound, 'Document not found');
  }
  // This path had NO cycle-status guard: a retailer could overwrite a document on an
  // approved/submitted cycle and silently flip a `verified` doc back to pending_review.
  // Same guard as /retailer/kyc/:id/documents — sourced from one place so it can't drift.
  assertCycleAcceptsUploads(rev.status);
  const doc = rev.documents[0]!;
  const updated = await upsertKycDocument(db, rev.id, doc.kind, input.body.url);
  return ok(updated);
}

export async function listHolidayClosures(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db.query.storeHolidayClosures.findMany({
    where: eq(storeHolidayClosures.storeId, store.id),
    orderBy: (t, { asc }) => [asc(t.date)],
  });
  return ok(rows);
}

export async function createHolidayClosure(input: {
  auth: Auth;
  body: z.infer<typeof HolidayCreateBody>;
}) {
  const store = await loadStore(input.auth.sub);
  await db
    .insert(storeHolidayClosures)
    .values({
      storeId: store.id,
      date: input.body.date,
      reason: input.body.reason ?? null,
      createdByAccountId: input.auth.sub,
    })
    .onConflictDoNothing();
  return ok({ storeId: store.id, date: input.body.date });
}

export async function deleteHolidayClosure(input: { auth: Auth; date: string }) {
  const store = await loadStore(input.auth.sub);
  await db
    .delete(storeHolidayClosures)
    .where(
      and(
        eq(storeHolidayClosures.storeId, store.id),
        eq(storeHolidayClosures.date, input.date),
      ),
    );
  return ok({ deleted: true });
}

export async function pauseStore(input: {
  auth: Auth;
  body: z.infer<typeof StorePauseBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const store = await loadStore(auth.sub);
  const before = { status: store.status };
  await db
    .update(retailerStores)
    .set(
      storeTransition(store.status, 'pause', {
        reason: body.reason ?? null,
        visibility: body.visibility as 'visible' | 'hidden',
        until: body.pauseUntil ? new Date(body.pauseUntil) : null,
      }),
    )
    .where(eq(retailerStores.id, store.id));
  await recordAudit({
    actor: auth,
    action: 'store.pause',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before,
    after: { status: 'paused', visibility: body.visibility },
    requestId,
  });
  return ok({ storeId: store.id, status: 'paused' });
}

export async function resumeStore(input: { auth: Auth; requestId: string }) {
  const { auth, requestId } = input;
  const store = await loadStore(auth.sub);
  // The central machine rejects resuming a non-paused store — including a KYC
  // auto-pause? No: that IS a pause, and the retailer resuming it would dodge the
  // enforcement, so keep the KYC pause admin-lifted only.
  if (store.pauseReason === 'kyc_overdue') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Your store was paused for overdue KYC — it resumes automatically once KYC is approved',
    );
  }
  await db
    .update(retailerStores)
    .set(storeTransition(store.status, 'resume'))
    .where(eq(retailerStores.id, store.id));
  await recordAudit({
    actor: auth,
    action: 'store.resume',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before: { status: 'paused' },
    after: { status: 'active' },
    requestId,
  });
  return ok({ storeId: store.id, status: 'active' });
}

/**
 * Retailer self-serve "accepting orders" state. Distinct from the admin pause:
 * this is the retailer's own online/offline switch. Going offline stops order
 * placement until the store's next opening window (auto-reopen); the retailer
 * can reopen early. `orderPauseUntil` is treated lazily — a past value already
 * means "accepting".
 */
export async function getOrderAcceptance(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const accepting = isAcceptingOrders(store);
  return ok({
    accepting,
    orderPauseUntil: accepting ? null : (store.orderPauseUntil?.toISOString() ?? null),
  });
}

export async function setOrderAcceptance(input: {
  auth: Auth;
  body: z.infer<typeof OrderAcceptanceBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const store = await loadStore(auth.sub);
  const before = { orderPauseUntil: store.orderPauseUntil?.toISOString() ?? null };

  let orderPauseUntil: Date | null = null;
  if (!body.accepting) {
    const closures = await db.query.storeHolidayClosures.findMany({
      where: eq(storeHolidayClosures.storeId, store.id),
      columns: { date: true },
    });
    const holidays = new Set(closures.map((c) => c.date));
    orderPauseUntil = nextStoreOpenAt(store.openingHours, holidays, new Date());
  }

  await db
    .update(retailerStores)
    .set({ orderPauseUntil })
    .where(eq(retailerStores.id, store.id));

  await recordAudit({
    actor: auth,
    action: body.accepting ? 'store.orders_resume' : 'store.orders_pause',
    resourceKind: 'retailer_store',
    resourceId: store.id,
    before,
    after: { orderPauseUntil: orderPauseUntil?.toISOString() ?? null },
    requestId,
  });

  return ok({
    accepting: body.accepting,
    orderPauseUntil: orderPauseUntil?.toISOString() ?? null,
  });
}

export async function getNotificationPrefs(input: { auth: Auth }) {
  const prefs = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.accountKind, 'retailer'),
      eq(notificationPreferences.accountId, input.auth.sub),
    ),
  });
  // Return defaults if no row yet
  return ok(
    prefs ?? {
      accountKind: 'retailer',
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

export async function putNotificationPrefs(input: {
  auth: Auth;
  body: z.infer<typeof NotificationPrefsBody>;
}) {
  const { auth, body } = input;
  await db
    .insert(notificationPreferences)
    .values({
      accountKind: 'retailer',
      accountId: auth.sub,
      pushEnabled: body.pushEnabled ?? true,
      emailEnabled: body.emailEnabled ?? true,
      dailyDigestEnabled: body.dailyDigestEnabled ?? false,
      smsEnabled: body.smsEnabled ?? false,
      language: body.language ?? 'en-IN',
      dashboardTiles: body.dashboardTiles ?? null,
    })
    .onConflictDoUpdate({
      target: [notificationPreferences.accountKind, notificationPreferences.accountId],
      set: {
        pushEnabled: body.pushEnabled ?? true,
        emailEnabled: body.emailEnabled ?? true,
        dailyDigestEnabled: body.dailyDigestEnabled ?? false,
        smsEnabled: body.smsEnabled ?? false,
        language: body.language ?? 'en-IN',
        dashboardTiles: body.dashboardTiles ?? null,
        updatedAt: new Date(),
      },
    });

  const prefs = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.accountKind, 'retailer'),
      eq(notificationPreferences.accountId, auth.sub),
    ),
  });
  return ok(prefs);
}

export async function listInbox(input: { auth: Auth; query: z.infer<typeof InboxQuery> }) {
  const { auth, query } = input;
  const { unreadOnly, limit } = query;
  const whereConditions = [
    eq(notifications.recipientKind, 'retailer'),
    eq(notifications.recipientId, auth.sub),
    isNull(notifications.deletedAt),
  ];
  if (unreadOnly) whereConditions.push(isNull(notifications.readAt));

  const rows = await db.query.notifications.findMany({
    where: and(...whereConditions),
    orderBy: [sql`${notifications.readAt} ASC NULLS FIRST`, desc(notifications.createdAt)],
    limit,
  });
  return ok(rows);
}

export async function markInboxRead(input: { auth: Auth; id: string }) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, input.id),
        eq(notifications.recipientId, input.auth.sub),
        isNull(notifications.readAt),
      ),
    );
  return ok({ id: input.id, readAt: new Date() });
}

export async function markAllRead(input: { auth: Auth }) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.recipientKind, 'retailer'),
        eq(notifications.recipientId, input.auth.sub),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );
  return ok({ marked: true });
}

export async function listPickupSlots(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db.query.storePickupSlots.findMany({
    where: eq(storePickupSlots.storeId, store.id),
    orderBy: (t, { asc }) => [asc(t.dayOfWeek), asc(t.startTime)],
  });
  return ok(rows);
}

export async function createPickupSlot(input: {
  auth: Auth;
  body: z.infer<typeof PickupSlotCreateBody>;
  requestId: string;
}) {
  const { auth, body, requestId } = input;
  const store = await loadStore(auth.sub);
  const id = `pups_${Math.random().toString(36).slice(2, 14)}`;
  const [created] = await db
    .insert(storePickupSlots)
    .values({
      id,
      storeId: store.id,
      dayOfWeek: body.dayOfWeek,
      startTime: body.startTime,
      endTime: body.endTime,
      capacity: body.capacity,
    })
    .returning();
  await recordAudit({
    actor: auth,
    action: 'pickup_slot.create',
    resourceKind: 'store_pickup_slot',
    resourceId: id,
    after: { dayOfWeek: body.dayOfWeek, startTime: body.startTime },
    requestId,
  });
  return ok(created);
}

export async function patchPickupSlot(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PickupSlotPatchBody>;
}) {
  const { auth, id, body } = input;
  const store = await loadStore(auth.sub);
  const existing = await db.query.storePickupSlots.findFirst({
    where: and(eq(storePickupSlots.id, id), eq(storePickupSlots.storeId, store.id)),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Slot not found');
  const patch: Record<string, unknown> = {};
  if (body.startTime !== undefined) patch.startTime = body.startTime;
  if (body.endTime !== undefined) patch.endTime = body.endTime;
  if (body.capacity !== undefined) patch.capacity = body.capacity;
  if (body.isActive !== undefined) patch.isActive = body.isActive;
  const [updated] = await db
    .update(storePickupSlots)
    .set(patch)
    .where(eq(storePickupSlots.id, existing.id))
    .returning();
  return ok(updated);
}

export async function deletePickupSlot(input: { auth: Auth; id: string }) {
  const store = await loadStore(input.auth.sub);
  const existing = await db.query.storePickupSlots.findFirst({
    where: and(
      eq(storePickupSlots.id, input.id),
      eq(storePickupSlots.storeId, store.id),
    ),
  });
  if (!existing) throw new AppError(404, ErrorCode.NotFound, 'Slot not found');
  await db.delete(storePickupSlots).where(eq(storePickupSlots.id, existing.id));
  return ok({ id: existing.id, deleted: true });
}

export async function getInboxUnreadCount(input: { auth: Auth }) {
  const rows = await db.query.notifications.findMany({
    where: and(
      eq(notifications.recipientKind, 'retailer'),
      eq(notifications.recipientId, input.auth.sub),
      isNull(notifications.readAt),
      isNull(notifications.deletedAt),
    ),
  });
  return ok({ count: rows.length });
}
