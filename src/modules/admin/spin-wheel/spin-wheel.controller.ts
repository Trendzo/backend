/**
 * Admin CRUD for Spin & Win wheels.
 *
 * Deliberately narrow: this configures presentation, odds and throttling. It does NOT
 * express discount rules — a prize slice points at an existing promotion, and that
 * promotion's own scope/config carries min order value, first-order-only, per-consumer
 * limit, tier, store scope and validity. Building a second rules engine here would mean two
 * places to change a rule and one of them silently wrong.
 */
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { promotions, spinPlays, spinWheelSegments, spinWheels } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { z } from 'zod';
import type { CreateWheelBody, PatchWheelBody, SegmentsBody } from './spin-wheel.validators.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
}

/** Payout stats per wheel, so the list can show what it has actually cost. */
async function statsFor(wheelIds: string[]) {
  if (wheelIds.length === 0) return new Map<string, { spins: number; claimed: number }>();
  const rows = await db
    .select({
      wheelId: spinPlays.wheelId,
      spins: count(),
      claimed: sql<number>`count(*) filter (where ${spinPlays.status} = 'claimed')::int`,
    })
    .from(spinPlays)
    .where(inArray(spinPlays.wheelId, wheelIds))
    .groupBy(spinPlays.wheelId);
  return new Map(rows.map((r) => [r.wheelId, { spins: Number(r.spins), claimed: r.claimed }]));
}

export async function listWheels() {
  const wheels = await db.query.spinWheels.findMany({
    orderBy: (t, { desc: d }) => [d(t.createdAt)],
    with: { segments: { orderBy: (s, { asc }) => [asc(s.sortOrder)] } },
  });
  const stats = await statsFor(wheels.map((w) => w.id));
  return ok(
    wheels.map((w) => ({
      ...w,
      segmentCount: w.segments.length,
      stats: stats.get(w.id) ?? { spins: 0, claimed: 0 },
    })),
  );
}

export async function getWheel(id: string) {
  const wheel = await db.query.spinWheels.findFirst({
    where: eq(spinWheels.id, id),
    with: {
      segments: {
        orderBy: (s, { asc }) => [asc(s.sortOrder)],
        with: {
          /**
           * The promotion carries the eligibility the admin attached. Sent alongside each
           * slice so the UI can show "min ₹999 · first order only" without the admin
           * having to open another page to remember what they wired up.
           */
          promotion: {
            columns: {
              id: true,
              name: true,
              mechanism: true,
              discountType: true,
              config: true,
              scope: true,
              status: true,
              perConsumerLimit: true,
              validUntil: true,
            },
          },
        },
      },
    },
  });
  if (!wheel) throw AppError.notFound('Wheel not found');
  const stats = await statsFor([wheel.id]);
  return ok({ ...wheel, stats: stats.get(wheel.id) ?? { spins: 0, claimed: 0 } });
}

export async function createWheel(input: { body: z.infer<typeof CreateWheelBody> }) {
  const [row] = await db
    .insert(spinWheels)
    .values({ id: newId(IdPrefix.SpinWheel), status: 'draft', ...input.body })
    .returning();
  return ok(row);
}

export async function patchWheel(input: { id: string; body: z.infer<typeof PatchWheelBody> }) {
  const patch = input.body;
  if (Object.keys(patch).length === 0) throw AppError.validation('Nothing to update');

  const existing = await db.query.spinWheels.findFirst({ where: eq(spinWheels.id, input.id) });
  if (!existing) throw AppError.notFound('Wheel not found');

  const from = patch.validFrom ?? existing.validFrom;
  const until = patch.validUntil ?? existing.validUntil;
  if (until <= from) throw AppError.validation('The end date must be after the start date');

  // Spread each key only when present: `exactOptionalPropertyTypes` treats an explicit
  // `undefined` as a value, and Drizzle's `.set()` would try to write it.
  const [row] = await db
    .update(spinWheels)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.surface !== undefined && { surface: patch.surface }),
      ...(patch.spinsPerDevicePerDay !== undefined && {
        spinsPerDevicePerDay: patch.spinsPerDevicePerDay,
      }),
      ...(patch.maxClaimsPerConsumer !== undefined && {
        maxClaimsPerConsumer: patch.maxClaimsPerConsumer,
      }),
      ...(patch.guestSpinAllowed !== undefined && { guestSpinAllowed: patch.guestSpinAllowed }),
      ...(patch.claimWindowHours !== undefined && { claimWindowHours: patch.claimWindowHours }),
      ...(patch.validFrom !== undefined && { validFrom: patch.validFrom }),
      ...(patch.validUntil !== undefined && { validUntil: patch.validUntil }),
      updatedAt: new Date(),
    })
    .where(eq(spinWheels.id, input.id))
    .returning();
  return ok(row);
}

/**
 * Replace the whole ordered slice list.
 *
 * Rewriting rather than diffing costs us the per-slice `stock_issued` counters, so those are
 * carried across by position for slices that are recognisably the same (same label and
 * reward). Otherwise editing a slice's colour would quietly reset how many jackpots had
 * already been paid out.
 */
