/**
 * Retailer push (T6): device-token endpoints, the FCM delivery added to notifyStoreAccounts,
 * and the "new order" alert fired when an order is routed to a store.
 *
 * FCM is MOCKED: sendToTokens is replaced so nothing ever touches the network, and no
 * FIREBASE_SERVICE_ACCOUNT is needed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

vi.mock('@/shared/fcm/fcm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/fcm/fcm.js')>();
  return {
    ...actual,
    sendToTokens: vi.fn(async (tokens: string[]) => ({
      successCount: tokens.length,
      prune: [] as string[],
    })),
  };
});

import { db, pool } from '@/db/client.js';
import { deviceTokens, notifications, orders } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import { sendToTokens } from '@/shared/fcm/fcm.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { notifyStoreAccounts } from '@/shared/notify-store.js';
import { dispatchOrder, rerouteOrder } from '@/shared/orders/routing.js';
import { advanceOrderAfterCapture } from '@/shared/payments/settle-gateway.js';
import { notifyStoreOfNewOrder } from '@/shared/orders/notify-new-order.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  bearer,
  makeAccount,
  makeConsumer,
  makeStore,
  makeVariant,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
const sendMock = vi.mocked(sendToTokens);
const data = (res: { body: string }) => JSON.parse(res.body).data;

let app: App;

const register = (token: string, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/retailer/push', headers: bearer(token), payload: payload as object });
const revoke = (token: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/retailer/push/revoke',
    headers: bearer(token),
    payload: payload as object,
  });

/** Register a fresh device token for an account via the real endpoint. */
async function addDevice(accountToken: string): Promise<string> {
  const token = `fcm_${newId('t')}`;
  const res = await register(accountToken, { token, platform: 'android', appVersion: '1.0.0' });
  expect(res.statusCode).toBe(200);
  return token;
}

const inbox = (accountId: string) =>
  db.query.notifications.findMany({ where: eq(notifications.recipientId, accountId) });

/** All token arguments FCM was asked to deliver to, flattened. */
const sentTokens = () => sendMock.mock.calls.flatMap((c) => c[0]);
const settle = () => new Promise((r) => setTimeout(r, 200));

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(() => {
  sendMock.mockClear();
  sendMock.mockImplementation(async (tokens: string[]) => ({
    successCount: tokens.length,
    prune: [] as string[],
  }));
});

describe('POST /retailer/push (register) and /retailer/push/revoke', () => {
  it('401 without a token, 403 for a non-retailer token kind', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/push',
      payload: { token: 'x', platform: 'android' },
    });
    expect(anon.statusCode).toBe(401);

    const consumer = signAccessToken({ sub: 'cns_x', kind: 'consumer' });
    const res = await register(consumer, { token: 'x', platform: 'android' });
    expect(res.statusCode).toBe(403);
  });

  it('422 on a bad body (missing token, unknown platform, empty token)', async () => {
    const storeId = await makeStore();
    const { token } = await makeAccount(storeId, 'owner');
    expect((await register(token, { platform: 'android' })).statusCode).toBe(422);
    expect((await register(token, { token: 'abc', platform: 'windows' })).statusCode).toBe(422);
    expect((await register(token, { token: '', platform: 'ios' })).statusCode).toBe(422);
    expect((await revoke(token, {})).statusCode).toBe(422);
  });

  it('registers against the ACCOUNT id for any sub-role (staff included), no extra gate', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const staff = await makeAccount(storeId, 'staff');

    const ownerTok = await addDevice(owner.token);
    const staffTok = await addDevice(staff.token);

    const rows = await db.query.deviceTokens.findMany({
      where: inArray(deviceTokens.token, [ownerTok, staffTok]),
    });
    const byToken = new Map(rows.map((r) => [r.token, r]));
    expect(byToken.get(ownerTok)).toMatchObject({
      recipientKind: 'retailer',
      recipientId: owner.id,
      platform: 'android',
      appVersion: '1.0.0',
    });
    expect(byToken.get(staffTok)).toMatchObject({ recipientKind: 'retailer', recipientId: staff.id });
  });

  it('re-registering the same token is idempotent and re-points it to the new account', async () => {
    const storeId = await makeStore();
    const a = await makeAccount(storeId, 'owner');
    const b = await makeAccount(storeId, 'staff');
    const token = `fcm_${newId('t')}`;

    const first = await register(a.token, { token, platform: 'android' });
    const again = await register(a.token, { token, platform: 'android', appVersion: '2.0.0' });
    expect(data(again).id).toBe(data(first).id);

    // Same handset, different account signs in: the token now belongs to account b.
    const moved = await register(b.token, { token, platform: 'ios' });
    expect(data(moved).id).toBe(data(first).id);
    const row = await db.query.deviceTokens.findFirst({ where: eq(deviceTokens.token, token) });
    expect(row).toMatchObject({ recipientId: b.id, platform: 'ios', revokedAt: null });
  });

  it('revoke only affects the caller\'s own token', async () => {
    const storeId = await makeStore();
    const a = await makeAccount(storeId, 'owner');
    const b = await makeAccount(storeId, 'manager');
    const tok = await addDevice(a.token);

    // b cannot revoke a's token
    expect(data(await revoke(b.token, { token: tok })).revoked).toBe(true);
    let row = await db.query.deviceTokens.findFirst({ where: eq(deviceTokens.token, tok) });
    expect(row!.revokedAt).toBeNull();

    // a can
    expect(data(await revoke(a.token, { token: tok })).revoked).toBe(true);
    row = await db.query.deviceTokens.findFirst({ where: eq(deviceTokens.token, tok) });
    expect(row!.revokedAt).not.toBeNull();
  });
});

