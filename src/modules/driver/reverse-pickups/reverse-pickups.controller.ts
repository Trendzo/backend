/**
 * Driver reverse-pickup surface. Same broadcast model as forward offers: every
 * `pending` unassigned task is offered to all active drivers; the first atomic
 * claim wins. Flow: accept → collect at the customer's door (OTP + photos) →
 * deliver-to-store, which starts the returns' verification window (from there the
 * store verifies or the lifecycle sweep auto-accepts + refunds) and pays the
 * driver the reverse_pickup leg.
 *
 * Pool mutations fire the SAME offers bus as forward offers, so the app's single
 * long-poll/FCM wake covers both feeds.
 */
import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '@/config/env.js';
import { db } from '@/db/client.js';
import {
  deliveryAgents,
  platformConfig,
  returns,
  reversePickupRejections,
  reversePickups,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { notifyOffersChanged } from '@/shared/orders/offers-bus.js';
import { recordDriverEarnings } from '@/shared/orders/driver-earnings.js';
import { notifyConsumer } from '@/shared/notify-consumer.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { CollectBody } from './reverse-pickups.validators.js';

type Auth = AccessTokenPayload;

/** Resolve the calling driver, asserting the standalone account is active. */
async function getDriverId(auth: Auth): Promise<string> {
  const driver = await db.query.deliveryAgents.findFirst({
    where: eq(deliveryAgents.id, auth.sub),
    columns: { id: true, status: true },
  });
  if (!driver) throw AppError.unauthorized('Driver account not found');
  if (driver.status !== 'active') {
    throw new AppError(403, ErrorCode.DriverInactive, `Account is ${driver.status}`);
  }
  return driver.id;
}

// QA test backdoor: '1111' is accepted as the collect OTP so QA can run the flow
// without the real code. Gated to non-production — in production the real crypto
// collect OTP is the ONLY accepted value (same policy as deliveries).
const TEST_COLLECT_OTP = '1111';
const ALLOW_TEST_OTP = env.NODE_ENV !== 'production';
function otpOk(taskOtp: string, submitted: string | undefined): boolean {
  if (submitted === taskOtp) return true;
  return ALLOW_TEST_OTP && submitted === TEST_COLLECT_OTP;
}

const taskShape = {
  columns: {
    id: true,
    orderId: true,
    returnIds: true,
    status: true,
    addressLine1: true,
    addressLine2: true,
    addressCity: true,
    addressPincode: true,
    addressLat: true,
    addressLng: true,
    itemsLabel: true,
    collectedPhotos: true,
    createdAt: true,
    assignedAt: true,
    collectedAt: true,
    deliveredAt: true,
  },
  with: {
    order: {
      columns: {
        consumerNameSnap: true,
        consumerPhoneSnap: true,
        storeNameSnap: true,
        storeAddressSnap: true,
      },
      with: { store: { columns: { lat: true, lng: true, contactPhone: true } } },
    },
  },
} as const;

/** Tasks assigned to me that are still in motion. */
export async function listMine(input: { auth: Auth }) {
  const driverId = await getDriverId(input.auth);
  const rows = await db.query.reversePickups.findMany({
    where: and(
      eq(reversePickups.assignedDriverId, driverId),
      inArray(reversePickups.status, ['assigned', 'collected']),
    ),
    orderBy: asc(reversePickups.createdAt),
    ...taskShape,
  });
  return ok(rows);
}

/** Broadcast pool: pending + unassigned + not dismissed by this driver. */
export async function listOffers(input: { auth: Auth }) {
  const driverId = await getDriverId(input.auth);
  const rejected = await db
    .select({ reversePickupId: reversePickupRejections.reversePickupId })
    .from(reversePickupRejections)
    .where(eq(reversePickupRejections.driverId, driverId));
  const rejectedIds = rejected.map((r) => r.reversePickupId);
  const conds = [eq(reversePickups.status, 'pending'), isNull(reversePickups.assignedDriverId)];
  if (rejectedIds.length) conds.push(notInArray(reversePickups.id, rejectedIds));
  const rows = await db.query.reversePickups.findMany({
    where: and(...conds),
    orderBy: asc(reversePickups.createdAt),
    limit: 50,
    ...taskShape,
  });
  return ok(rows);
}

/** Claim a task. Atomic — exactly one racing driver wins. */
export async function acceptTask(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  const claimed = await db
    .update(reversePickups)
    .set({ assignedDriverId: driverId, status: 'assigned', assignedAt: new Date() })
    .where(
      and(
        eq(reversePickups.id, input.id),
        eq(reversePickups.status, 'pending'),
        isNull(reversePickups.assignedDriverId),
      ),
    )
    .returning({ id: reversePickups.id });
  if (claimed.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'Task already taken by another driver');
  }
  notifyOffersChanged();
  return ok({ reversePickupId: input.id, accepted: true });
}

