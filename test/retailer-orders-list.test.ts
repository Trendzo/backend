/**
 * GET /retailer/orders — offset paging, placedAt range, free-text search and deliveryMethod
 * filter added for the retailer app, on top of the unchanged default behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import { orders } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import {
  bearer,
  makeAccount,
  makeConsumer,
  makeStore,
  makeVariant,
  tokenWithoutSubRole,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
type Consumer = Awaited<ReturnType<typeof makeConsumer>>;
const data = (res: { body: string }) => JSON.parse(res.body).data;

let app: App;
let storeId: string;
let ownerId: string;
let ownerToken: string;
let staffToken: string;
let variantId: string;
let alice: Consumer;
let bob: Consumer;
let A: string; // alice, standard, 2026-09-01
let B: string; // bob,   pickup,   2026-09-10
let C: string; // alice, standard, 2026-09-20

async function place(c: Consumer, deliveryMethod: 'standard' | 'pickup', forStore = storeId, variant = variantId) {
  const isPickup = deliveryMethod === 'pickup';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/consumer/checkout',
    headers: bearer(c.token),
    payload: {
      storeId: forStore,
      items: [{ variantId: variant, qty: 1 }],
      deliveryMethod,
      paymentMethod: 'upi',
      ...(isPickup
        ? {
            pickupSlotId: `slot_${Date.now()}`,
            pickupSlotStart: new Date(Date.now() + 3_600_000).toISOString(),
            pickupSlotEnd: new Date(Date.now() + 7_200_000).toISOString(),
          }
        : { addressId: c.addressId }),
    },
  });
  expect(res.statusCode).toBe(200);
  return data(res).orderId as string;
}

const setPlacedAt = (id: string, iso: string) =>
  db.update(orders).set({ placedAt: new Date(iso) }).where(eq(orders.id, id));

const list = (qs = '', token = ownerToken) =>
  app.inject({ method: 'GET', url: `/api/v1/retailer/orders${qs}`, headers: bearer(token) });
const ids = (res: { body: string }) => (data(res) as Array<{ id: string }>).map((o) => o.id);

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  storeId = await makeStore();
  const owner = await makeAccount(storeId, 'owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  staffToken = (await makeAccount(storeId, 'staff')).token;
  ({ variantId } = await makeVariant(storeId, { stock: 1000 }));
  alice = await makeConsumer('Alice Anand', '+919222200001');
  bob = await makeConsumer('Bob Marley', '+919222200002');

  A = await place(alice, 'standard');
  B = await place(bob, 'pickup');
  C = await place(alice, 'standard');
  await setPlacedAt(A, '2026-09-01T10:00:00.000Z');
  await setPlacedAt(B, '2026-09-10T10:00:00.000Z');
  await setPlacedAt(C, '2026-09-20T10:00:00.000Z');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /retailer/orders — unchanged defaults', () => {
  it('401 anonymous; 403 without orders.view', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/retailer/orders' })).statusCode).toBe(401);
    expect((await list('', tokenWithoutSubRole(ownerId))).statusCode).toBe(403);
  });

  it('floor staff (orders.view) can list', async () => {
    expect((await list('', staffToken)).statusCode).toBe(200);
  });

  it('with no params returns this store\'s active orders oldest-first, same row shape', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([A, B, C]);
    expect(data(res)[0]).toMatchObject({
      id: A,
      status: 'routing',
      consumerName: 'Alice Anand',
      deliveryMethod: 'standard',
      itemCount: 1,
    });
    expect(data(res)[0]).toHaveProperty('hasPendingReturn', false);
  });

  it('tolerates unknown query params', async () => {
    const res = await list('?foo=bar&page=3&sort=desc');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([A, B, C]);
  });

  it('caps limit at 200 (201 is rejected, 200 is fine)', async () => {
    expect((await list('?limit=201')).statusCode).toBe(422);
    expect((await list('?limit=0')).statusCode).toBe(422);
    expect((await list('?limit=200')).statusCode).toBe(200);
  });
});

describe('GET /retailer/orders — offset', () => {
  it('pages through the same ordering without gaps or repeats', async () => {
    expect(ids(await list('?limit=1&offset=0'))).toEqual([A]);
    expect(ids(await list('?limit=1&offset=1'))).toEqual([B]);
    expect(ids(await list('?limit=1&offset=2'))).toEqual([C]);
    expect(ids(await list('?limit=1&offset=3'))).toEqual([]);
    expect(ids(await list('?limit=2&offset=1'))).toEqual([B, C]);
  });

  it('rejects a negative / non-integer offset', async () => {
    expect((await list('?offset=-1')).statusCode).toBe(422);
    expect((await list('?offset=abc')).statusCode).toBe(422);
  });
});

describe('GET /retailer/orders — placedAt range', () => {
  it('from/to accept bare dates (to is end-of-day inclusive)', async () => {
    expect(ids(await list('?from=2026-09-05'))).toEqual([B, C]);
    expect(ids(await list('?to=2026-09-10'))).toEqual([A, B]);
    expect(ids(await list('?from=2026-09-10&to=2026-09-10'))).toEqual([B]);
    expect(ids(await list('?from=2026-10-01'))).toEqual([]);
  });

  it('from/to accept full ISO timestamps (both bounds inclusive)', async () => {
    expect(ids(await list('?from=2026-09-10T10:00:00.000Z'))).toEqual([B, C]);
    expect(ids(await list('?to=2026-09-10T09:59:59.000Z'))).toEqual([A]);
    expect(ids(await list(`?from=${encodeURIComponent('2026-09-10T15:30:00+05:30')}&to=2026-09-10T10:00:00.000Z`))).toEqual([B]);
  });

  it('422 when from is after to or a bound is not a date', async () => {
    expect((await list('?from=2026-09-20&to=2026-09-01')).statusCode).toBe(422);
    expect((await list('?from=yesterday')).statusCode).toBe(422);
    expect((await list('?to=2026-13-45')).statusCode).toBe(422);
  });

  it('blank filter values are treated as not provided', async () => {
    const res = await list('?from=&to=&q=&deliveryMethod=');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([A, B, C]);
  });
});

describe('GET /retailer/orders — deliveryMethod and q', () => {
  it('filters by deliveryMethod; rejects an unknown method', async () => {
    expect(ids(await list('?deliveryMethod=pickup'))).toEqual([B]);
    expect(ids(await list('?deliveryMethod=standard'))).toEqual([A, C]);
    expect(ids(await list('?deliveryMethod=try_and_buy'))).toEqual([]);
    expect((await list('?deliveryMethod=teleport')).statusCode).toBe(422);
  });

  it('q matches an order id prefix, with or without the ord_ tag', async () => {
    expect(ids(await list(`?q=${B.slice(0, 12)}`))).toEqual([B]);
    expect(ids(await list(`?q=${B.slice(4, 12)}`))).toEqual([B]);
    expect(ids(await list(`?q=${B.slice(4, 12).toUpperCase()}`))).toEqual([B]);
    // a suffix is not a prefix
    expect(ids(await list(`?q=${B.slice(-8)}`))).toEqual([]);
  });

  it('q matches consumer name (case-insensitive, contains)', async () => {
    expect(ids(await list('?q=alice'))).toEqual([A, C]);
    expect(ids(await list('?q=MARLEY'))).toEqual([B]);
    expect(ids(await list('?q=nobody'))).toEqual([]);
  });

  it('q matches consumer phone by digits, ignoring spaces and +', async () => {
    expect(ids(await list('?q=9222200002'))).toEqual([B]);
    expect(ids(await list(`?q=${encodeURIComponent('+91 92222 00001')}`))).toEqual([A, C]);
  });

  it('q is matched literally (LIKE wildcards do not widen the search)', async () => {
    expect(ids(await list('?q=%25'))).toEqual([]);
    expect(ids(await list('?q=_'))).toEqual([]);
  });

  it('filters combine, and never leak another store\'s orders', async () => {
    expect(ids(await list('?deliveryMethod=standard&q=alice&from=2026-09-10'))).toEqual([C]);

    const otherStore = await makeStore();
    const { variantId: otherVariant } = await makeVariant(otherStore, { stock: 100 });
    const stranger = await makeConsumer('Zed Stranger', '+919222200009');
    await place(stranger, 'standard', otherStore, otherVariant);
    expect(ids(await list('?q=zed'))).toEqual([]);
    expect(ids(await list('?q=9222200009'))).toEqual([]);
  });
});

describe('GET /retailer/orders — completed orders stay newest-first with paging', () => {
  it('status=delivered pages newest-first', async () => {
    const D = await place(alice, 'standard');
    await setPlacedAt(D, '2026-09-25T10:00:00.000Z');
    await db.update(orders).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(orders.id, C));
    await db.update(orders).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(orders.id, D));

    expect(ids(await list('?status=delivered'))).toEqual([D, C]);
    expect(ids(await list('?status=delivered&limit=1&offset=1'))).toEqual([C]);
  });
});