describe('notifyStoreAccounts -> FCM push', () => {
  it('pushes to every eligible account device with the documented payload convention', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const staff = await makeAccount(storeId, 'staff');
    const t1 = await addDevice(owner.token);
    const t2 = await addDevice(staff.token);

    const n = await notifyStoreAccounts({
      storeId,
      kind: 'order',
      title: 'Return pickup scheduled',
      body: 'A driver is on the way',
      deepLink: '/retailer/returns',
      payload: { orderId: 'ord_abc' },
    });
    expect(n).toBe(2);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    const [tokens, msg] = sendMock.mock.calls[0]!;
    expect([...tokens].sort()).toEqual([t1, t2].sort());
    expect(msg).toEqual({
      title: 'Return pickup scheduled',
      body: 'A driver is on the way',
      data: { kind: 'order', deepLink: '/retailer/returns', orderId: 'ord_abc' },
      androidChannelId: 'orders',
    });
    // The inbox rows are written exactly as before.
    expect(await inbox(owner.id)).toHaveLength(1);
    expect(await inbox(staff.id)).toHaveLength(1);
  });

  it('uses the general channel for non-order events and omits absent data keys', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    await addDevice(owner.token);

    await notifyStoreAccounts({ storeId, kind: 'payout', title: 'Payout processed' });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0]![1]).toEqual({
      title: 'Payout processed',
      data: { kind: 'payout' },
      androidChannelId: 'general',
    });
  });

  it('honours notification-prefs pushEnabled=false (inbox row still written)', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const staff = await makeAccount(storeId, 'staff');
    const ownerTok = await addDevice(owner.token);
    const staffTok = await addDevice(staff.token);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/retailer/notification-prefs',
      headers: bearer(staff.token),
      payload: { pushEnabled: false },
    });
    expect(put.statusCode).toBe(200);

    await notifyStoreAccounts({ storeId, kind: 'kyc', title: 'KYC update' });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sentTokens()).toEqual([ownerTok]);
    expect(sentTokens()).not.toContain(staffTok);
    expect(await inbox(staff.id)).toHaveLength(1);
  });

  it('does not push to a terminated (revoked) account but still writes its inbox row', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const revoked = await makeAccount(storeId, 'staff', 'terminated');
    const ownerTok = await addDevice(owner.token);
    // Terminated accounts are read-only, so seed the stale token the way an earlier session left it.
    await db.insert(deviceTokens).values({
      id: newId(IdPrefix.DeviceToken),
      recipientKind: 'retailer',
      recipientId: revoked.id,
      token: 'stale_terminated_token',
      platform: 'android',
    });

    await notifyStoreAccounts({ storeId, kind: 'order', title: 'New thing' });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sentTokens()).toEqual([ownerTok]);
    expect(await inbox(revoked.id)).toHaveLength(1);
  });

  it('never fails the caller when FCM throws', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    await addDevice(owner.token);
    sendMock.mockRejectedValueOnce(new Error('fcm unavailable'));

    const n = await notifyStoreAccounts({ storeId, kind: 'system', title: 'Hello' });
    expect(n).toBe(1);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await settle(); // let the swallowed rejection run its handler
    expect(await inbox(owner.id)).toHaveLength(1);
  });

  it('is a clean no-op for accounts with no registered device', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    expect(await notifyStoreAccounts({ storeId, kind: 'system', title: 'No devices' })).toBe(1);
    await settle();
    expect(sendMock).not.toHaveBeenCalled();
    expect(await inbox(owner.id)).toHaveLength(1);
  });

  it('revokes tokens FCM reports as dead', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const dead = await addDevice(owner.token);
    sendMock.mockResolvedValueOnce({ successCount: 0, prune: [dead] });

    await notifyStoreAccounts({ storeId, kind: 'system', title: 'Prune me' });
    await vi.waitFor(async () => {
      const row = await db.query.deviceTokens.findFirst({ where: eq(deviceTokens.token, dead) });
      expect(row!.revokedAt).not.toBeNull();
    });
  });

  it('dedupeKey skips accounts already notified (inbox and push) and requirePermission filters', async () => {
    const storeId = await makeStore();
    const owner = await makeAccount(storeId, 'owner');
    const staff = await makeAccount(storeId, 'staff'); // staff lack payouts.view by default
    const ownerTok = await addDevice(owner.token);
    await addDevice(staff.token);

    const p = {
      storeId,
      kind: 'payout' as const,
      title: 'Payout ready',
      requirePermission: 'payouts.view' as const,
      dedupeKey: `test:${storeId}`,
    };
    expect(await notifyStoreAccounts(p)).toBe(1); // owner only
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sentTokens()).toEqual([ownerTok]);

    expect(await notifyStoreAccounts(p)).toBe(0); // replay: nothing new
    await settle();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await inbox(owner.id)).toHaveLength(1);
    expect(await inbox(staff.id)).toHaveLength(0);
  });
});

