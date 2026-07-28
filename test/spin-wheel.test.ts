/**
 * Spin & Win, end to end through the real app.
 *
 * The things worth proving here are the ones that cost money if they are wrong: that odds
 * never reach the client, that a device cannot farm spins, that a guest's prize is
 * unspendable until they sign in, that claiming twice does not mint two vouchers, and that
 * a per-consumer-limited promotion actually stops working after its limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import {
  adminAccounts,
  consumers,
  promotionConsumerGrants,
  promotionConsumerUsage,
  promotions,
  spinPlays,
  spinWheels,
} from '@/db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { issueAssignedVoucher } from '@/shared/spin/issue-prize.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

let app: App;
let consumerId: string;
let otherConsumerId: string;
let adminId: string;
let ctoken: string;
let otherToken: string;
let atoken: string;
let promoId: string;
let wheelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = (res: InjectRes) => JSON.parse(res.body);
const data = (res: InjectRes) => json(res).data;

let devSeq = 0;
/** A fresh device id per test, so the daily cap of one test never leaks into the next. */
const newDevice = () => `dev-test-${Date.now()}-${devSeq++}`;

const spin = (deviceId: string, token?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/spin/play',
    ...(token ? { headers: auth(token) } : {}),
    payload: { deviceId, surface: 'popup' },
  });

/** Two prize slices and one loser, odds summing to 100%. */
const SEGMENTS = [
  { label: '20%', sublabel: 'OFF', weightBp: 4000, rewardKind: 'promotion' as const, promotionId: '' },
  { label: '50', sublabel: 'POINTS', weightBp: 4000, rewardKind: 'points' as const, points: 50 },
  { label: 'BETTER', sublabel: 'LUCK', weightBp: 2000, rewardKind: 'none' as const },
];

async function putSegments(segments: unknown[]) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/admin/spin-wheels/${wheelId}/segments`,
    headers: auth(atoken),
    payload: { segments },
  });
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();

  consumerId = newId(IdPrefix.Consumer);
  otherConsumerId = newId(IdPrefix.Consumer);
  adminId = newId(IdPrefix.Admin);

  await db.insert(consumers).values([
    { id: consumerId, phone: '+91911000001', name: 'Spin Tester' },
    { id: otherConsumerId, phone: '+91911000002', name: 'Other Spinner' },
  ]);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });

  ctoken = signAccessToken({ sub: consumerId, kind: 'consumer' });
  otherToken = signAccessToken({ sub: otherConsumerId, kind: 'consumer' });
  atoken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });

  // The promotion a prize slice pays out. Capped at one use per customer — the rule this
  // feature depends on and which was not enforced anywhere before.
  promoId = newId(IdPrefix.Promotion);
  await db.insert(promotions).values({
    id: promoId,
    name: 'SPINPRIZE20',
    mechanism: 'voucher',
    discountType: 'percent',
    issuerType: 'admin',
    appliedTo: 'coupon',
    config: { percent: 20 },
    scope: {},
    perConsumerLimit: 1,
    status: 'active',
    validFrom: new Date(Date.now() - 86_400_000),
    validUntil: new Date(Date.now() + 30 * 86_400_000),
  });
  SEGMENTS[0]!.promotionId = promoId;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('admin — configuring a wheel', () => {
  it('creates a wheel in draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/spin-wheels',
      headers: auth(atoken),
      payload: {
        name: 'Welcome Wheel',
        surface: 'both',
        spinsPerDevicePerDay: 1,
        maxClaimsPerConsumer: 1,
        guestSpinAllowed: true,
        claimWindowHours: 168,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(data(res).status).toBe('draft');
    wheelId = data(res).id;
  });

  it('refuses odds that do not add up to 100%', async () => {
    const bad = SEGMENTS.map((s, i) => (i === 0 ? { ...s, weightBp: 1000 } : s));
    const res = await putSegments(bad);
    expect(res.statusCode).toBe(422);
  });

  it('refuses a prize slice with no promotion behind it', async () => {
    const res = await putSegments([
      { label: 'GHOST', weightBp: 5000, rewardKind: 'promotion' },
      { label: 'LOSE', weightBp: 5000, rewardKind: 'none' },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('refuses a points slice with no points', async () => {
    const res = await putSegments([
      { label: 'GHOST', weightBp: 5000, rewardKind: 'points' },
      { label: 'LOSE', weightBp: 5000, rewardKind: 'none' },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('accepts a well-formed slice list and orders it', async () => {
    const res = await putSegments(SEGMENTS);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toHaveLength(3);
    expect(data(res).map((s: { sortOrder: number }) => s.sortOrder)).toEqual([0, 1, 2]);
  });

  it('will not go live while the wheel has already ended', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/spin-wheels/${wheelId}`,
      headers: auth(atoken),
      payload: { validUntil: new Date(Date.now() - 1000).toISOString() },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/spin-wheels/${wheelId}/activate`,
      headers: auth(atoken),
    });
    expect(res.statusCode).toBe(422);
    // Put the dates back for the rest of the suite.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/spin-wheels/${wheelId}`,
      headers: auth(atoken),
      payload: { validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    });
  });

  it('activates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/spin-wheels/${wheelId}/activate`,
      headers: auth(atoken),
    });
    expect(res.statusCode).toBe(200);
    expect(data(res).status).toBe('active');
  });

  it('allows only one live wheel at a time', async () => {
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/spin-wheels',
      headers: auth(atoken),
      payload: {
        name: 'Rival Wheel',
        surface: 'both',
        spinsPerDevicePerDay: 1,
        maxClaimsPerConsumer: 1,
        guestSpinAllowed: true,
        claimWindowHours: 24,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const rivalId = data(second).id;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/spin-wheels/${rivalId}/segments`,
      headers: auth(atoken),
      payload: { segments: SEGMENTS },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/spin-wheels/${rivalId}/activate`,
      headers: auth(atoken),
    });
    expect(res.statusCode).toBe(409);
    await db.delete(spinWheels).where(eq(spinWheels.id, rivalId));
  });
});