/** Dismiss a task from this driver's feed (stays available to everyone else). */
export async function rejectTask(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  await db
    .insert(reversePickupRejections)
    .values({ id: newId(IdPrefix.ReversePickupRejection), driverId, reversePickupId: input.id })
    .onConflictDoNothing({
      target: [reversePickupRejections.driverId, reversePickupRejections.reversePickupId],
    });
  return ok({ reversePickupId: input.id, rejected: true });
}

/** Collected the goods at the customer's door — OTP proof + at least one photo. */
export async function collectTask(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof CollectBody>;
}) {
  const driverId = await getDriverId(input.auth);
  const task = await db.query.reversePickups.findFirst({
    where: eq(reversePickups.id, input.id),
    columns: { id: true, status: true, assignedDriverId: true, collectOtp: true, consumerId: true },
  });
  if (!task || task.assignedDriverId !== driverId) {
    throw new AppError(404, ErrorCode.NotFound, 'Task is not assigned to you');
  }
  if (!otpOk(task.collectOtp, input.body.otp)) {
    throw new AppError(403, ErrorCode.ValidationError, 'Collection OTP missing or incorrect');
  }
  const [flipped] = await db
    .update(reversePickups)
    .set({ status: 'collected', collectedAt: new Date(), collectedPhotos: input.body.photos })
    .where(
      and(
        eq(reversePickups.id, input.id),
        eq(reversePickups.status, 'assigned'),
        eq(reversePickups.assignedDriverId, driverId),
      ),
    )
    .returning({ id: reversePickups.id });
  if (!flipped) {
    throw new AppError(409, ErrorCode.InvalidState, 'Task is not in a collectable state');
  }
  await notifyConsumer({
    consumerId: task.consumerId,
    kind: 'order',
    title: 'Driver collected your return items',
    body: 'They are on their way back to the store.',
  }).catch(() => undefined);
  return ok({ reversePickupId: input.id, status: 'collected' });
}

/**
 * Goods handed to the store. THE critical handoff: starts the returns'
 * verification window (store must verify within `verification_window_hours` or
 * the lifecycle sweep auto-accepts + refunds) and pays the reverse_pickup leg.
 */
export async function deliverToStore(input: { auth: Auth; id: string }) {
  const driverId = await getDriverId(input.auth);
  const task = await db.query.reversePickups.findFirst({
    where: eq(reversePickups.id, input.id),
  });
  if (!task || task.assignedDriverId !== driverId) {
    throw new AppError(404, ErrorCode.NotFound, 'Task is not assigned to you');
  }
  const [flipped] = await db
    .update(reversePickups)
    .set({ status: 'delivered_to_store', deliveredAt: new Date() })
    .where(
      and(
        eq(reversePickups.id, input.id),
        eq(reversePickups.status, 'collected'),
        eq(reversePickups.assignedDriverId, driverId),
      ),
    )
    .returning({ id: reversePickups.id });
  if (!flipped) {
    throw new AppError(409, ErrorCode.InvalidState, 'Task is not in a deliverable state');
  }

  // Start the verification clock on the returns this task carried. Guarded to
  // still-pending + windowless rows: returns decided at the counter meanwhile
  // no-op (the driver still gets paid — the leg happened).
  const cfg = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, 'verification_window_hours'),
  });
  const verHours = cfg && typeof cfg.value === 'number' ? cfg.value : 24;
  const expiresAt = new Date(Date.now() + verHours * 3_600_000);
  if (task.returnIds.length > 0) {
    await db
      .update(returns)
      .set({ verificationWindowExpiresAt: expiresAt })
      .where(
        and(
          inArray(returns.id, task.returnIds),
          eq(returns.storeDecision, 'pending'),
          isNull(returns.verificationWindowExpiresAt),
        ),
      );
  }

  await recordDriverEarnings(db, {
    orderId: task.orderId,
    driverId,
    deliveryMethod: 'reverse_pickup',
    reversePickupId: task.id,
  });

  await notifyStoreAccounts({
    storeId: task.storeId,
    kind: 'order',
    title: `Return arrived — verify within ${verHours}h`,
    body: task.itemsLabel,
    deepLink: '/retailer/returns',
    payload: { reversePickupId: task.id, returnIds: task.returnIds },
  }).catch(() => undefined);
  await notifyConsumer({
    consumerId: task.consumerId,
    kind: 'order',
    title: 'Your return reached the store',
    body: 'The store will verify it shortly; the refund follows acceptance.',
  }).catch(() => undefined);

  return ok({
    reversePickupId: input.id,
    status: 'delivered_to_store',
    verificationWindowExpiresAt: expiresAt,
  });
}