describe('new-order notification', () => {
  let storeId: string;
  let owner: { id: string; token: string };
  let manager: { id: string; token: string };
  let staff: { id: string; token: string };
  let legacy: { id: string; token: string };
  let tokens: { owner: string; manager: string; staff: string; legacy: string };
  let variantId: string;
  let consumer: { id: string; token: string; addressId: string };

  beforeAll(async () => {
    storeId = await makeStore();
    owner = await makeAccount(storeId, 'owner');
    manager = await makeAccount(storeId, 'manager');
    staff = await makeAccount(storeId, 'staff');
    // 'delivery_agent' is a retired sub-role that resolves deny-all: no orders.view.
    legacy = await makeAccount(storeId, 'delivery_agent');
    tokens = {
      owner: await addDevice(owner.token),
      manager: await addDevice(manager.token),
      staff: await addDevice(staff.token),
      legacy: await addDevice(legacy.token),
    };
    ({ variantId } = await makeVariant(storeId, { stock: 1000, pricePaise: 50_000 }));
    consumer = await makeConsumer('Push Buyer', '+919111100001');
  });

  const newOrderRows = (orderId: string) =>
    db.query.notifications.findMany({
      where: and(
        eq(notifications.recipientKind, 'retailer'),
        inArray(notifications.recipientId, [owner.id, manager.id, staff.id, legacy.id]),
      ),
    }).then((rows) =>
      rows.filter(
        (r) =>
          (r.payload as { orderId?: string; kind?: string } | null)?.orderId === orderId &&
          (r.payload as { kind?: string }).kind === 'order.new',
      ),
    );

  async function place() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/checkout',
      headers: bearer(consumer.token),
      payload: {
        storeId,
        items: [{ variantId, qty: 2 }],
        deliveryMethod: 'standard',
        paymentMethod: 'upi',
        addressId: consumer.addressId,
      },
    });
    expect(res.statusCode).toBe(200);
    return data(res) as { orderId: string; status: string };
  }

  it('alerts every account holding orders.view when an order is routed, with push', async () => {
    const { orderId, status } = await place();
    expect(status).toBe('routing');

    const rows = await newOrderRows(orderId);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([owner.id, manager.id, staff.id].sort());
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: 'order',
      title: 'New order',
      deepLink: `/retailer/orders/${orderId}`,
    });
    const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    expect(row.body).toMatch(/^2 items · ₹[\d,.]+ · Standard delivery$/);
    expect(row.payload).toMatchObject({
      kind: 'order.new',
      orderId,
      storeId,
      itemCount: 2,
      grandTotalPaise: order!.grandTotalPaise,
      deliveryMethod: 'standard',
    });

    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    const [sent, msg] = sendMock.mock.calls[0]!;
    // owner + manager + staff devices; not the deny-all legacy account (no orders.view)
    expect([...sent].sort()).toEqual([tokens.owner, tokens.manager, tokens.staff].sort());
    expect(msg).toMatchObject({
      title: 'New order',
      data: { kind: 'order.new', deepLink: `/retailer/orders/${orderId}`, orderId },
      androidChannelId: 'orders',
    });
    expect(await inbox(legacy.id)).toHaveLength(0);
  });

  it('is idempotent per (order, store): re-dispatch, sweep re-drive, reroute and reject never re-alert', async () => {
    const { orderId } = await place();
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(await newOrderRows(orderId)).toHaveLength(3);

    await dispatchOrder(orderId); // already dispatched
    await advanceOrderAfterCapture(db, { orderId }); // paid-not-routed sweep / webhook replay
    expect(await notifyStoreOfNewOrder(orderId)).toBe(0); // direct re-notify
    await rerouteOrder(orderId, 'timeout'); // acceptance window lapsed, same store
    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/orders/${orderId}/reject`,
      headers: bearer(owner.token),
      payload: {},
    });
    expect(reject.statusCode).toBe(200);

    await settle();
    expect(await newOrderRows(orderId)).toHaveLength(3);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent dispatches claim the order once and alert once', async () => {
    const { orderId } = await place();
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    // Rewind to "routed but not yet dispatched" and race three dispatchers.
    const historyBefore = (
      (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!.routingHistory as unknown[]
    ).length;
    await db.update(orders).set({ acceptanceDeadlineAt: null }).where(eq(orders.id, orderId));
    await db.delete(notifications).where(inArray(notifications.recipientId, [owner.id, manager.id, staff.id]));
    sendMock.mockClear();

    await Promise.all([dispatchOrder(orderId), dispatchOrder(orderId), dispatchOrder(orderId)]);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(await newOrderRows(orderId)).toHaveLength(3);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const refreshed = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    expect(refreshed!.acceptanceDeadlineAt).not.toBeNull();
    // exactly ONE winner appended its pending entry
    expect((refreshed!.routingHistory as unknown[]).length).toBe(historyBefore + 1);
  });

  it('a re-route to a DIFFERENT store alerts that store exactly once', async () => {
    const { orderId } = await place();
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    const otherStore = await makeStore();
    const otherOwner = await makeAccount(otherStore, 'owner');
    const otherTok = await addDevice(otherOwner.token);
    await db.update(orders).set({ storeId: otherStore }).where(eq(orders.id, orderId));
    sendMock.mockClear();

    expect(await notifyStoreOfNewOrder(orderId)).toBe(1);
    expect(await notifyStoreOfNewOrder(orderId)).toBe(0);
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sentTokens()).toEqual([otherTok]);
    // the original store is not re-alerted
    expect(await newOrderRows(orderId)).toHaveLength(3);
  });
});
