/**
 * Broadcast dispatch. Every packed, unassigned order is offered to all active drivers
 * (the offers feed). A driver ACCEPTS to claim it (atomic — first driver wins) or REJECTS
 * to dismiss it from their own feed. Accepting mints the store→driver handoff code and
 * leaves the order `packed`; the store then verifies the code at pickup (unchanged flow).
 */
import { and, asc, eq, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { driverOfferRejections, orders } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { generatePickupCode } from '@/shared/orders/pickup-code.js';
import { notifyOffersChanged, waitForOffersChange } from '@/shared/orders/offers-bus.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

type Auth = AccessTokenPayload;

const MAX_LONG_POLL_MS = 30_000;
const DEFAULT_LONG_POLL_MS = 25_000;

/** The driver's current filtered feed: packed + unassigned + not dismissed by them. */
async function queryOffers(driverId: string) {
  const rejected = await db
    .select({ orderId: driverOfferRejections.orderId })
    .from(driverOfferRejections)
    .where(eq(driverOfferRejections.driverId, driverId));
  const rejectedIds = rejected.map((r) => r.orderId);

  const conds = [eq(orders.status, 'packed'), isNull(orders.assignedAgentId)];
  if (rejectedIds.length) conds.push(notInArray(orders.id, rejectedIds));

  return db.query.orders.findMany({
    where: and(...conds),
    orderBy: asc(orders.placedAt),
    limit: 50,
    columns: {
      id: true,
      status: true,
      deliveryMethod: true,
      paymentMethod: true,
      grandTotalPaise: true,
      codCollectedPaise: true,
      storeNameSnap: true,
      storeAddressSnap: true,
      consumerNameSnap: true,
      consumerPhoneSnap: true,
      addressLine1Snap: true,
      addressLine2Snap: true,
      addressCitySnap: true,
      addressPincodeSnap: true,
      addressLatSnap: true,
      addressLngSnap: true,
      doorWindowExpiresAt: true,
      placedAt: true,
      agentHandoffCode: true, // always null here (unassigned); kept for shape parity
    },
    with: {
      store: { columns: { lat: true, lng: true, contactPhone: true } },
      items: {
        columns: {
          id: true,
          listingNameSnap: true,
          attributesLabelSnap: true,
          qty: true,
          listingId: true,
          listingPolicySnap: true,
        },
      },
    },
  });
}

/** Packed, unassigned orders this driver hasn't dismissed — instant snapshot. */
export async function listOffers(input: { auth: Auth }) {
  return ok(await queryOffers(input.auth.sub));
}

/**
 * Long-poll: return immediately if the driver has offers; otherwise park the request until
 * the pool changes (a new packed order, or one leaving the pool) or `wait` ms elapse, then
 * re-query and return. The client re-requests in a tight loop for near-instant delivery.
 */
export async function longPollOffers(input: { auth: Auth; waitMs?: number }) {
  const driverId = input.auth.sub;
  const waitMs = Math.min(Math.max(input.waitMs ?? DEFAULT_LONG_POLL_MS, 1000), MAX_LONG_POLL_MS);
  let rows = await queryOffers(driverId);
  if (rows.length === 0) {
    await waitForOffersChange(waitMs);
    rows = await queryOffers(driverId);
  }
  return ok(rows);
}

/**
 * Claim an offered order. Atomic: the conditional UPDATE only succeeds while the order is
 * still `packed` and unassigned, so exactly one racing driver wins. Mints the handoff code.
 */
export async function acceptOffer(input: { auth: Auth; id: string }) {
  const driverId = input.auth.sub;
  const code = generatePickupCode();
  const claimed = await db
    .update(orders)
    .set({ assignedAgentId: driverId, agentHandoffCode: code, agentAssignedAt: new Date() })
    .where(and(eq(orders.id, input.id), eq(orders.status, 'packed'), isNull(orders.assignedAgentId)))
    .returning({ id: orders.id });
  if (claimed.length === 0) {
    throw new AppError(409, ErrorCode.InvalidState, 'Order already taken by another driver');
  }
  notifyOffersChanged(); // order left the pool — wake other parked drivers to re-query
  return ok({ orderId: input.id, accepted: true });
}

/** Dismiss an offer from this driver's feed (stays available to everyone else). */
export async function rejectOffer(input: { auth: Auth; id: string }) {
  await db
    .insert(driverOfferRejections)
    .values({ id: newId(IdPrefix.DriverOfferRejection), driverId: input.auth.sub, orderId: input.id })
    .onConflictDoNothing({
      target: [driverOfferRejections.driverId, driverOfferRejections.orderId],
    });
  return ok({ orderId: input.id, rejected: true });
}