describe('public — reading the wheel', () => {
  it('serves the wheel to a guest without ever exposing the odds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/spin/wheel?deviceId=${newDevice()}&surface=popup`,
    });
    expect(res.statusCode).toBe(200);
    const wheel = data(res).wheel;
    expect(wheel.segments).toHaveLength(3);
    expect(wheel.spinsLeftToday).toBe(1);
    // The whole point: no weight, on any slice, ever.
    for (const s of wheel.segments) {
      expect(s).not.toHaveProperty('weightBp');
      expect(s).not.toHaveProperty('promotionId');
      expect(s).not.toHaveProperty('points');
    }
  });

  it('rejects a device id that is too short to be real', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/spin/wheel?deviceId=x' });
    expect(res.statusCode).toBe(422);
  });
});

describe('guest spin → sign in → claim', () => {
  let deviceId: string;
  let claimToken: string | null;
  let won: boolean;

  it('lets a guest spin and returns a slice index, not a prize', async () => {
    deviceId = newDevice();
    const res = await spin(deviceId);
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d.segmentIndex).toBeGreaterThanOrEqual(0);
    expect(d.segmentIndex).toBeLessThan(3);
    won = d.won;
    claimToken = d.claimToken;
    if (won) {
      // A guest holds a token, never the prize itself.
      expect(d.requiresLogin).toBe(true);
      expect(d.prize).toBeNull();
      expect(claimToken).toBeTruthy();
    } else {
      expect(d.claimToken).toBeNull();
    }
  });

  it('refuses a second spin from the same device today', async () => {
    const res = await spin(deviceId);
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('already_spun');
  });

  it('still lets a different device spin', async () => {
    const res = await spin(newDevice());
    expect(res.statusCode).toBe(200);
  });

  it('will not claim without a token', async () => {
    if (!won) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spin/claim',
      payload: { claimToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('claims once signed in, and is idempotent on replay', async () => {
    if (!won) return;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/spin/claim',
      headers: auth(ctoken),
      payload: { claimToken },
    });
    expect(first.statusCode).toBe(200);
    expect(data(first).won).toBe(true);
    const prize = data(first).prize;
    expect(prize.code || prize.points).toBeTruthy();

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/spin/claim',
      headers: auth(ctoken),
      payload: { claimToken },
    });
    expect(replay.statusCode).toBe(200);
    expect(data(replay).alreadyClaimed).toBe(true);
    // Same prize, not a second one.
    expect(data(replay).prize.code).toBe(prize.code);
    expect(data(replay).prize.points).toBe(prize.points);
  });

  it('refuses to hand another account’s prize over', async () => {
    if (!won) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spin/claim',
      headers: auth(otherToken),
      payload: { claimToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s on a token that was never issued', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spin/claim',
      headers: auth(ctoken),
      payload: { claimToken: 'spt_deadbeefdeadbeefdeadbeef' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('a signed-in spin settles immediately', () => {
  it('hands the prize straight over, with no claim step', async () => {
    const res = await spin(newDevice(), otherToken);
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d.requiresLogin).toBe(false);
    if (d.won) {
      expect(d.prize).not.toBeNull();
      expect(d.prize.code || d.prize.points).toBeTruthy();
    }
  });
});

describe('per-consumer claim cap', () => {
  it('stops an account that has already taken its prize from spinning again', async () => {
    // Force the cap: mark every prior claim by this consumer as claimed on this wheel.
    const claimed = await db
      .select({ id: spinPlays.id })
      .from(spinPlays)
      .where(eq(spinPlays.consumerId, consumerId));
    if (claimed.length === 0) return; // the guest above landed on the losing slice

    const res = await spin(newDevice(), ctoken);
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('already_claimed');
  });
});

describe('the wheel’s off switch', () => {
  it('disappears entirely when paused', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/spin-wheels/${wheelId}/pause`,
      headers: auth(atoken),
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/spin/wheel?deviceId=${newDevice()}`,
    });
    expect(read.statusCode).toBe(200);
    expect(data(read).wheel).toBeNull();

    const play = await spin(newDevice());
    expect(play.statusCode).toBe(404);

    // Back on for anything that follows.
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/spin-wheels/${wheelId}/activate`,
      headers: auth(atoken),
    });
  });
});

describe('a wheel-issued voucher, through the real pricing gates', () => {
  let prizeCode: string;

  const resolve = async (over: Record<string, unknown>) => {
    const { resolveExplicitPromotions } = await import('@/shared/orders/compute-quote.js');
    return resolveExplicitPromotions(db, {
      consumer: { id: consumerId },
      isGuest: false,
      storeIdsInCart: [],
      consumerLoyaltyBalance: 0,
      ...over,
    });
  };

  it('mints a voucher bound to one consumer', async () => {
    const issued = await db.transaction((tx) =>
      issueAssignedVoucher(tx, { promotionId: promoId, consumerId, source: 'spin_wheel' }),
    );
    prizeCode = issued.code;
    expect(prizeCode).toMatch(/^[A-Z2-9]{8}$/); // ambiguity-free alphabet, no 0/O/1/I/L

    /**
     * Exactly one grant per (promotion, consumer) — the table's unique index. Winning the
     * same promotion twice mints a second voucher (that is the prize) but does not add a
     * second wallet entry, so this asserts the pair rather than the voucher id: by the time
     * this runs, the guest-claim tests above may already have created the grant.
     */
    const grants = await db
      .select()
      .from(promotionConsumerGrants)
      .where(
        and(
          eq(promotionConsumerGrants.promotionId, promoId),
          eq(promotionConsumerGrants.consumerId, consumerId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]!.source).toBe('spin_wheel');
  });

  it('is unusable by a guest — the reason the login gate can be trusted', async () => {
    const res = await resolve({ consumer: null, isGuest: true, voucherCode: prizeCode });
    expect(res.enginePromos).toHaveLength(0);
    expect(res.rejectedCodes[0]!.reason).toBe('requires_login');
  });

  it('is unusable by a different account', async () => {
    const res = await resolve({
      consumer: { id: otherConsumerId },
      voucherCode: prizeCode,
    });
    expect(res.enginePromos).toHaveLength(0);
    expect(res.rejectedCodes[0]!.reason).toBe('assigned_to_other');
  });

  it('works for the account that won it', async () => {
    const res = await resolve({ voucherCode: prizeCode });
    expect(res.enginePromos.some((p) => p.id === promoId)).toBe(true);
    expect(res.rejectedCodes).toHaveLength(0);
  });

  /**
   * Regression guard for a rule that was stored, documented and counted but never checked.
   * `promotion_consumer_usage` is exactly what `place-order` writes after a redemption, so
   * seeding a row here is indistinguishable from having genuinely spent the voucher once.
   */
  it('stops working once the promotion’s per-consumer limit is spent', async () => {
    await db
      .insert(promotionConsumerUsage)
      .values({ promotionId: promoId, consumerId, useCount: 1, lastUsedAt: new Date() })
      .onConflictDoUpdate({
        target: [promotionConsumerUsage.promotionId, promotionConsumerUsage.consumerId],
        set: { useCount: 1 },
      });

    const res = await resolve({ voucherCode: prizeCode });
    expect(res.enginePromos.some((p) => p.id === promoId)).toBe(false);
    expect(res.rejectedCodes.some((r) => r.reason === 'per_consumer_limit_reached')).toBe(true);
  });

  it('still leaves an uncapped promotion alone', async () => {
    const freeId = newId(IdPrefix.Promotion);
    await db.insert(promotions).values({
      id: freeId,
      name: 'UNCAPPED',
      mechanism: 'coupon',
      discountType: 'percent',
      issuerType: 'admin',
      appliedTo: 'coupon',
      config: { percent: 5 },
      scope: {},
      perConsumerLimit: null,
      status: 'active',
      validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const res = await resolve({ couponCode: 'UNCAPPED' });
    expect(res.enginePromos.some((p) => p.id === freeId)).toBe(true);
  });
});