export async function replaceSegments(input: { id: string; body: z.infer<typeof SegmentsBody> }) {
  const wheel = await db.query.spinWheels.findFirst({ where: eq(spinWheels.id, input.id) });
  if (!wheel) throw AppError.notFound('Wheel not found');

  const promoIds = input.body.segments
    .map((s) => s.promotionId)
    .filter((x): x is string => Boolean(x));
  if (promoIds.length > 0) {
    const found = await db
      .select({ id: promotions.id })
      .from(promotions)
      .where(inArray(promotions.id, promoIds));
    const known = new Set(found.map((f) => f.id));
    const missing = promoIds.filter((p) => !known.has(p));
    if (missing.length > 0) {
      throw AppError.validation(`Unknown promotion: ${missing.join(', ')}`);
    }
  }

  return db.transaction(async (tx) => {
    const previous = await tx
      .select()
      .from(spinWheelSegments)
      .where(eq(spinWheelSegments.wheelId, input.id));
    const carried = new Map(
      previous.map((p) => [`${p.label}|${p.rewardKind}|${p.promotionId ?? p.points ?? ''}`, p.stockIssued]),
    );

    await tx.delete(spinWheelSegments).where(eq(spinWheelSegments.wheelId, input.id));

    const rows = input.body.segments.map((s, i) => ({
      id: newId(IdPrefix.SpinSegment),
      wheelId: input.id,
      sortOrder: i,
      label: s.label,
      sublabel: s.sublabel ?? null,
      icon: s.icon ?? null,
      colorHex: s.colorHex ?? null,
      weightBp: s.weightBp,
      rewardKind: s.rewardKind,
      promotionId: s.promotionId ?? null,
      points: s.points ?? null,
      stockTotal: s.stockTotal ?? null,
      stockIssued: carried.get(`${s.label}|${s.rewardKind}|${s.promotionId ?? s.points ?? ''}`) ?? 0,
    }));
    const inserted = await tx.insert(spinWheelSegments).values(rows).returning();
    return ok(inserted);
  });
}

/**
 * The enable switch. A partial unique index allows exactly one `active` wheel, so this
 * surfaces a clear instruction instead of a raw constraint error when another is live.
 */
export async function activateWheel(id: string) {
  const wheel = await db.query.spinWheels.findFirst({
    where: eq(spinWheels.id, id),
    with: { segments: true },
  });
  if (!wheel) throw AppError.notFound('Wheel not found');
  if (wheel.segments.length < 2) {
    throw AppError.validation('Add at least two slices before going live');
  }
  const total = wheel.segments.reduce((sum, s) => sum + s.weightBp, 0);
  if (total !== 10_000) {
    throw AppError.validation('Slice odds must add up to exactly 100% before going live');
  }
  if (wheel.validUntil <= new Date()) {
    throw AppError.validation('This wheel has already ended — extend its dates first');
  }

  try {
    const [row] = await db
      .update(spinWheels)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(spinWheels.id, id))
      .returning();
    return ok(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        'Another wheel is already live — pause it first',
      );
    }
    throw e;
  }
}

export async function pauseWheel(id: string) {
  const [row] = await db
    .update(spinWheels)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(spinWheels.id, id))
    .returning();
  if (!row) throw AppError.notFound('Wheel not found');
  return ok(row);
}

export async function archiveWheel(id: string) {
  const [row] = await db
    .update(spinWheels)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(spinWheels.id, id))
    .returning();
  if (!row) throw AppError.notFound('Wheel not found');
  return ok(row);
}

/** Audit trail: who spun, what they landed on, whether they came back to claim it. */
export async function listPlays(input: { id: string; query: { limit: number; offset: number } }) {
  const rows = await db
    .select({
      id: spinPlays.id,
      deviceId: spinPlays.deviceId,
      consumerId: spinPlays.consumerId,
      status: spinPlays.status,
      pointsAwarded: spinPlays.pointsAwarded,
      playedAt: spinPlays.playedAt,
      claimedAt: spinPlays.claimedAt,
      segmentLabel: spinWheelSegments.label,
      rewardKind: spinWheelSegments.rewardKind,
    })
    .from(spinPlays)
    .innerJoin(spinWheelSegments, eq(spinPlays.segmentId, spinWheelSegments.id))
    .where(eq(spinPlays.wheelId, input.id))
    .orderBy(desc(spinPlays.playedAt))
    .limit(input.query.limit)
    .offset(input.query.offset);

  const [totals] = await db
    .select({
      spins: count(),
      claimed: sql<number>`count(*) filter (where ${spinPlays.status} = 'claimed')::int`,
      pending: sql<number>`count(*) filter (where ${spinPlays.status} = 'pending_claim')::int`,
      // Unique devices in the last 24h, so a spike is visible before it becomes a bill.
      devices24h: sql<number>`count(distinct ${spinPlays.deviceId}) filter (where ${spinPlays.playedAt} >= now() - interval '24 hours')::int`,
    })
    .from(spinPlays)
    .where(eq(spinPlays.wheelId, input.id));

  return ok({ plays: rows, totals: totals ?? { spins: 0, claimed: 0, pending: 0, devices24h: 0 } });
}

/** Promotions an admin may reasonably attach to a slice: live or scheduled, still in date. */
export async function listPrizeCandidates() {
  const rows = await db
    .select({
      id: promotions.id,
      name: promotions.name,
      mechanism: promotions.mechanism,
      discountType: promotions.discountType,
      config: promotions.config,
      scope: promotions.scope,
      status: promotions.status,
      perConsumerLimit: promotions.perConsumerLimit,
      validUntil: promotions.validUntil,
    })
    .from(promotions)
    .where(
      and(
        inArray(promotions.status, ['active', 'scheduled']),
        gte(promotions.validUntil, new Date()),
      ),
    )
    .orderBy(desc(promotions.validUntil))
    .limit(200);
  return ok(rows);
}
